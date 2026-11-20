import { Hono } from 'hono';
import {
  extractWildcardPath,
  getAuthContext,
  type DisklessStudioDeps,
  type StudioVariables,
} from '../context.ts';
import {
  buildSubCompositionHtmlInMemory,
  bundlePreviewInMemory,
  previewEtag,
} from '../engine/preview-bundler.ts';
import {
  PRESIGNED_REDIRECT_HEADERS,
  formatVersionFromSha256,
} from '../etag.ts';
import { normalizeSafeProjectPath } from '../../services/project-files-service.ts';

function parseVariablesQuery(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function previewErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Preview Error</title></head>
<body style="margin:0;padding:24px;background:#111827;color:#f9fafb;font-family:system-ui,sans-serif;">
  <h2 style="margin:0 0 8px;font-size:16px;">Preview unavailable</h2>
  <pre style="white-space:pre-wrap;font-size:13px;color:#fca5a5;">${escapeHtml(message)}</pre>
</body>
</html>`;
}

export function createStudioPreviewRoutes(deps: DisklessStudioDeps): Hono<{ Variables: StudioVariables }> {
  const app = new Hono<{ Variables: StudioVariables }>();

  // GET /api/projects/:id/preview — Bundled root composition HTML (pure in-memory, zero local FS).
  app.get('/api/projects/:id/preview', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const capture = c.req.query('capture') === '1' || c.req.query('capture') === 'true';
    const variables = parseVariablesQuery(c.req.query('variables'));
    const baseHref = `/api/projects/${encodeURIComponent(projectId)}/preview/`;

    try {
      const html = await bundlePreviewInMemory(virtual, {
        runtimeUrl: '/api/runtime.js',
        baseHref,
        gsapBaseUrl: '/api/vendor/gsap/',
        capture,
        variables,
        fontCssCache:
          deps.hotTextCache?.getFontCss && deps.hotTextCache?.setFontCss
            ? {
                getFontCss: (hash) => deps.hotTextCache!.getFontCss!(hash),
                setFontCss: (hash, css, ttl) => deps.hotTextCache!.setFontCss!(hash, css, ttl),
              }
            : undefined,
        fetchImpl: deps.fetchImpl,
        skipDeterministicFonts: deps.skipDeterministicFonts,
      });

      if (html === null) {
        return c.json({ error: 'Entry composition index.html not found' }, 404);
      }

      const etag = previewEtag(html);
      if (c.req.header('if-none-match')?.trim() === etag) {
        c.header('ETag', etag);
        return c.body(null, 304);
      }

      c.header('Content-Type', 'text/html; charset=utf-8');
      c.header('ETag', etag);
      c.header('Cache-Control', 'no-store');
      return c.body(html, 200);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Preview bundling failed';
      c.header('Content-Type', 'text/html; charset=utf-8');
      c.header('Cache-Control', 'no-store');
      return c.body(previewErrorHtml(msg), 500);
    }
  });

  // GET /api/projects/:id/preview/comp/* — Standalone sub-composition preview HTML.
  app.get('/api/projects/:id/preview/comp/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const compPath = normalizeSafeProjectPath(extractWildcardPath(c.req.url, '/preview/comp/'));
    const virtual = await deps.files.loadVirtualProject(auth, projectId);
    const capture = c.req.query('capture') === '1' || c.req.query('capture') === 'true';
    const variables = parseVariablesQuery(c.req.query('variables'));
    const baseHref = `/api/projects/${encodeURIComponent(projectId)}/preview/`;

    const html = await buildSubCompositionHtmlInMemory(virtual, compPath, {
      runtimeUrl: '/api/runtime.js',
      baseHref,
      gsapBaseUrl: '/api/vendor/gsap/',
      capture,
      variables,
      fontCssCache:
        deps.hotTextCache?.getFontCss && deps.hotTextCache?.setFontCss
          ? {
              getFontCss: (hash) => deps.hotTextCache!.getFontCss!(hash),
              setFontCss: (hash, css, ttl) => deps.hotTextCache!.setFontCss!(hash, css, ttl),
            }
          : undefined,
      fetchImpl: deps.fetchImpl,
      skipDeterministicFonts: deps.skipDeterministicFonts,
    });

    if (html === null) {
      return c.json({ error: 'Sub-composition not found', path: compPath }, 404);
    }

    const etag = previewEtag(html);
    c.header('Content-Type', 'text/html; charset=utf-8');
    c.header('ETag', etag);
    c.header('Cache-Control', 'no-store');
    return c.body(html, 200);
  });

  // GET & HEAD /api/projects/:id/preview/*
  // Note: Hono v4 dispatches HEAD requests through GET handlers; check `c.req.method === 'HEAD'`
  // explicitly and answer HEAD DIRECTLY from PG metadata — NEVER redirect HEAD to a GET-signed S3 URL!
  app.get('/api/projects/:id/preview/*', async (c) => {
    const auth = await getAuthContext(c, deps);
    const projectId = c.req.param('id');
    const rawPath = extractWildcardPath(c.req.url, '/preview/');
    if (!rawPath) {
      if (c.req.method === 'HEAD') {
        const entry = await deps.files.getFile(auth, projectId, 'index.html');
        if (!entry) return c.body(null, 404);
        c.header('Content-Type', entry.mimeType);
        c.header('Content-Length', String(entry.sizeBytes));
        c.header('ETag', formatVersionFromSha256(entry.sha256));
        c.header('Accept-Ranges', 'bytes');
        return c.body(null, 200);
      }
      return c.redirect(`/api/projects/${encodeURIComponent(projectId)}/preview`, 302);
    }
    const safePath = normalizeSafeProjectPath(rawPath);

    const file = await deps.files.getFile(auth, projectId, safePath);
    if (!file) {
      return c.req.method === 'HEAD'
        ? c.body(null, 404)
        : c.json({ error: 'Preview asset not found', path: safePath }, 404);
    }

    const etag = formatVersionFromSha256(file.sha256);

    if (c.req.method === 'HEAD') {
      c.header('Content-Type', file.mimeType);
      c.header('Content-Length', String(file.sizeBytes));
      c.header('ETag', etag);
      c.header('Accept-Ranges', 'bytes');
      c.header('Cache-Control', PRESIGNED_REDIRECT_HEADERS['Cache-Control']);
      c.header('Vary', PRESIGNED_REDIRECT_HEADERS.Vary);
      return c.body(null, 200);
    }

    if (c.req.header('if-none-match')?.trim() === etag) {
      c.header('ETag', etag);
      return c.body(null, 304);
    }

    if (file.isText) {
      const content = await deps.files.readTextBlob(auth.workspaceId, file.blobScope, file.sha256);
      c.header('Content-Type', file.mimeType);
      c.header('Content-Length', String(Buffer.byteLength(content, 'utf8')));
      c.header('ETag', etag);
      c.header('Cache-Control', 'no-cache');
      return c.body(content, 200);
    }

    const presigned = await deps.files.presignFileGet(auth, projectId, safePath, {
      expiresInSec: 300,
      responseContentType: file.mimeType,
    });
    if (!presigned) {
      return c.json({ error: 'Preview asset not found', path: safePath }, 404);
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: presigned.url,
        ETag: etag,
        ...PRESIGNED_REDIRECT_HEADERS,
      },
    });
  });

  return app;
}
