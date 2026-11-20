import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CloudError, isCloudError } from '../../contracts/errors.ts';
import { AUDIO_EXT, IMAGE_EXT, VIDEO_EXT } from '../../../shared/asset-names.ts';
import { MAX_ASSET_BYTES } from '../../../shared/asset-limits.ts';
import { projectChannel } from '../../infra/redis.ts';
import { workspaceBlobKey } from '../../infra/storage.ts';
import {
  isBinaryBuffer,
  normalizeSafeProjectPath,
  type ProjectFileOp,
} from '../../services/project-files-service.ts';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { rewritePathReferencesInText } from '../engine/source-mutations.ts';
import {
  DELETED_VERSION,
  createWriteToken,
  formatVersionFromSha256,
  getMimeType,
  sha256Hex,
} from '../etag.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STRIPPED_PNG_COLOR_CHUNKS = new Set(['cICP', 'iCCP', 'gAMA', 'cHRM', 'sRGB']);

/**
 * Pure in-memory PNG SDR color-tag stripper (removes non-essential color-profile chunks that cause
 * macOS/Chrome gamma mismatches on uploaded PNG assets without invoking native image binaries).
 */
function stripSdrPngColourTags(buffer: Buffer): Buffer {
  if (buffer.byteLength < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return buffer;
  }
  const chunks: Buffer[] = [PNG_SIGNATURE];
  let offset = 8;
  let strippedAny = false;

  while (offset + 12 <= buffer.byteLength) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > buffer.byteLength) return buffer;
    if (STRIPPED_PNG_COLOR_CHUNKS.has(type)) {
      strippedAny = true;
    } else {
      chunks.push(buffer.subarray(offset, chunkEnd));
    }
    offset = chunkEnd;
    if (type === 'IEND') break;
  }

  return strippedAny ? Buffer.concat(chunks) : buffer;
}

async function readUploadBodyText(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed = (await request.json().catch(() => null)) as { content?: unknown } | null;
    if (!parsed || typeof parsed.content !== 'string') {
      throw new CloudError('INVALID_ARGUMENT', 'JSON body must include string field "content".', {
        status: 400,
        applied: false,
      });
    }
    return parsed.content;
  }
  return request.text();
}

async function buildConflictPayload(
  deps: DisklessStudioDeps,
  workspaceId: string,
  error: CloudError,
): Promise<Record<string, unknown>> {
  const details = (error.details ?? {}) as {
    path?: string;
    currentVersion?: string | null;
    currentSha256?: string | null;
    currentBlobScope?: 'workspace' | 'catalog' | null;
    currentIsText?: boolean;
  };
  let currentContent: string | null = null;
  if (details.currentIsText && details.currentSha256 && details.currentBlobScope) {
    currentContent = await deps.files
      .readTextBlob(workspaceId, details.currentBlobScope, details.currentSha256)
      .catch(() => null);
  }
  return {
    error: 'file conflict',
    code: 'VERSION_MISMATCH',
    path: details.path ?? null,
    currentVersion: details.currentVersion ?? null,
    currentContent,
  };
}

export function createStudioFilesRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects/:id/files/* — Read single text file with strong ETag ("sha256:<hex>").
  app.get('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const safePath = normalizeSafeProjectPath(rawPath);
    const optional = c.req.query('optional') === '1' || c.req.query('optional') === 'true';

    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) {
      if (optional) {
        return c.json({
          filename: path.posix.basename(safePath),
          path: safePath,
          content: '',
          version: null,
          missing: true,
        });
      }
      return c.json({ error: 'File not found', path: safePath }, 404);
    }

    const version = formatVersionFromSha256(file.sha256);
    if (!file.isText) {
      return c.json(
        {
          error: 'not a text file',
          why: 'binary',
          path: safePath,
          version,
        },
        415,
      );
    }

    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch && ifNoneMatch.trim() === version) {
      c.header('ETag', version);
      return c.body(null, 304);
    }

    const content = await deps.files.readTextBlob(auth.workspaceId, file.blobScope, file.sha256);
    c.header('ETag', version);
    c.header('Cache-Control', 'no-store');
    return c.json({
      filename: path.posix.basename(safePath),
      path: safePath,
      content,
      version,
      missing: false,
    });
  });

  // PUT /api/projects/:id/files/* — Optimistic-concurrency text write with If-Match / If-None-Match: *.
  app.put('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const safePath = normalizeSafeProjectPath(rawPath, true);
    const ifMatch = c.req.header('if-match');
    const ifNoneMatch = c.req.header('if-none-match');
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));

    if (!ifMatch && !ifNoneMatch) {
      const existing = await deps.files.getFile(auth, projectId, safePath);
      let currentContent: string | null = null;
      if (existing && existing.isText) {
        currentContent = await deps.files
          .readTextBlob(auth.workspaceId, existing.blobScope, existing.sha256)
          .catch(() => null);
      }
      return c.json(
        {
          error: 'precondition required',
          code: 'PRECONDITION_REQUIRED',
          path: safePath,
          currentVersion: existing ? formatVersionFromSha256(existing.sha256) : null,
          currentContent,
        },
        428,
      );
    }

    const content = await readUploadBodyText(c.req.raw);

    try {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [
          {
            op: 'upsert_text',
            path: safePath,
            content,
            stampHfIds: safePath.endsWith('.html') || safePath.endsWith('.htm'),
          },
        ],
        filePreconditions: [
          {
            path: safePath,
            ...(ifMatch ? { ifMatch } : {}),
            ...(ifNoneMatch ? { ifNoneMatch } : {}),
          },
        ],
        source: 'studio',
        summary: `Saved ${safePath}`,
        writeToken,
      });

      const version = committed.versionsByPath[safePath] ?? formatVersionFromSha256(sha256Hex(content));
      c.header('ETag', version);
      return c.json({
        ok: true,
        path: safePath,
        version,
        revision: committed.revision,
        versionId: committed.versionId,
        writeToken: committed.writeToken,
        backupPath: null,
      });
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        return c.json(await buildConflictPayload(deps, auth.workspaceId, error), 409);
      }
      throw error;
    }
  });

  // POST /api/projects/:id/files/* — Create a new text file (409 if already exists).
  app.post('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const safePath = normalizeSafeProjectPath(rawPath, true);
    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const content = await readUploadBodyText(c.req.raw);

    try {
      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [
          {
            op: 'upsert_text',
            path: safePath,
            content,
            stampHfIds: safePath.endsWith('.html') || safePath.endsWith('.htm'),
          },
        ],
        filePreconditions: [{ path: safePath, ifNoneMatch: '*' }],
        source: 'studio',
        summary: `Created ${safePath}`,
        writeToken,
      });

      const version = committed.versionsByPath[safePath] ?? formatVersionFromSha256(sha256Hex(content));
      c.header('ETag', version);
      return c.json(
        {
          ok: true,
          path: safePath,
          version,
          revision: committed.revision,
          writeToken: committed.writeToken,
        },
        201,
      );
    } catch (error) {
      if (isCloudError(error) && error.code === 'VERSION_CONFLICT') {
        return c.json(await buildConflictPayload(deps, auth.workspaceId, error), 409);
      }
      throw error;
    }
  });

  // PATCH /api/projects/:id/files/* — Rename file or folder prefix and rewrite relative references in memory.
  app.patch('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const rawOldPath = extractWildcardPath(c.req.url, '/files/');
    const oldPath = normalizeSafeProjectPath(rawOldPath);
    const body = (await c.req.json().catch(() => null)) as { newPath?: unknown } | null;
    if (!body || typeof body.newPath !== 'string' || !body.newPath.trim()) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain non-empty "newPath".', {
        status: 400,
        applied: false,
      });
    }
    const newPath = normalizeSafeProjectPath(body.newPath, true);
    if (oldPath === 'index.html') {
      throw new CloudError('INVALID_ARGUMENT', 'Cannot rename entry file index.html.', {
        status: 400,
        applied: false,
      });
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const allFiles = virtual.listFiles();

    const matchedFiles = allFiles.filter(
      (f) => f.path === oldPath || f.path.startsWith(`${oldPath}/`),
    );
    if (matchedFiles.length === 0) {
      return c.json({ error: 'File or folder not found', path: oldPath }, 404);
    }

    const ops: ProjectFileOp[] = [];
    const renamePairs: Array<{ from: string; to: string }> = [];

    for (const file of matchedFiles) {
      const targetPath =
        file.path === oldPath ? newPath : normalizeSafeProjectPath(`${newPath}${file.path.slice(oldPath.length)}`, true);
      if (virtual.exists(targetPath) && !matchedFiles.some((m) => m.path === targetPath)) {
        return c.json({ error: 'Target path already exists', path: targetPath }, 409);
      }
      renamePairs.push({ from: file.path, to: targetPath });
      ops.push({ op: 'delete', path: file.path });
      ops.push({
        op: 'upsert_ref',
        path: targetPath,
        blobScope: file.blobScope,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        isText: file.isText,
        metadata: file.metadata,
      });
    }

    // Rewrite relative path references in remaining text files (HTML/CSS/JS/JSON).
    let updatedReferences = 0;
    const movedSourceSet = new Set(matchedFiles.map((f) => f.path));
    for (const file of allFiles) {
      if (!file.isText || movedSourceSet.has(file.path)) continue;
      const original = virtual.readText(file.path);
      if (!original) continue;
      let updated = original;
      for (const pair of renamePairs) {
        const nextText = rewritePathReferencesInText(updated, pair.from, pair.to, false);
        if (nextText !== updated) {
          updated = nextText;
          updatedReferences += 1;
        }
      }
      if (updated !== original) {
        ops.push({ op: 'upsert_text', path: file.path, content: updated });
      }
    }

    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops,
      source: 'studio',
      summary: `Renamed ${oldPath} to ${newPath}`,
      writeToken,
    });

    return c.json({
      ok: true,
      oldPath,
      newPath,
      path: newPath,
      updatedReferences,
      revision: committed.revision,
      writeToken: committed.writeToken,
    });
  });

  // DELETE /api/projects/:id/files/* — Delete file or folder prefix; cleans asset names & emits DELETED_VERSION.
  app.delete('/api/projects/:id/files/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/files/');
    const targetPath = normalizeSafeProjectPath(rawPath);

    if (targetPath === 'index.html') {
      return c.json({ error: 'Cannot delete index.html' }, 400);
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const allFiles = await deps.files.listFiles(auth, projectId);
    const toDelete = allFiles.filter(
      (f) => f.path === targetPath || f.path.startsWith(`${targetPath}/`),
    );

    if (toDelete.length === 0) {
      return c.json({ error: 'File not found', path: targetPath }, 404);
    }

    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops: toDelete.map((f) => ({ op: 'delete' as const, path: f.path })),
      source: 'studio',
      summary: `Deleted ${targetPath}`,
      writeToken,
    });

    await deps.assetNames.cleanupDeletedPaths(
      auth,
      projectId,
      toDelete.map((f) => f.path),
    );

    // Emit explicit deleted-version hint on the project event bus for Studio open editors.
    if (deps.eventBus) {
      void deps.eventBus
        .publish(projectChannel(auth.workspaceId, projectId), {
          type: 'file-change',
          workspaceId: auth.workspaceId,
          projectId,
          revision: committed.revision,
          paths: toDelete.map((f) => f.path),
          version: DELETED_VERSION,
          writeToken: committed.writeToken,
          affectsPreview: committed.affectsPreview,
          affectedCompositions: committed.affectedCompositions,
          ts: Date.now(),
        })
        .catch(() => {});
    }

    return c.json({
      ok: true,
      path: targetPath,
      deletedPaths: toDelete.map((f) => f.path),
      version: DELETED_VERSION,
      revision: committed.revision,
      writeToken: committed.writeToken,
      backupPath: null,
    });
  });

  // POST /api/projects/:id/duplicate-file — Clone a project file into a unique sibling path via CAS ref.
  app.post('/api/projects/:id/duplicate-file', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; targetPath?: unknown } | null;
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      throw new CloudError('INVALID_ARGUMENT', 'Body must contain "path".', { status: 400, applied: false });
    }
    const sourcePath = normalizeSafeProjectPath(body.path);
    const allFiles = await deps.files.listFiles(auth, projectId);
    const existingSet = new Set(allFiles.map((f) => f.path));
    const source = allFiles.find((f) => f.path === sourcePath);
    if (!source) {
      return c.json({ error: 'Source file not found', path: sourcePath }, 404);
    }

    let destination: string;
    if (typeof body.targetPath === 'string' && body.targetPath.trim()) {
      destination = normalizeSafeProjectPath(body.targetPath, true);
      if (existingSet.has(destination)) {
        return c.json({ error: 'Destination path already exists', path: destination }, 409);
      }
    } else {
      const ext = path.posix.extname(sourcePath);
      const stem = ext ? sourcePath.slice(0, -ext.length) : sourcePath;
      let idx = 1;
      destination = `${stem}-copy${ext}`;
      while (existingSet.has(destination)) {
        idx++;
        destination = `${stem}-copy-${idx}${ext}`;
      }
      destination = normalizeSafeProjectPath(destination, true);
    }

    const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));
    const committed = await deps.files.commitChanges(auth, {
      projectId,
      ops: [
        {
          op: 'upsert_ref',
          path: destination,
          blobScope: source.blobScope,
          sha256: source.sha256,
          sizeBytes: source.sizeBytes,
          mimeType: source.mimeType,
          isText: source.isText,
          metadata: source.metadata,
        },
      ],
      source: 'studio',
      summary: `Duplicated ${sourcePath} to ${destination}`,
      writeToken,
    });

    return c.json(
      {
        ok: true,
        sourcePath,
        path: destination,
        version: formatVersionFromSha256(source.sha256),
        revision: committed.revision,
        writeToken: committed.writeToken,
      },
      201,
    );
  });

  // POST /api/projects/:id/upload — Multipart asset upload directly to S3 CAS (zero local disk).
  app.post(
    '/api/projects/:id/upload',
    bodyLimit({
      maxSize: MAX_ASSET_BYTES,
      onError: (c) =>
        c.json({ error: 'Upload exceeds 500 MB (500000000 bytes)', maxBytes: MAX_ASSET_BYTES }, 413),
    }),
    async (c) => {
      const auth = await getAuthContext(c, deps);
      const projectId = c.req.param('id');
      const writeToken = createWriteToken(c.req.header('x-hyperframes-write-token'));

      const form = await c.req.formData();
      const uploadedFile = form.get('file');
      if (!(uploadedFile instanceof File)) {
        throw new CloudError('INVALID_ARGUMENT', 'Multipart form must include a "file" field.', {
          status: 400,
          applied: false,
        });
      }

      const rawDir = typeof form.get('directory') === 'string' ? String(form.get('directory')).trim() : 'assets';
      const rawTarget = typeof form.get('path') === 'string' ? String(form.get('path')).trim() : '';
      const safeFileName = path.posix.basename(uploadedFile.name || 'asset.bin').replace(/[\x00-\x1f/\\]/g, '_');
      const candidatePath = rawTarget || (rawDir ? `${rawDir.replace(/^\/+|\/+$/g, '')}/${safeFileName}` : safeFileName);
      const safePath = normalizeSafeProjectPath(candidatePath, true);

      let data: Buffer = Buffer.from(await uploadedFile.arrayBuffer());
      const mimeType = uploadedFile.type || getMimeType(safePath);
      if (mimeType === 'image/png' || safePath.toLowerCase().endsWith('.png')) {
        data = stripSdrPngColourTags(data);
      }

      const sha256 = sha256Hex(data);
      const isText = !isBinaryBuffer(data) && getMimeType(safePath).startsWith('text/');

      const committed = await deps.files.commitChanges(auth, {
        projectId,
        ops: [
          {
            op: 'upsert_binary',
            path: safePath,
            data,
            mimeType,
          },
        ],
        source: 'studio',
        summary: `Uploaded ${safePath}`,
        writeToken,
      });

      // Enqueue background media-ingest metadata probing / waveform / thumbnail jobs for media uploads.
      if (deps.queues && !isText) {
        const s3Key = workspaceBlobKey(auth.workspaceId, sha256);
        if (VIDEO_EXT.test(safePath) || AUDIO_EXT.test(safePath) || IMAGE_EXT.test(safePath)) {
          void deps.queues
            .enqueueMediaIngest('media_probe', {
              workspaceId: auth.workspaceId,
              blobScope: 'workspace',
              sha256,
              s3Key,
            })
            .catch(() => {});
        }
        if (AUDIO_EXT.test(safePath) || VIDEO_EXT.test(safePath)) {
          void deps.queues
            .enqueueMediaIngest('extract_waveform_peaks', {
              workspaceId: auth.workspaceId,
              blobScope: 'workspace',
              sha256,
              samples: 512,
            })
            .catch(() => {});
        }
        if (IMAGE_EXT.test(safePath) && !safePath.toLowerCase().endsWith('.svg')) {
          void deps.queues
            .enqueueMediaIngest('image_thumbnail', {
              workspaceId: auth.workspaceId,
              blobScope: 'workspace',
              sha256,
              spec: 'grid_320',
              width: 320,
            })
            .catch(() => {});
        }
      }

      return c.json(
        {
          ok: true,
          path: safePath,
          size: data.byteLength,
          mimeType,
          sha256,
          version: formatVersionFromSha256(sha256),
          revision: committed.revision,
          writeToken: committed.writeToken,
        },
        201,
      );
    },
  );

  return app;
}
