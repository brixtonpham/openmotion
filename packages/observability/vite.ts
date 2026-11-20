import { sentryVitePlugin } from '@sentry/vite-plugin';
import type { PluginOption } from 'vite';

export interface ResolvedSentryViteConfig {
  readonly enabled: boolean;
  readonly upload: boolean;
  readonly deleteSourcemaps: boolean;
  readonly org?: string;
  readonly project?: string;
  readonly authToken?: string;
  readonly url?: string;
  readonly releaseName?: string;
  readonly ignoreErrors: boolean;
}

function trimEnv(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  const normalized = trimEnv(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Resolves whether Vite should enable `@sentry/vite-plugin` for Debug ID injection
 * and/or SourceMap upload. Completely inactive unless explicitly configured.
 */
export function resolveSentryViteConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSentryViteConfig {
  const org = trimEnv(env.SENTRY_ORG);
  const project = trimEnv(env.SENTRY_PROJECT);
  const authToken = trimEnv(env.SENTRY_AUTH_TOKEN);
  const url = trimEnv(env.SENTRY_URL);
  const releaseName = trimEnv(env.SENTRY_RELEASE);
  const debugIdsOnly = parseBoolEnv(env.SENTRY_DEBUG_IDS) === true;

  const upload = Boolean(org && project && authToken);
  const enabled = upload || debugIdsOnly;
  const explicitDelete = parseBoolEnv(env.SENTRY_SOURCEMAPS_DELETE);
  // When uploading during build, remove `.map` files before they reach build output by default.
  // When running Debug-ID-only mode (for external CI upload), keep hidden `.map` files unless opted in.
  const deleteSourcemaps = explicitDelete ?? upload;
  const ignoreErrors = parseBoolEnv(env.SENTRY_SOURCEMAPS_IGNORE_ERRORS) === true;

  return {
    enabled,
    upload,
    deleteSourcemaps,
    ...(org ? { org } : {}),
    ...(project ? { project } : {}),
    ...(authToken ? { authToken } : {}),
    ...(url ? { url } : {}),
    ...(releaseName ? { releaseName } : {}),
    ignoreErrors,
  };
}

/**
 * Computes Vite `build.sourcemap` from `STUDIO_SOURCEMAP` and Sentry upload configuration.
 * - Forces `'hidden'` whenever Sentry sourcemap upload or Debug ID injection is enabled,
 *   so browsers never see `//# sourceMappingURL=` comments pointing at private maps.
 * - Preserves `STUDIO_SOURCEMAP=false` / `'hidden'` / default (`true`) when Sentry build plugin is off.
 */
export function resolveStudioSourcemapOption(
  env: NodeJS.ProcessEnv = process.env,
): boolean | 'hidden' {
  const sentry = resolveSentryViteConfig(env);
  if (sentry.enabled) {
    return 'hidden';
  }

  const raw = trimEnv(env.STUDIO_SOURCEMAP)?.toLowerCase();
  if (raw === 'hidden') return 'hidden';
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/**
 * Returns Vite plugins for Sentry Debug ID injection and optional SourceMap upload.
 * Always sets `telemetry: false` so Sentry's bundler plugin sends no build telemetry.
 */
export function createSentryVitePlugins(
  env: NodeJS.ProcessEnv = process.env,
): PluginOption[] {
  const resolved = resolveSentryViteConfig(env);
  if (!resolved.enabled) return [];

  return [
    sentryVitePlugin({
      org: resolved.org,
      project: resolved.project,
      authToken: resolved.authToken,
      ...(resolved.url ? { url: resolved.url } : {}),
      telemetry: false,
      release: {
        ...(resolved.releaseName ? { name: resolved.releaseName } : {}),
        inject: false,
        create: resolved.upload && Boolean(resolved.releaseName),
      },
      sourcemaps: {
        upload: resolved.upload,
        injectDebugIds: true,
        delete: resolved.deleteSourcemaps,
      },
      ...(resolved.ignoreErrors
        ? {
            errorHandler(err) {
              console.warn('[observability] Sentry sourcemap upload warning:', err.message);
            },
          }
        : {}),
    }),
  ];
}
