import { Hono, type Context } from 'hono';
import type { AuthContext, PatScope, WorkspaceRole } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { WorkspaceService } from '../services/workspace-service.ts';
import { assertAuthAccess } from '../studio/context.ts';
import { artifactViewers, creationModes } from '../../shared/session.ts';
import type { ProductRouteVariables } from './projects.ts';

export interface SessionsRouterDeps {
  readonly workspace: WorkspaceService;
  readonly resolveAuth?: (c: Context<{ Variables: ProductRouteVariables }>) => AuthContext | Promise<AuthContext>;
}

const READ_REQ = { scope: 'projects:read' } as const;
const WRITE_REQ = { scope: 'projects:write', minRole: 'editor' } as const;

async function requireAuth(
  c: Context<{ Variables: ProductRouteVariables }>,
  deps: SessionsRouterDeps,
  requirements: { scope: PatScope; minRole?: WorkspaceRole },
): Promise<AuthContext> {
  const auth = deps.resolveAuth ? await deps.resolveAuth(c) : c.get('auth');
  if (!auth) {
    throw new CloudError('UNAUTHORIZED', 'Authentication is required.', { status: 401, applied: false });
  }
  assertAuthAccess(auth, requirements);
  return auth;
}

export function createSessionsRouter(deps: SessionsRouterDeps): Hono<{ Variables: ProductRouteVariables }> {
  const app = new Hono<{ Variables: ProductRouteVariables }>();

  app.onError((err, c) => {
    if (isCloudError(err)) {
      return c.json(err.toJSON(), err.status as 400);
    }
    return c.json(
      { code: 'INTERNAL_ERROR', error: err instanceof Error ? err.message : 'Internal server error' },
      500,
    );
  });

  // GET /motion-api/modes — Supported creation modes & artifact viewers.
  app.get('/motion-api/modes', (c) => {
    return c.json({ modes: creationModes, viewers: artifactViewers });
  });

  // GET /motion-api/sessions — List workspace sessions.
  app.get('/motion-api/sessions', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const catalog = await deps.workspace.getCatalog(auth);
    return c.json({
      activeSessionId: catalog.activeSessionId ?? null,
      sessions: catalog.sessions ?? [],
    });
  });

  // POST /motion-api/sessions — Create a creative session.
  app.post('/motion-api/sessions', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      mode?: string;
      templateId?: string;
      prompt?: string;
    };
    const created = await deps.workspace.createSession(auth, body);
    return c.json(created, 201);
  });

  // GET /motion-api/sessions/:id — Session detail including artifacts and messages.
  app.get('/motion-api/sessions/:id', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    return c.json(await deps.workspace.getSession(auth, c.req.param('id')));
  });

  // PATCH /motion-api/sessions/:id — Rename session.
  app.patch('/motion-api/sessions/:id', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string };
    return c.json(await deps.workspace.renameSession(auth, c.req.param('id'), body.title ?? ''));
  });

  // POST /motion-api/sessions/:id/open — Activate session and its active artifact.
  app.post('/motion-api/sessions/:id/open', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const opened = await deps.workspace.openSession(auth, c.req.param('id'));
    return c.json({ ok: true, session: opened });
  });

  // GET /motion-api/sessions/:id/messages — List session messages.
  app.get('/motion-api/sessions/:id/messages', async (c) => {
    const auth = await requireAuth(c, deps, READ_REQ);
    const detail = await deps.workspace.getSession(auth, c.req.param('id'));
    return c.json({ sessionId: detail.id, messages: detail.messages });
  });

  // POST /motion-api/sessions/:id/messages — Append a session message (idempotent on caller UUID `id`).
  app.post('/motion-api/sessions/:id/messages', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const body = (await c.req.json().catch(() => ({}))) as {
      id?: string;
      role?: 'user' | 'assistant';
      content?: string;
    };
    const appended = await deps.workspace.appendMessage(auth, c.req.param('id'), {
      id: body.id,
      role: body.role,
      content: body.content ?? '',
    });
    return c.json(appended, appended.replayed ? 200 : 201);
  });

  // POST /motion-api/sessions/:id/artifacts — Create a new motion project artifact inside an existing session.
  app.post('/motion-api/sessions/:id/artifacts', async (c) => {
    const auth = await requireAuth(c, deps, WRITE_REQ);
    const sessionId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      templateId?: string;
      requirements?: string;
      namingLanguage?: string;
      requestId?: string;
      selectActive?: boolean;
    };
    const created = await deps.workspace.createProject(auth, {
      sessionId,
      title: body.title,
      templateId: body.templateId,
      requirements: body.requirements,
      namingLanguage: body.namingLanguage,
      requestId: body.requestId,
      selectActive: body.selectActive,
    });
    return c.json(created, created.replayed ? 200 : 201);
  });

  return app;
}
