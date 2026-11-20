import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { CloudError, featureDeferredP2 } from '../../contracts/errors.ts';
import type { SelectionEvent } from '../../contracts/events.ts';
import { projectChannel, selectionChannel } from '../../infra/redis.ts';
import { isUuid } from '../../../shared/project-validation.ts';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import { infoInMemory, timelineInMemory } from '../engine/inspect.ts';
import { lintProjectInMemory } from '../engine/lint-project.ts';
import { getMimeType } from '../etag.ts';

const SAFE_VENDOR_PATH_RE = /^[a-zA-Z0-9._/-]{1,200}$/;

export function createStudioSystemRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();
  const runtimeRoot = deps.runtimeRoot ?? process.cwd();
  const studioVersion = deps.studioVersion ?? '0.9.7';

  // In-memory latest selection mirror (per instance, updated via Redis pub/sub for multi-pod sync).
  const latestSelections = new Map<string, SelectionEvent>();

  let cachedRuntimeJs: string | null = null;
  const vendorCache = new Map<string, { content: Buffer; mimeType: string }>();

  const loadRuntimeJs = async (): Promise<string> => {
    if (cachedRuntimeJs !== null) return cachedRuntimeJs;
    const req = createRequire(path.resolve(runtimeRoot, 'package.json'));
    const corePkgPath = req.resolve('@hyperframes/core/package.json');
    const coreRoot = path.dirname(corePkgPath);
    const candidates = [
      path.join(coreRoot, 'dist/runtime/index.js'),
      path.join(coreRoot, 'dist/runtime.js'),
      path.join(coreRoot, 'dist/browser/runtime.js'),
    ];
    for (const candidate of candidates) {
      try {
        cachedRuntimeJs = await readFile(candidate, 'utf8');
        return cachedRuntimeJs;
      } catch {
        // Try next candidate path.
      }
    }
    cachedRuntimeJs = '/* hyperframes runtime bundle */\n';
    return cachedRuntimeJs;
  };

  const loadVendorAsset = async (subPath: string): Promise<{ content: Buffer; mimeType: string } | null> => {
    const cleaned = subPath.replace(/^\/+/, '');
    if (
      !cleaned ||
      !SAFE_VENDOR_PATH_RE.test(cleaned) ||
      cleaned.includes('..') ||
      cleaned.includes('\\')
    ) {
      return null;
    }
    const cached = vendorCache.get(cleaned);
    if (cached) return cached;

    const req = createRequire(path.resolve(runtimeRoot, 'package.json'));
    try {
      if (cleaned.startsWith('gsap/')) {
        const gsapRoot = path.dirname(req.resolve('gsap/package.json'));
        const fileName = cleaned.slice('gsap/'.length);
        const candidates = [
          path.resolve(gsapRoot, 'dist', fileName),
          path.resolve(gsapRoot, fileName),
        ];
        for (const candidate of candidates) {
          if (!candidate.startsWith(gsapRoot + path.sep)) continue;
          try {
            const content = await readFile(candidate);
            const entry = { content, mimeType: getMimeType(candidate) };
            vendorCache.set(cleaned, entry);
            return entry;
          } catch {
            // Try next candidate.
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  };

  // GET /api/projects/:id/lint — Pure in-memory lintProjectInMemory (reads blobs.metadata, zero ffprobe).
  app.get('/api/projects/:id/lint', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const result = await lintProjectInMemory(virtual);
    return c.json(result);
  });

  // GET /api/projects/:id/info — Pure in-memory project metadata inspection.
  app.get('/api/projects/:id/info', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    return c.json(infoInMemory(virtual));
  });

  // GET /api/projects/:id/timeline — Pure in-memory composition timeline extraction.
  app.get('/api/projects/:id/timeline', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    return c.json(timelineInMemory(virtual));
  });

  // GET /api/projects/:id/selection — Read latest Studio selection state.
  app.get('/api/projects/:id/selection', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const key = `${auth.workspaceId}:${projectId}`;
    const existing = latestSelections.get(key);
    return c.json(
      existing ?? {
        workspaceId: auth.workspaceId,
        projectId,
        elementIds: [],
        ts: 0,
      },
    );
  });

  // POST /api/projects/:id/selection — Publish Studio selection update across instances via RedisEventBus.
  app.post('/api/projects/:id/selection', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      compositionId?: string;
      elementIds?: unknown;
      senderId?: string;
    };

    const elementIds = Array.isArray(body.elementIds)
      ? body.elementIds.filter((id): id is string => typeof id === 'string').slice(0, 500)
      : [];

    const event: SelectionEvent = {
      workspaceId: auth.workspaceId,
      projectId,
      ...(typeof body.compositionId === 'string' ? { compositionId: body.compositionId } : {}),
      elementIds,
      ...(typeof body.senderId === 'string' ? { senderId: body.senderId } : {}),
      ts: Date.now(),
    };

    latestSelections.set(`${auth.workspaceId}:${projectId}`, event);
    if (deps.eventBus && isUuid(projectId)) {
      void deps.eventBus.publish(selectionChannel(auth.workspaceId, projectId), event).catch(() => {});
    }
    return c.json({ ok: true, selection: event });
  });

  // GET /api/events — Cross-instance SSE subscribing to RedisEventBus `om:project:{wid}:{pid}` + `om:selection:{wid}:{pid}`.
  app.get('/api/events', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.query('projectId') ?? '';
    if (!isUuid(projectId)) {
      throw new CloudError('INVALID_ARGUMENT', 'Query parameter "projectId" must be a valid project UUID.', {
        status: 400,
        applied: false,
      });
    }

    // Verify caller owns this project in their tenant workspace before subscribing!
    await deps.workspace.getProject(auth, projectId, { allowTrashed: true });

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: 'connected',
        data: JSON.stringify({ projectId, ts: Date.now() }),
      });

      if (!deps.eventBus) {
        return;
      }

      let closed = false;
      let releaseWait: (() => void) | null = null;
      const waitClosed = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });

      const unsubProject = await deps.eventBus.subscribe(
        projectChannel(auth.workspaceId, projectId),
        (payload) => {
          if (closed || stream.aborted) return;
          const evt = payload as { type?: string };
          const eventName = evt?.type === 'history-changed' ? 'history-changed' : 'file-change';
          void stream
            .writeSSE({
              event: eventName,
              data: JSON.stringify(payload),
            })
            .catch(() => {});
        },
      );

      const unsubSelection = await deps.eventBus.subscribe(
        selectionChannel(auth.workspaceId, projectId),
        (payload) => {
          if (closed || stream.aborted) return;
          const sel = payload as SelectionEvent;
          latestSelections.set(`${auth.workspaceId}:${projectId}`, sel);
          void stream
            .writeSSE({
              event: 'selection',
              data: JSON.stringify(payload),
            })
            .catch(() => {});
        },
      );

      const keepalive = setInterval(() => {
        if (closed || stream.aborted) return;
        void stream.write(': keepalive\n\n').catch(() => {});
      }, 20_000);

      stream.onAbort(() => {
        closed = true;
        releaseWait?.();
      });

      try {
        await waitClosed;
      } finally {
        clearInterval(keepalive);
        await Promise.allSettled([unsubProject(), unsubSelection()]);
      }
    });
  });

  // GET /__hyperframes_config — Studio runtime configuration descriptor.
  app.get('/__hyperframes_config', async (c) => {
    const projectId = c.req.query('projectId');
    return c.json({
      isHyperframes: true,
      version: studioVersion,
      mode: 'cloud-diskless',
      diskless: true,
      multiProject: true,
      projectDir: projectId ? `/virtual/${projectId}` : '/virtual',
    });
  });

  // GET /api/environment/ffmpeg — Reads Redis `om:workers:render:health` heartbeat (never spawns local ffmpeg!).
  app.get('/api/environment/ffmpeg', async (c) => {
    await getAuthContext(c, deps);
    const workers = deps.eventBus
      ? await deps.eventBus.getRenderWorkersHealth(60_000).catch(() => [])
      : [];
    const ffmpegWorkers = workers.filter((w) => w.ffmpeg);
    const available = ffmpegWorkers.length > 0;
    return c.json({
      ok: available,
      available,
      version: available ? 'remote-worker' : null,
      mode: 'remote-worker',
      workers: workers.map((w) => ({
        workerId: w.workerId,
        ffmpeg: w.ffmpeg,
        ffprobe: w.ffprobe,
        chromium: w.chromium,
        concurrency: w.concurrency,
        activeJobs: w.activeJobs,
        updatedAt: w.updatedAt,
      })),
    });
  });

  // GET /api/runtime.js — Serve bundled Hyperframes browser runtime JS.
  app.get('/api/runtime.js', async (c) => {
    const js = await loadRuntimeJs();
    c.header('Content-Type', 'application/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(js, 200);
  });

  // GET /api/vendor/* — Serve read-only GSAP & vendor JS assets from node_modules.
  app.get('/api/vendor/*', async (c) => {
    const subPath = extractWildcardPath(c.req.url, '/api/vendor/');
    const asset = await loadVendorAsset(subPath);
    if (!asset) return c.notFound();
    c.header('Content-Type', asset.mimeType);
    c.header('Cache-Control', 'public, max-age=86400, immutable');
    return c.body(new Uint8Array(asset.content), 200);
  });

  // POST /api/open-in-desktop — Unavailable in cloud container mode.
  app.post('/api/open-in-desktop', async (c) => {
    await getAuthContext(c, deps);
    throw featureDeferredP2('open_in_desktop');
  });

  // GET /api/assets/global — Empty container-safe global asset list (workspace assets live in AssetsService).
  app.get('/api/assets/global', async (c) => {
    await getAuthContext(c, deps);
    return c.json({ assets: [] });
  });

  // GET /api/registry/blocks & POST /api/projects/:id/registry/install
  app.get('/api/registry/blocks', async (c) => {
    await getAuthContext(c, deps);
    return c.json({ blocks: [] });
  });

  app.post('/api/projects/:id/registry/install', async (c) => {
    await getAuthContext(c, deps);
    throw featureDeferredP2('registry_install');
  });

  return app;
}
