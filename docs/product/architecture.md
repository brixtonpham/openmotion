# OpenMotion Product Architecture

Updated: 2026-11-20. This document describes the container-first cloud architecture of OpenMotion (Phase 1 implementation and Phase 2 roadmap). Every capability marked **Implemented (Phase 1)** runs in this repository today; items marked **Planned (Phase 2)** return structured `501 FEATURE_DEFERRED_P2` responses and render graceful coming-soon states in Studio.

Related references: [Documentation index](../README.md) · [Discovery site map](discovery-site-map.md) · [Public MCP Phase 1 contract](../mcp-phase1-tools.md) · [Skill routing](../skills.md) · [Shared design system](../design-system.md) · [Template repository workflow](../template-repository.md) · [Deployment guide](../../deploy/README.md) · [Migration guide](../repository-migration.md).

---

## 1. Product Positioning & Core User Flows

**OpenMotion is a unified, cloud-native workspace for editable AI video and motion production.** Creators can start from **Explore** (curated templates, community showcases, media scenes, and motion Skills), work visually in **Motion Editor** (timeline, compositions, captions, properties, preview, and async MP4 export), manage generated or uploaded media in **Assets**, or drive the exact same workspace from any external MCP Agent over **Streamable HTTP (`/mcp`)**.

Core product principles:

1. **Agents and humans edit the same workspace.** Every project edit, asset import, model generation, version snapshot, and render export passes through shared domain services with optimistic revision protection (`expectedRevision` / `expectedVersionId`) and request deduplication (`requestId`).
2. **Container-first, diskless runtime.** Application pods hold no durable project state on local disk. Structured metadata lives in **PostgreSQL**, async queues and worker liveness live in **Redis / BullMQ**, and immutable project files, assets, and rendered videos live in **S3-compatible Content-Addressed Storage (CAS)**.
3. **One unified model gateway.** All image, video, speech, and music generation routes centrally through the **OpenDesign Model Gateway** tied to workspace identity and subscription entitlement—eliminating in-app BYOK secret forms, custom BaseURL inputs, and third-party key storage. Local Docker Compose supports `MODEL_GATEWAY_MODE=mock` for deterministic zero-billing development.
4. **Native Streamable HTTP MCP.** External Agents (Codex, Claude Code, Cursor, DeepSeek Harness, Claude Desktop, and ChatGPT Cloud on public HTTPS) connect directly to `/mcp` with **OAuth 2.1** or scoped **Personal Access Tokens (PAT)**—no host-side `docker exec` or local stdio bridge required.

### Primary Workspace Journeys

| Surface | URL Route | Capabilities |
| --- | --- | --- |
| **Explore** | `/` or `?page=explore` | Featured templates, highlights rail, Studio collections, model hubs, Skills index, and creators |
| **Motion Editor** | `?page=editor` / `?page=motion` | Diskless Hyperframes timeline & DOM editor backed by Postgres + S3 CAS, composition switcher, caption tracks, version history, remote-worker MP4 export |
| **Assets & Media Studios** | `?page=assets`, `?page=design`, `?page=cinema`, `?page=sound`, `?page=create&scene=<id>` | Presigned S3 upload flow, unified OpenDesign Model Gateway generation, async job tracking, version inspection, zero-copy project import |
| **MCP · Connect Agent** | `?page=mcp` | Product-wide capability handbook, Streamable HTTP `/mcp` setup (OAuth 2.1 + PAT), client-specific configs (including ChatGPT Cloud on HTTPS), copyable workflow prompts |
| **Settings** | `?page=settings&section=<id>` | Account (OIDC sign-in/out, workspace switcher, PAT management, `AUTH_MODE=dev` banner), Subscription & usage, Model gateway (`MODEL_GATEWAY_MODE=mock` banner + live catalog), Default models, General, Appearance, Privacy & data, Help, About |
| **Phase 2 Surfaces** | Design Studio, Brand Kit capture, ASR Transcription, Review Comments | Graceful `501 FEATURE_DEFERRED_P2` empty/coming-soon states without crashing or blocking Phase 1 workflows |

---

## 2. Container-First Runtime Topology

OpenMotion compiles to a single backend codebase (`src/`) and one static Studio SPA bundle (`studio/build/`), deployed via workload-split process roles from a single container image (local Docker Compose via [`deploy/README.md`](../../deploy/README.md) or Kubernetes):

```mermaid
flowchart LR
  Browser["Studio SPA (Browser)"] -->|HTTPS Session Cookie| API["api (Hono)"]
  Agent["External MCP Agents\n(Codex / Claude / Cursor / ChatGPT)"] -->|Streamable HTTP /mcp\nOAuth 2.1 or PAT Bearer| API
  Browser -->|Direct Presigned PUT / GET| S3["S3 / R2 / RustFS CAS"]
  Agent -->|Direct Presigned PUT| S3
  API --> PG["PostgreSQL (Drizzle ORM)"]
  API --> Redis["Redis + BullMQ"]
  API --> S3
  API -->|Unified Gateway| OD["OpenDesign Platform\n(OIDC + Model Gateway)"]
  Redis --> WM["worker-media\n(media-generate, media-ingest)"]
  Redis --> WR["worker-render\n(render-export: Chromium + FFmpeg)"]
  Redis --> CS["catalog-sync\n(template catalog refresh)"]
  WM --> PG
  WM --> S3
  WM --> OD
  WR --> PG
  WR --> S3
  WR -->|Heartbeat TTL| Redis
  CS --> PG
  CS --> S3
```

### Process Roles

| Role | Entrypoint / Mode | Responsibility | Scaling & Runtime Notes |
| --- | --- | --- | --- |
| **`api`** | Stateless Hono HTTP server (`src/entrypoints/api.ts`) | Serves Studio SPA, health probes (`/api/health/live`, `/api/health/ready`, `/api/health`), Auth (`/auth/*`), Account/Workspace/PAT APIs (`/motion-api/account/*`, `/motion-api/tokens`), Diskless Studio API (`/api/*`), Assets/Models/Projects/Exports APIs (`/motion-api/*`), OAuth 2.1 endpoints, and Streamable HTTP `/mcp` | Stateless, horizontally scalable; holds no persistent project files on disk |
| **`worker-media`** | BullMQ worker (`media-generate`, `media-ingest`) | Submits and polls OpenDesign Model Gateway jobs, verifies presigned S3 uploads and SSRF-checked HTTPS URLs, computes SHA-256 hashes, writes immutable CAS blobs and Postgres `assets` / `asset_versions` records | Network-I/O bound; independent concurrency from rendering |
| **`worker-render`** | BullMQ worker (`render-export`) | Hydrates a pinned project version from S3 CAS into ephemeral `/tmp` workspace, runs Hyperframes Chromium + FFmpeg rendering and technical verification, uploads MP4 back to S3 CAS, cleans up `/tmp`, and publishes liveness heartbeats (`ffmpeg`, `ffprobe`, `chromium`, active jobs) to Redis | CPU/memory intensive; isolated from API latency; Studio `/api/environment/ffmpeg` reads its live Redis heartbeat |
| **`catalog-sync`** | Scheduled / one-shot worker (`catalog-sync`) | Synchronizes published template catalog metadata and source manifests into Postgres & S3 | Runs independently without blocking request serving |

---

## 3. Data, Storage & State Boundaries

### PostgreSQL (Source of Truth for Metadata & Auth)

Managed with Drizzle ORM migrations (`src/db/schema/`):

- **Identity & Multi-Tenancy**: `users`, `workspaces`, `workspace_members` (roles: `owner`, `admin`, `editor`, `viewer`), `auth_sessions`, `personal_access_tokens` (prefix + SHA-256 hash, scopes, expiration, last-used, revocation), `oauth_clients`, `oauth_authorization_codes`, `oauth_tokens`.
- **Projects, Sessions & Revisions**: `sessions`, `session_messages`, `projects`, `work_rounds`, `project_files`, `project_versions`, `project_version_files`, `project_history_entries` (immutable snapshots with monotonic `revision` and `currentVersionId`).
- **Assets, Blobs & Transfers**: `workspace_blobs`, `assets`, `asset_versions` (pinned version identities pointing to immutable CAS blobs), `upload_tickets` (time-bounded presigned staging state machine: `issued` -> `confirmed` -> `committed` / `failed`).
- **Async Jobs, Idempotency & Catalog**: unified `jobs`, `idempotency_receipts` (scoped deduplication for mutating `requestId` calls), `catalog_templates`, `catalog_template_files`.

### S3-Compatible Content-Addressed Storage (CAS)

- Immutable media blobs, project source files, version snapshots, and rendered MP4 artifacts are stored under content-addressed keys (`workspaces/{wid}/blobs/{sha256}` and `catalog/blobs/{sha256}` in `src/infra/storage.ts`, plus staging prefixes for presigned uploads and export artifacts).
- **Direct browser & Agent transfers**: Clients never proxy large binary uploads through `api` memory. Uploads follow a 3-step presigned workflow:
  1. `POST /motion-api/assets/uploads/tickets` (or MCP `openmotion_import_assets` `action=prepare_upload`) returns `{ uploadId, uploadUrl, headers, expiresAt, maxBytes }`.
  2. Client executes `PUT <uploadUrl>` directly against object storage.
  3. `POST /motion-api/assets/uploads/:uploadId/confirm` (or MCP `upload_ticket`) enqueues `media-ingest` verification, promotes the verified blob into CAS, and commits the asset/project reference idempotently.

### Diskless Option B Studio API (`src/studio/`)

Studio's editor routes (`/api/projects/*`, `/api/projects/:id/files/*`, `/api/render/*`, `/api/environment/ffmpeg`) operate purely against Postgres + S3 CAS with zero local `MOTION_DATA_DIR` project filesystem dependencies:

- File reads/writes and DOM edits enforce optimistic revision locks and snapshot versions in Postgres + S3.
- Live preview streams project HTML/CSS/JS and pinned assets over authenticated Studio routes.
- `GET /api/environment/ffmpeg` reports `mode: 'remote-worker'` backed by live `worker-render` heartbeats in Redis (`useFfmpegStatus.ts` polls automatically while workers are starting or unavailable).

---

## 4. Authentication, Authorization & Multi-Tenancy

OpenMotion supports two explicit runtime authentication modes controlled by `AUTH_MODE`:

1. **`AUTH_MODE=oidc` (Production Cloud Default)**:
   - Browser Studio authenticates via **OpenDesign OIDC** (Authorization Code + PKCE: `GET /auth/login?returnTo=...`, OIDC callback, `POST /auth/logout`, `GET /auth/me`, `GET /motion-api/account/summary`).
   - Browser sessions use `HttpOnly` secure cookies and support switching active workspace via `POST /motion-api/account/workspaces/switch`.
   - Workspace RBAC enforces `owner`, `admin`, `editor`, and `viewer` permissions across HTTP and MCP endpoints (for example, `PUT /motion-api/models/defaults` requires `admin` role + `workspace:admin` scope).
   - **External MCP `/mcp` Authentication**: Strictly accepts **OAuth 2.1 Bearer access tokens** (with RFC 9728 `/.well-known/oauth-protected-resource/mcp` discovery + PKCE + Dynamic Client Registration) or **Personal Access Tokens (`om_pat_*`)** managed in `Settings > Account`. **Browser session cookies are never accepted on `/mcp`.**
2. **`AUTH_MODE=dev` (Local Docker Compose Convenience Mode)**:
   - Bypasses interactive OIDC sign-in with a deterministic single local owner workspace and dev Bearer token for zero-friction local Docker Compose evaluation.
   - Studio surfaces an explicit **Local Dev Mode (`AUTH_MODE=dev`)** banner in Account Settings and a **Dev** badge in the account menu so development bypass state is never ambiguous.

---

## 5. Unified OpenDesign Model Gateway (No BYOK)

In the container-first cloud architecture, all third-party BYOK provider forms, local API-key storage, custom BaseURL settings, and multi-provider preset lists have been retired from Studio and backend services:

- **Single Platform Gateway (`src/services/model-gateway.ts`)**: All image, video, speech, and music generation calls route through the OpenDesign platform gateway (`/motion-api/models`, `/motion-api/models/catalog`, `/motion-api/models/status`, `/motion-api/models/defaults`, `/motion-api/models/generate`, `/motion-api/models/jobs/*`).
- **Workspace Entitlement & Defaults**: Model discovery surfaces workspace plan entitlement (`mediaEntitlement`) and billing status from OpenDesign without asking users to copy secrets into Studio or chat. Workspace admins configure default `image`, `video`, and `audio` models in Settings.
- **Local Mock Mode (`MODEL_GATEWAY_MODE=mock`)**: Returns deterministic local fixture assets (64×64 PNG, 1s MP4, 1s WAV) with zero external API calls or billing, indicated in Studio by a **Local Mock Model Gateway** banner in Settings.
- **Shared Semantics**: Studio generators and MCP tools (`openmotion_media_use`, `openmotion_assets_use`) share the same catalog, parameter schemas, job records, cancellation, and non-duplicating `resume` checks.

---

## 6. Public Streamable HTTP MCP Contract

OpenMotion exposes a **Streamable HTTP** MCP server at `/mcp` (`http://127.0.0.1:4173/mcp` in local Docker Compose; `https://<domain>/mcp` in cloud deployments).

- **22 Registered Domain Tools**: Phase 1 preserves all twenty-two registered `openmotion_*` tool names (eighteen video/workspace tools including the `openmotion_assets` compatibility alias, plus four `openmotion_design_*` tools retained for forward compatibility). Negotiated MCP Apps connections may additionally discover read-only presentation extensions.
- **3-Way Cloud `openmotion_import_assets`**: Local host paths (`sourcePath`) are unsupported in cloud containers. External Agents import assets via:
  1. **Presigned upload ticket** (`action=prepare_upload` -> direct HTTP PUT -> commit with `upload_ticket`),
  2. **SSRF-checked public HTTPS `url`** (validated and fetched by `worker-media`), or
  3. **Zero-copy `library_asset`** (`assetId` + `versionId` within the same workspace).
- **Client Support**: Works natively with Codex, Claude Code, Cursor, DeepSeek Harness, Claude Desktop, and **ChatGPT Cloud** (enabled automatically when deployed on a public HTTPS origin with OAuth 2.1).
- **MCP Handbook (`studio/src/motion/McpConnectionPage.tsx`, `mcpCapabilities.ts`, `shared/integration.ts`)**: Acts as the maintained product-wide capability and setup handbook, reading live discovery from `GET /motion-api/account/integration`, offering client-side downloadable Streamable HTTP configs, direct PAT management links, and localized guidance across all eleven UI languages (`en`, `zh-CN`, `ja`, `ko`, `de`, `fr`, `ru`, `es`, `pt-BR`, `it`, `tr`).

---

## 7. Shared Design System & Studio UI Contract

All Studio interface surfaces consume [`packages/design-system`](../../packages/design-system/README.md) and [`packages/open-design-ui`](../../packages/open-design-ui/README.md):

- **Single token source**: Semantic light/dark theme tokens in `tokens.json` with zero literal colors in feature CSS, enforced by `npm run design:check`.
- **Opaque solid UI materials**: Menus, popovers, dialogs, tooltips, and floating controls use solid theme surfaces with zero `backdrop-filter` or translucent glass overrides.
- **Floating Toast feedback**: All transient operation feedback (copy, save, upload, PAT create/revoke, workspace switch, sync, failure) uses `useToast` + `StudioToastViewport` without shifting document layout.
- **Shared ODUI controls**: New actions and range controls reuse `Button`, `IconButton`, and `Slider`, maintaining `packages/open-design-ui/registry.json` exercised consumers (`CaptionsPanel.tsx`, `TimelineCaptionActions.tsx`, `GenerationParameters.tsx`) and tightening `scripts/studio-native-controls.json` as legacy controls are retired.

### Retired Local-Only Desktop UI

The following host-local features from the legacy desktop runtime have been removed in Cloud Phase 1:

- Embedded desktop Chromium `WebBrowser` tab (`shared/browser`)
- Local Codex `AssetChat` / `AssetConversation` runner and `/motion-api/assets/conversations` polling
- Local CLI Agent scanner & host terminal launcher (`Local Agents` settings tab, `useLocalAgents`)
- In-app BYOK API-key inputs, custom provider BaseURL forms, and third-party provider preset registries

---

## 8. Capability Matrix: Phase 1 Implemented vs Phase 2 Planned

| Capability Area | Phase 1 Status | Backend / Storage Path | Studio & MCP Behavior |
| --- | --- | --- | --- |
| **Video Projects & Revision-Checked Edits** | **Implemented (P1)** | Postgres + S3 CAS + Diskless Studio API | Full create/read/edit/rename/duplicate/trash/restore/delete, `expectedRevision` / `expectedVersionId` guards, `requestId` deduplication |
| **Version History & Restoration** | **Implemented (P1)** | Postgres `project_versions` + S3 CAS | Paginated history, safe restore-as-new-version preserving later history |
| **Asset Library & 3-Way Cloud Import** | **Implemented (P1)** | Presigned S3 PUT + `worker-media` (`media-ingest`) | Studio presigned upload (`POST /uploads/tickets` -> `PUT` -> `confirm`); MCP `upload_ticket`, HTTPS `url`, zero-copy `library_asset` |
| **Unified Media Generation (Image/Video/Audio)** | **Implemented (P1)** | OpenDesign Model Gateway (`opendesign` or `mock`) + `worker-media` | Live catalog, workspace defaults, async BullMQ jobs, cancel/resume, zero BYOK secrets |
| **Async MP4 Rendering & Technical Verification** | **Implemented (P1)** | `worker-render` (`render-export`) + Redis heartbeat + S3 CAS | Remote Chromium/FFmpeg render pipeline, `/api/environment/ffmpeg` worker status, presigned download |
| **Template Catalog & Production Skills** | **Implemented (P1)** | Postgres + S3 / `catalog-sync` + `skills/` | Shared discovery across Explore, Studio, and MCP tools/resources |
| **Auth, Workspaces, OAuth 2.1 & PAT** | **Implemented (P1)** | OpenDesign OIDC / `AUTH_MODE=dev` + Postgres | Browser OIDC + workspace switcher + PAT CRUD; `/mcp` OAuth 2.1 & PAT Bearer isolation |
| **Manual Captions & SRT/VTT Import/Export** | **Implemented (P1)** | Project composition files + Studio Captions panel | Canvas aspect presets, CC toggle, manual cue edits, SRT/VTT import & export |
| **Cloud HTML Design Studio (`openmotion_design_*`)** | **Planned (Phase 2)** | Returns `501 FEATURE_DEFERRED_P2` | Tools remain registered in the 22-tool contract; Studio renders a non-crashing Phase 2 notice |
| **Automated Website Brand Kit Capture** | **Planned (Phase 2)** | Returns `501 FEATURE_DEFERRED_P2` | Official catalog stays browsable; custom capture renders a Phase 2 notice and stops background polling |
| **Cloud Speech Recognition (ASR Jobs)** | **Planned (Phase 2)** | Returns `501 FEATURE_DEFERRED_P2` | Transcript panel displays a Phase 2 notice for automated ASR while keeping SRT/VTT import & Captions usable |
| **Frame-Anchored Review Comments & Markup** | **Planned (Phase 2)** | Returns `501 FEATURE_DEFERRED_P2` | Review panel stops polling and renders a clean Phase 2 empty state |
| **Live Real-Time Multi-User Co-Editing** | **Planned (Phase 2+)** | Not implemented in P1 | Phase 1 provides multi-user RBAC with optimistic revision conflict protection |

---

## 9. Verification Boundaries

Automated checks, containerized integration tests, live upstream billing, and human visual review remain distinct evidence tiers:

- **Static & Unit Gates**: `npm run typecheck:studio`, `npm run build:studio`, `npm run design:check`, `npm run test:studio`, `tests/mcp-onboarding.test.ts`, and `tests/cloud/*` verify contracts, schemas, RBAC, isolation, and UI resilience deterministically (using `MODEL_GATEWAY_MODE=mock` and mocked/containerized Postgres, Redis, and S3-compatible storage such as RustFS).
- **Container Stack Verification**: `docker compose up` validates end-to-end `api` + `worker-media` + `worker-render` + Postgres + Redis + RustFS (S3) health, presigned uploads, Streamable HTTP `/mcp`, and MP4 exports.
- **External Platform & Visual Acceptance**: Real OpenDesign OIDC sign-in, live paid OpenDesign Model Gateway execution, public HTTPS ChatGPT Cloud OAuth 2.1 handshakes, and human audiovisual review of rendered films require live environment credentials and human inspection.
