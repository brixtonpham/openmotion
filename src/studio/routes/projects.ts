import { Hono } from 'hono';
import { FONT_EXT } from '../../../shared/asset-names.ts';
import type { FontMetadataEntry } from '../../services/asset-names-service.ts';
import {
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { infoInMemory } from '../engine/inspect.ts';
import { formatVersionFromSha256 } from '../etag.ts';
import { listVirtualCompositions } from '../virtual-project-store.ts';

export function createStudioProjectsRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects — List non-trashed workspace projects (virtual descriptors, zero local paths).
  app.get('/api/projects', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const catalog = await deps.workspace.getCatalog(auth);
    return c.json({
      activeId: catalog.activeId,
      projects: catalog.projects.map((p) => ({
        id: p.id,
        title: p.title,
        name: p.title,
        dir: `/virtual/${p.id}`,
        templateId: p.templateId,
        createdAt: p.createdAt,
        openedAt: p.openedAt,
      })),
    });
  });

  // GET /api/projects/:id — Full Studio project payload (virtual files, compositions, fonts, assetNames, info).
  app.get('/api/projects/:id', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const detail = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const fileList = virtual.listFiles();
    const filePaths = fileList.map((f) => f.path);
    const compositions = listVirtualCompositions(fileList);
    const info = infoInMemory(virtual);

    const projectFonts: Array<FontMetadataEntry & { postscriptName?: string }> = [];
    if (deps.fontCatalog) {
      for (const file of fileList) {
        if (!FONT_EXT.test(file.path)) continue;
        try {
          const bin = await deps.files.readBinaryFile(auth, projectId, file.path);
          if (!bin) continue;
          const meta = deps.fontCatalog.inspectBuffer(bin.buffer);
          if (meta) {
            projectFonts.push({ ...meta, path: file.path });
          }
        } catch {
          // Invalid font assets remain listed in files but are skipped from selectable fonts.
        }
      }
    }

    const assetNameInfo = await deps.assetNames.readAssetNames(auth, projectId, {
      paths: filePaths,
      fonts: projectFonts,
    });

    return c.json({
      id: detail.id,
      name: detail.title,
      title: detail.title,
      dir: `/virtual/${detail.id}`,
      revision: detail.revision,
      versionId: detail.currentVersionId,
      versionNumber: detail.currentVersionNumber,
      historySeq: detail.currentHistorySeq,
      files: filePaths,
      compositions,
      fonts: projectFonts,
      assetNames: assetNameInfo.assetNames,
      namingLanguage: assetNameInfo.namingLanguage,
      width: info.width,
      height: info.height,
      fps: info.fps,
      duration: info.duration,
      resolution: info.resolution,
    });
  });

  // GET /api/projects/:id/signature — Canonical project signature / revision for polling & preview invalidation.
  app.get('/api/projects/:id/signature', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const detail = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const fileList = await deps.files.listFiles(auth, projectId, { allowTrashed: true });
    return c.json({
      signature: detail.revision,
      revision: detail.revision,
      versionId: detail.currentVersionId,
      versionNumber: detail.currentVersionNumber,
      fileCount: fileList.length,
    });
  });

  // GET /api/projects/:id/files — Detailed file listing with strong ETags & types.
  app.get('/api/projects/:id/files', async (c) => {
    const auth = await getAuthContext(c, deps, { scope: 'projects:read' });
    const projectId = c.req.param('id');
    const detail = await deps.workspace.getProject(auth, projectId, { allowTrashed: true });
    const fileList = await deps.files.listFiles(auth, projectId, { allowTrashed: true });
    const compositions = listVirtualCompositions(fileList);
    const assetNameInfo = await deps.assetNames.readAssetNames(auth, projectId, {
      paths: fileList.map((f) => f.path),
    });

    return c.json({
      dir: `/virtual/${detail.id}`,
      revision: detail.revision,
      compositions,
      assetNames: assetNameInfo.assetNames,
      files: fileList.map((f) => ({
        path: f.path,
        size: f.sizeBytes,
        type: f.mimeType,
        isText: f.isText,
        version: formatVersionFromSha256(f.sha256),
        modifiedAt: f.updatedAt.toISOString(),
        metadata: f.metadata ?? null,
      })),
    });
  });

  return app;
}
