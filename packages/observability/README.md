# `@openmotion/observability`

Dedicated observability package for OpenMotion cloud deployments, intentionally decoupled from `@openmotion/tracking` (`tracking/`).

- `@openmotion/tracking` remains a zero-dependency, closed-schema product analytics package.
- `@openmotion/observability` owns engineering error monitoring, browser performance tracing (Web Vitals, fetch spans, Studio timings), scrubbing/isolation rules, and Vite sourcemap upload integration.
- When no Sentry DSN is configured (local dev without DSN, tests, or open-source offline builds), all browser hooks become fast no-ops with zero outbound requests.

## Entrypoints

- `./config`: Zero-dependency runtime config validation, HTML bootstrap script serializer (`window.__OPENMOTION_OBSERVABILITY__`), and browser config reader. Safe to import from Node (`--experimental-strip-types`) and browsers.
- `./sanitize`: Zero-dependency URL/header/message redaction and noise/preview-origin filtering shared by browser `beforeSend`, `beforeSendTransaction`, and `beforeBreadcrumb`.
- `./browser`: Browser Sentry client (`@sentry/react`), React ErrorBoundary / React 19 root handlers, non-PII user/workspace/project tagging, and performance metrics helpers.
- `./vite`: Build-time `studio/vite.config.ts` helper wrapping `@sentry/vite-plugin` with plugin telemetry disabled, Debug ID injection, hidden sourcemaps, and post-upload `.map` removal.

## Runtime Configuration (Cloud API → Studio HTML)

Studio is built once into a container image and deployed across environments. Configure web Sentry at runtime on the `api` service rather than baking `VITE_*` variables into the bundle:

- `SENTRY_WEB_DSN`: Public Sentry DSN (`https://...` or loopback `http://...` in tests). Leave empty to disable web Sentry completely.
- `SENTRY_ENVIRONMENT`: Deployment environment tag (defaults to `NODE_ENV`).
- `SENTRY_RELEASE`: Release identifier (defaults to `openmotion@<package.version>`).
- `SENTRY_TRACES_SAMPLE_RATE`: Performance trace sample rate in `[0, 1]` (default `0.1`; set `0` to disable tracing while keeping error capture).

The `api` server injects a frozen `window.__OPENMOTION_OBSERVABILITY__` payload into `studio/build/index.html` only when `SENTRY_WEB_DSN` is configured. Untrusted preview iframes on `PREVIEW_PUBLIC_ORIGIN` never receive the Studio bootstrap script and are excluded from browser error capture.

## SourceMap Build & Upload

In `studio/vite.config.ts`:

- Normal local builds (`STUDIO_SOURCEMAP` unset or `true`): emit standard sourcemaps with zero Sentry plugin overhead.
- Production container builds without upload credentials (`STUDIO_SOURCEMAP=false`): emit no `.map` files.
- Release builds with Sentry upload credentials (`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, optional `SENTRY_URL` / `SENTRY_RELEASE`): Vite automatically forces `build.sourcemap = 'hidden'`, injects Debug IDs, uploads sourcemaps to Sentry, and deletes `.map` files before they reach the output directory.
- Two-step CI upload (`SENTRY_DEBUG_IDS=true` without `SENTRY_AUTH_TOKEN`): emits `hidden` sourcemaps with embedded Debug IDs so an external upload step can push them and strip `.map` artifacts afterwards.

In `deploy/Dockerfile`, pass the auth token via a BuildKit secret mount rather than a Docker `ARG`:

```bash
docker buildx build \
  -f deploy/Dockerfile \
  --target api \
  --build-arg SENTRY_ORG=my-org \
  --build-arg SENTRY_PROJECT=openmotion-web \
  --build-arg SENTRY_RELEASE="openmotion@0.0.1" \
  --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
  .
```

As defense-in-depth, the Docker build strips any remaining `studio/build/**/*.map` files before copying into `prod-base`, and `src/entrypoints/api.ts` refuses to serve `*.map` static files when `NODE_ENV=production`.
