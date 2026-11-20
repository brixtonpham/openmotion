import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { STUDIO_MANIFESTS } from '../../shared/project-validation.ts';

/** Strong ETag sentinel used when a file has been deleted. */
export const DELETED_VERSION = '"deleted"';

/** Compute lowercase 64-char SHA-256 hex digest of UTF-8 text or raw bytes. */
export function sha256Hex(content: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Strong ETag matching `@hyperframes/studio-server` and `studio/src/utils/studioFileVersion.ts`:
 * `"sha256:<64-char-lowercase-hex>"` (including surrounding double quotes).
 */
export function fileContentVersion(content: string | Buffer | Uint8Array): string {
  return `"sha256:${sha256Hex(content)}"`;
}

/** Build strong ETag directly from an existing 64-char lowercase SHA-256 hex digest. */
export function formatVersionFromSha256(sha256: string): string {
  return `"sha256:${sha256}"`;
}

/** Extract lowercase 64-char SHA-256 hex from a strong ETag `"sha256:<hex>"`, or null if malformed. */
export function parseSha256FromVersion(etag: string | null | undefined): string | null {
  if (!etag) return null;
  const trimmed = etag.trim();
  const match = /^"sha256:([a-f0-9]{64})"$/.exec(trimmed);
  return match ? match[1] : null;
}

/** Echo caller's `X-Hyperframes-Write-Token` or mint a fresh UUID when absent. */
export function createWriteToken(headerValue?: string | null): string {
  const trimmed = headerValue?.trim();
  if (trimmed && trimmed.length <= 256 && !/[\r\n\x00-\x1f]/.test(trimmed)) {
    return trimmed;
  }
  return randomUUID();
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.vert': 'text/plain; charset=utf-8',
  '.frag': 'text/plain; charset=utf-8',
  '.cube': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

export function getMimeType(filePath: string): string {
  const ext = path.posix.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

const PREVIEW_AFFECTING_EXT = new Set([
  '.html',
  '.htm',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
  '.mp4',
  '.mov',
  '.webm',
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.ttc',
  '.cube',
  '.glsl',
  '.vert',
  '.frag',
]);

const NON_PREVIEW_FILES = new Set(['motion-project.json', 'motion-assets.json', 'LICENSE', 'NOTICE.md']);

export interface PreviewImpact {
  affectsPreview: boolean;
  affectedCompositions: string[];
}

/**
 * Determine whether a set of modified paths affects preview rendering and which compositions are affected.
 * Pure in-memory equivalent of Hyperframes' project-signature / preview-read tracking.
 */
export function computePreviewImpact(paths: readonly string[]): PreviewImpact {
  let affectsPreview = false;
  const compositions = new Set<string>();

  for (const rawPath of paths) {
    const normalized = rawPath.replace(/^\/+/, '');
    if (NON_PREVIEW_FILES.has(normalized)) continue;
    if (STUDIO_MANIFESTS.includes(normalized) || normalized === 'hyperframes.json') {
      affectsPreview = true;
      compositions.add('index.html');
      continue;
    }
    const ext = path.posix.extname(normalized).toLowerCase();
    if (PREVIEW_AFFECTING_EXT.has(ext)) {
      affectsPreview = true;
    }
    if (ext === '.html' || ext === '.htm') {
      compositions.add(normalized);
      if (normalized !== 'index.html') {
        compositions.add('index.html');
      }
    } else if (PREVIEW_AFFECTING_EXT.has(ext)) {
      compositions.add('index.html');
    }
  }

  return {
    affectsPreview,
    affectedCompositions: [...compositions].sort((a, b) => a.localeCompare(b)),
  };
}

/** Standard headers required on every 302 Presigned GET redirect per Spike 1 §6.1 & #11 §4. */
export const PRESIGNED_REDIRECT_HEADERS = {
  'Cache-Control': 'private, max-age=60',
  Vary: 'Origin, Cookie',
} as const;

/** Format RFC 5987 Content-Disposition header for inline or attachment S3 downloads. */
export function buildContentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const safeName = filename.replace(/[/\\\x00-\x1f\x7f]/g, '_') || 'download';
  const asciiFallback = safeName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(safeName).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${kind}; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
