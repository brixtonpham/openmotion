import * as Sentry from '@sentry/react';
import type { ErrorInfo } from 'react';
import {
  readBrowserObservabilityConfig,
  type BrowserObservabilityConfig,
} from './config.ts';
import {
  sanitizeSentryBreadcrumb,
  sanitizeSentryEvent,
  sanitizeText,
  shouldDropBrowserEvent,
  type SentryLikeBreadcrumb,
  type SentryLikeEvent,
  type SentryLikeEventHint,
} from './sanitize.ts';

const MAX_ERROR_EVENTS_PER_SESSION = 50;
const DEFAULT_TRACE_PROPAGATION_TARGETS: ReadonlyArray<string | RegExp> = [
  /^\/(?:api|motion-api)\//,
];

export interface SentryBrowserSdkLike {
  init: typeof Sentry.init;
  browserTracingIntegration: typeof Sentry.browserTracingIntegration;
  captureException: typeof Sentry.captureException;
  captureReactException: typeof Sentry.captureReactException;
  reactErrorHandler: typeof Sentry.reactErrorHandler;
  setUser: typeof Sentry.setUser;
  setTag: typeof Sentry.setTag;
  setContext: typeof Sentry.setContext;
  addBreadcrumb: typeof Sentry.addBreadcrumb;
  flush: typeof Sentry.flush;
  metrics: typeof Sentry.metrics;
}

export interface InitBrowserObservabilityOptions {
  readonly config?: BrowserObservabilityConfig | null;
  readonly sdk?: SentryBrowserSdkLike;
}

export interface ObservabilityContextPatch {
  readonly userId?: string | null;
  readonly workspaceId?: string | null;
  readonly workspaceRole?: string | null;
  readonly projectId?: string | null;
  readonly sessionId?: string | null;
  readonly page?: string | null;
  readonly authMode?: string | null;
}

export interface CaptureExceptionContext {
  readonly area?: string;
  readonly tags?: Record<string, string>;
  readonly extra?: Record<string, unknown>;
}

export interface PerformanceMetricOptions {
  readonly unit?: 'millisecond' | 'second' | 'none' | 'ratio';
  readonly attributes?: Record<string, string | number | boolean>;
}

let activeSdk: SentryBrowserSdkLike | null = null;
let activeConfig: BrowserObservabilityConfig | null = null;
let initialized = false;
let sentErrorEvents = 0;

function extractOrigin(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTracePropagationTargets(
  config: BrowserObservabilityConfig,
): Array<string | RegExp> {
  if (config.tracePropagationTargets && config.tracePropagationTargets.length > 0) {
    return [...config.tracePropagationTargets];
  }
  const targets: Array<string | RegExp> = [...DEFAULT_TRACE_PROPAGATION_TARGETS];
  if (typeof window !== 'undefined' && window.location?.origin) {
    targets.push(new RegExp(`^${escapeRegExp(window.location.origin)}/(?:api|motion-api)/`));
  }
  return targets;
}

function buildDenyUrls(previewOrigin: string | null | undefined): Array<string | RegExp> {
  const deny: Array<string | RegExp> = [/^(?:chrome|moz|safari|safari-web)-extension:\/\//i];
  if (previewOrigin) {
    deny.push(new RegExp(`^${escapeRegExp(previewOrigin)}(?:/|$)`, 'i'));
  }
  return deny;
}

function isEmbeddedPresentation(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('embed') === '1';
  } catch {
    return false;
  }
}

/**
 * Initializes Web Sentry from runtime-injected config (`window.__OPENMOTION_OBSERVABILITY__`)
 * or an explicitly supplied config object. Safe no-op when unconfigured or already initialized.
 */
export function initBrowserObservability(
  options: InitBrowserObservabilityOptions = {},
): boolean {
  if (initialized) return true;

  const config =
    options.config !== undefined ? options.config : readBrowserObservabilityConfig();
  if (!config) return false;

  const sdk = options.sdk ?? Sentry;
  const sanitizeOptions = {
    previewOrigin: config.previewOrigin ?? null,
    dsnOrigin: extractOrigin(config.dsn),
  };

  try {
    const integrations =
      config.tracesSampleRate > 0
        ? [
            sdk.browserTracingIntegration({
              instrumentPageLoad: true,
              instrumentNavigation: true,
              enableLongTask: true,
              enableLongAnimationFrame: true,
            }),
          ]
        : [];

    sdk.init({
      dsn: config.dsn,
      environment: config.environment,
      ...(config.release ? { release: config.release } : {}),
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      tracesSampleRate: config.tracesSampleRate,
      tracePropagationTargets: resolveTracePropagationTargets(config),
      integrations,
      ignoreErrors: [/ResizeObserver loop/i, /MEDIA_ERR_SRC_NOT_SUPPORTED/i],
      denyUrls: buildDenyUrls(config.previewOrigin),
      beforeSend(event, hint) {
        if (
          shouldDropBrowserEvent(
            event as unknown as SentryLikeEvent,
            hint as SentryLikeEventHint,
            sanitizeOptions,
          )
        ) {
          return null;
        }
        if (sentErrorEvents >= MAX_ERROR_EVENTS_PER_SESSION) {
          return null;
        }
        sentErrorEvents += 1;
        return sanitizeSentryEvent(event as unknown as SentryLikeEvent, sanitizeOptions) as typeof event;
      },
      beforeSendTransaction(event) {
        return sanitizeSentryEvent(event as unknown as SentryLikeEvent, sanitizeOptions) as typeof event;
      },
      beforeBreadcrumb(breadcrumb) {
        return sanitizeSentryBreadcrumb(
          breadcrumb as unknown as SentryLikeBreadcrumb,
          sanitizeOptions,
        ) as typeof breadcrumb | null;
      },
    });

    sdk.setTag('app_surface', 'studio-web');
    sdk.setTag('deployment_mode', config.deploymentMode ?? 'cloud-container');
    if (config.appVersion) sdk.setTag('app_version', config.appVersion);
    sdk.setTag('embedded', isEmbeddedPresentation() ? 'true' : 'false');

    activeSdk = sdk;
    activeConfig = config;
    initialized = true;
    return true;
  } catch {
    return false;
  }
}

export function isBrowserObservabilityEnabled(): boolean {
  return initialized && activeSdk !== null;
}

export function getActiveBrowserObservabilityConfig(): BrowserObservabilityConfig | null {
  return activeConfig;
}

export function captureBrowserException(
  error: unknown,
  context: CaptureExceptionContext = {},
): string | undefined {
  if (!initialized || !activeSdk) return undefined;
  try {
    const tags: Record<string, string> = { ...(context.tags ?? {}) };
    if (context.area) tags.area = context.area;
    return activeSdk.captureException(error, {
      ...(Object.keys(tags).length > 0 ? { tags } : {}),
      ...(context.extra ? { extra: context.extra } : {}),
    });
  } catch {
    return undefined;
  }
}

export function captureReactBoundaryError(
  error: Error,
  info: Pick<ErrorInfo, 'componentStack'>,
  boundaryName = 'StudioErrorBoundary',
): string | undefined {
  if (!initialized || !activeSdk) return undefined;
  try {
    activeSdk.setTag('error_boundary', boundaryName);
    return activeSdk.captureReactException(error, {
      componentStack: info.componentStack ?? undefined,
    });
  } catch {
    return undefined;
  }
}

/**
 * Returns React 19 `createRoot` callbacks for uncaught/recoverable errors.
 * Intentionally omits `onCaughtError` so errors already handled by `StudioErrorBoundary`
 * are reported once via `captureReactBoundaryError`.
 */
export function createReactRootErrorHandlers(): {
  onUncaughtError?: (error: unknown, errorInfo: ErrorInfo) => void;
  onRecoverableError?: (error: unknown, errorInfo: ErrorInfo) => void;
} {
  if (!initialized || !activeSdk) return {};
  return {
    onUncaughtError: activeSdk.reactErrorHandler(),
    onRecoverableError: activeSdk.reactErrorHandler(),
  };
}

/**
 * Updates non-PII contextual tags (never email, display name, or tokens).
 */
export function setObservabilityContext(patch: ObservabilityContextPatch): void {
  if (!initialized || !activeSdk) return;
  try {
    if ('userId' in patch) {
      const id = patch.userId?.trim();
      activeSdk.setUser(id ? { id } : null);
    }
    if ('workspaceId' in patch) {
      activeSdk.setTag('workspace_id', patch.workspaceId?.trim() || undefined);
    }
    if ('workspaceRole' in patch) {
      activeSdk.setTag('workspace_role', patch.workspaceRole?.trim() || undefined);
    }
    if ('projectId' in patch) {
      activeSdk.setTag('project_id', patch.projectId?.trim() || undefined);
    }
    if ('authMode' in patch) {
      activeSdk.setTag('auth_mode', patch.authMode?.trim() || undefined);
    }
    if ('page' in patch) {
      activeSdk.setTag('studio_page', patch.page?.trim() || undefined);
    }
    if ('sessionId' in patch) {
      activeSdk.setContext(
        'studio_session',
        patch.sessionId?.trim() ? { session_id: patch.sessionId.trim() } : null,
      );
    }
  } catch {
    // Observability context updates must never disrupt editor execution.
  }
}

export function recordPerformanceMetric(
  name: string,
  value: number,
  options: PerformanceMetricOptions = {},
): void {
  if (!initialized || !activeSdk || !Number.isFinite(value) || value < 0) return;
  try {
    activeSdk.metrics.distribution(name, value, {
      ...(options.unit ? { unit: options.unit } : {}),
      ...(options.attributes ? { attributes: options.attributes } : {}),
    });
  } catch {
    // Performance measurement must never break the caller.
  }
}

export function addObservabilityBreadcrumb(breadcrumb: {
  readonly category: string;
  readonly message?: string;
  readonly level?: 'info' | 'warning' | 'error';
  readonly data?: Record<string, string | number | boolean>;
}): void {
  if (!initialized || !activeSdk) return;
  try {
    activeSdk.addBreadcrumb({
      category: breadcrumb.category,
      ...(breadcrumb.message ? { message: sanitizeText(breadcrumb.message) } : {}),
      ...(breadcrumb.level ? { level: breadcrumb.level } : {}),
      ...(breadcrumb.data ? { data: breadcrumb.data } : {}),
    });
  } catch {
    // Breadcrumbs are best effort.
  }
}

export async function flushBrowserObservability(timeoutMs = 2000): Promise<boolean> {
  if (!initialized || !activeSdk) return false;
  try {
    return await activeSdk.flush(timeoutMs);
  } catch {
    return false;
  }
}

export function resetBrowserObservabilityForTests(): void {
  activeSdk = null;
  activeConfig = null;
  initialized = false;
  sentErrorEvents = 0;
}
