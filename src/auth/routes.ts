import { Hono } from 'hono';
import { isCloudError } from '../contracts/errors.ts';
import { isUuid } from '../../shared/project-validation.ts';
import { createAuthMiddleware, getAuthContext, type AuthEnv, type AuthMiddlewareDeps } from './middleware.ts';
import {
  buildAuthorizationServerMetadata,
  buildOAuth21Config,
  buildProtectedResourceMetadata,
  exchangeOAuthToken,
  issueAuthorizationCode,
  registerOAuthClient,
  renderOAuthConsentHtml,
  revokeOAuthToken,
  validateAuthorizeRequest,
  type OAuth21Config,
} from './oauth21.ts';
import { createPat, listPats, revokePat } from './pat.ts';
import {
  DEFAULT_SESSION_TTL_SEC,
  OIDC_TX_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearCookie,
  createBrowserSession,
  isHttpsOrigin,
  parseCookies,
  resolveBrowserSession,
  revokeBrowserSession,
  serializeCookie,
  verifyCsrfOrigin,
} from './session.ts';
import { assertSafeReturnTo, randomBase64Url, sha256Hex, timingSafeStringEqual } from './store.ts';

const OAUTH_CONSENT_TTL_SEC = 600;

function parseBasicClientAuth(header: string | undefined): { clientId: string; clientSecret: string } | null {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    if (sep <= 0) return null;
    return {
      clientId: decodeURIComponent(decoded.slice(0, sep)),
      clientSecret: decodeURIComponent(decoded.slice(sep + 1)),
    };
  } catch {
    return null;
  }
}

export interface AuthRoutesDeps extends AuthMiddlewareDeps {
  oauth21?: OAuth21Config;
}

/**
 * Mounts:
 * - `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/me`
 * - `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`
 * - `/.well-known/oauth-authorization-server`
 * - `/oauth/register`, `/oauth/authorize` (GET/POST), `/oauth/token`, `/oauth/revoke`
 * - `/motion-api/tokens` (GET/POST), `/motion-api/tokens/:id` (DELETE)
 */
export function createAuthRoutes(deps: AuthRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  const oauthCfg = deps.oauth21 ?? buildOAuth21Config(deps.config);
  const secureCookie = isHttpsOrigin(deps.config.APP_PUBLIC_ORIGIN);
  const authMiddleware = createAuthMiddleware({ ...deps, oauth21: oauthCfg });

  // -------------------------------------------------------------------------
  // RFC 9728 & RFC 8414 Well-Known Metadata
  // -------------------------------------------------------------------------

  const serveProtectedResourceMetadata = (c: { json: (data: unknown, status?: 200) => Response; header: (k: string, v: string) => void }) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(buildProtectedResourceMetadata(oauthCfg), 200);
  };

  app.get('/.well-known/oauth-protected-resource', (c) => serveProtectedResourceMetadata(c));
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => serveProtectedResourceMetadata(c));

  app.get('/.well-known/oauth-authorization-server', (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json(
        {
          code: 'NOT_FOUND',
          error: 'Authorization server metadata is delegated to the external OIDC issuer',
          issuer: oauthCfg.issuer,
        },
        404,
      );
    }
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(buildAuthorizationServerMetadata(oauthCfg), 200);
  });

  // -------------------------------------------------------------------------
  // Browser OIDC Login / Callback / Logout / Me
  // -------------------------------------------------------------------------

  app.get('/auth/login', async (c) => {
    const returnTo = assertSafeReturnTo(c.req.query('returnTo'));
    if (deps.config.AUTH_MODE === 'dev') {
      return c.redirect(returnTo, 302);
    }
    if (!deps.oidc) {
      return c.json({ code: 'SERVICE_UNAVAILABLE', error: 'OIDC service is not configured' }, 503);
    }
    const { authorizationUrl, txCookieValue } = await deps.oidc.startLogin(returnTo);
    c.header(
      'Set-Cookie',
      serializeCookie(OIDC_TX_COOKIE_NAME, txCookieValue, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'Lax',
        path: '/auth',
        maxAgeSec: 600,
      }),
    );
    return c.redirect(authorizationUrl, 302);
  });

  app.get('/auth/callback', async (c) => {
    if (deps.config.AUTH_MODE === 'dev') {
      return c.redirect('/', 302);
    }
    if (!deps.oidc) {
      return c.json({ code: 'SERVICE_UNAVAILABLE', error: 'OIDC service is not configured' }, 503);
    }
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    const cookies = parseCookies(c.req.header('cookie'));
    const txCookieValue = cookies[OIDC_TX_COOKIE_NAME] ?? null;

    try {
      const { membership, returnTo } = await deps.oidc.completeCallback(deps.store, {
        code,
        state,
        txCookieValue,
      });

      const session = await createBrowserSession(deps.store, {
        userId: membership.user.id,
        workspaceId: membership.workspace.id,
        ttlSec: DEFAULT_SESSION_TTL_SEC,
      });

      const headers = new Headers();
      headers.append('Set-Cookie', clearCookie(OIDC_TX_COOKIE_NAME, secureCookie, '/auth'));
      headers.append(
        'Set-Cookie',
        serializeCookie(SESSION_COOKIE_NAME, session.token, {
          httpOnly: true,
          secure: secureCookie,
          sameSite: 'Lax',
          path: '/',
          maxAgeSec: DEFAULT_SESSION_TTL_SEC,
        }),
      );
      headers.set('Location', returnTo);
      return new Response(null, { status: 302, headers });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 500 | 502);
      }
      throw error;
    }
  });

  app.post('/auth/logout', async (c) => {
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];

    if (rawSession) {
      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json({ code: 'FORBIDDEN', error: 'CSRF Origin check failed on logout' }, 403);
      }
      await revokeBrowserSession(deps.store, { rawToken: rawSession }, deps.cache);
    }

    c.header('Set-Cookie', clearCookie(SESSION_COOKIE_NAME, secureCookie, '/'));
    let endSessionUrl: string | undefined;
    if (deps.config.AUTH_MODE === 'oidc' && deps.oidc) {
      try {
        const doc = await deps.oidc.discover();
        endSessionUrl = doc.end_session_endpoint;
      } catch {
        // Optional end_session_endpoint discovery failure must not block local logout.
      }
    }
    return c.json({ ok: true, ...(endSessionUrl ? { endSessionUrl } : {}) }, 200);
  });

  app.get('/auth/me', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    const workspaces = await deps.store.listUserWorkspaces(auth.userId);
    return c.json({
      authenticated: true,
      authMode: auth.authMode,
      authMethod: auth.authMethod,
      user: {
        id: auth.userId,
        email: auth.email ?? null,
        displayName: auth.displayName ?? 'User',
      },
      activeWorkspaceId: auth.workspaceId,
      role: auth.role,
      scopes: [...auth.scopes],
      workspaces,
    });
  });

  // -------------------------------------------------------------------------
  // OAuth 2.1 Proxy Endpoints (DCR, PKCE Authorize, Token, Revoke)
  // -------------------------------------------------------------------------

  app.post('/oauth/register', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation', error_description: 'DCR is delegated to external IdP' }, 404);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'Invalid JSON body' }, 400);
    }
    try {
      const registered = await registerOAuthClient(deps.store, body);
      return c.json(registered, 201);
    } catch (error) {
      if (isCloudError(error)) {
        return c.json({ error: 'invalid_client_metadata', error_description: error.message }, 400);
      }
      throw error;
    }
  });

  app.get('/oauth/authorize', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation', error_description: 'OAuth is delegated' }, 404);
    }

    let validated;
    try {
      validated = await validateAuthorizeRequest(deps.store, oauthCfg, {
        clientId: c.req.query('client_id'),
        redirectUri: c.req.query('redirect_uri'),
        responseType: c.req.query('response_type'),
        codeChallenge: c.req.query('code_challenge'),
        codeChallengeMethod: c.req.query('code_challenge_method'),
        scope: c.req.query('scope'),
        state: c.req.query('state'),
        resource: c.req.query('resource'),
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json({ error: 'invalid_request', error_description: error.message }, 400);
      }
      throw error;
    }

    // Resolve browser user session (or dev tenant in AUTH_MODE=dev).
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    let userId: string | null = null;
    let workspaceId: string | null = null;
    let workspaceName = 'Workspace';

    if (rawSession) {
      const resolved = await resolveBrowserSession(deps.store, rawSession, {
        authMode: deps.config.AUTH_MODE,
        cache: deps.cache,
      });
      if (resolved) {
        userId = resolved.auth.userId;
        workspaceId = resolved.auth.workspaceId;
        const ws = await deps.store.findWorkspaceById(workspaceId);
        if (ws) workspaceName = ws.name;
      }
    } else if (deps.config.AUTH_MODE === 'dev') {
      const dev = await deps.store.ensureDevTenant({
        workspaceId: deps.config.DEV_WORKSPACE_ID,
        userId: deps.config.DEV_USER_ID,
      });
      userId = dev.user.id;
      workspaceId = dev.workspace.id;
      workspaceName = dev.workspace.name;
    }

    if (!userId || !workspaceId) {
      const currentPath = new URL(c.req.url).pathname + new URL(c.req.url).search;
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(currentPath)}`, 302);
    }

    // Bind consent submission to a single-use CSRF token stored in cache.
    const consentToken = randomBase64Url(24);
    if (deps.cache) {
      await deps.cache.set(
        `om:oauth:consent:${sha256Hex(consentToken)}`,
        JSON.stringify({ userId, workspaceId, clientId: validated.client.clientId }),
        OAUTH_CONSENT_TTL_SEC,
      );
    }

    const html = renderOAuthConsentHtml({
      clientName: validated.client.clientName,
      workspaceName,
      scopes: validated.scopes,
      formAction: '/oauth/authorize',
      hiddenFields: {
        consent_token: consentToken,
        client_id: validated.client.clientId,
        redirect_uri: validated.redirectUri,
        response_type: 'code',
        code_challenge: validated.codeChallenge,
        code_challenge_method: 'S256',
        scope: validated.scope,
        ...(validated.state ? { state: validated.state } : {}),
        ...(validated.resource ? { resource: validated.resource } : {}),
      },
    });
    return c.html(html, 200);
  });

  app.post('/oauth/authorize', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation' }, 404);
    }

    // Parse form or JSON body.
    const contentType = c.req.header('content-type') ?? '';
    let fields: Record<string, string> = {};
    if (contentType.includes('application/json')) {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') fields[k] = v;
      }
    } else {
      const text = await c.req.text();
      const params = new URLSearchParams(text);
      for (const [k, v] of params.entries()) fields[k] = v;
    }

    // Authenticate the browser session (or dev mode) + enforce CSRF Origin check on cookie sessions.
    const cookies = parseCookies(c.req.header('cookie'));
    const rawSession = cookies[SESSION_COOKIE_NAME];
    let auth;
    if (rawSession) {
      if (!verifyCsrfOrigin(c.req.raw, deps.config.APP_PUBLIC_ORIGIN)) {
        return c.json({ error: 'access_denied', error_description: 'CSRF Origin check failed' }, 403);
      }
      const resolved = await resolveBrowserSession(deps.store, rawSession, {
        authMode: deps.config.AUTH_MODE,
        cache: deps.cache,
      });
      if (!resolved) {
        return c.json({ error: 'access_denied', error_description: 'Session expired' }, 401);
      }
      auth = resolved.auth;
    } else if (deps.config.AUTH_MODE === 'dev') {
      const dev = await deps.store.ensureDevTenant({
        workspaceId: deps.config.DEV_WORKSPACE_ID,
        userId: deps.config.DEV_USER_ID,
      });
      auth = {
        workspaceId: dev.workspace.id,
        userId: dev.user.id,
        role: dev.role,
        scopes: [...oauthCfg.supportedScopes],
        authMode: 'dev' as const,
        authMethod: 'dev_bypass' as const,
      };
    } else {
      return c.json({ error: 'access_denied', error_description: 'Authentication required' }, 401);
    }

    // Verify single-use consent token when cache is available.
    if (deps.cache && fields.consent_token) {
      const key = `om:oauth:consent:${sha256Hex(fields.consent_token)}`;
      const stored = await deps.cache.get(key);
      await deps.cache.del(key);
      if (!stored) {
        return c.json({ error: 'invalid_request', error_description: 'Consent token expired' }, 400);
      }
      const parsed = JSON.parse(stored) as { userId: string; clientId: string };
      if (!timingSafeStringEqual(parsed.userId, auth.userId) || parsed.clientId !== fields.client_id) {
        return c.json({ error: 'access_denied', error_description: 'Consent token mismatch' }, 403);
      }
    }

    let validated;
    try {
      validated = await validateAuthorizeRequest(deps.store, oauthCfg, {
        clientId: fields.client_id,
        redirectUri: fields.redirect_uri,
        responseType: fields.response_type ?? 'code',
        codeChallenge: fields.code_challenge,
        codeChallengeMethod: fields.code_challenge_method ?? 'S256',
        scope: fields.scope,
        state: fields.state,
        resource: fields.resource,
      });
    } catch (error) {
      if (isCloudError(error)) {
        return c.json({ error: 'invalid_request', error_description: error.message }, 400);
      }
      throw error;
    }

    if (fields.decision === 'deny') {
      const denyUrl = new URL(validated.redirectUri);
      denyUrl.searchParams.set('error', 'access_denied');
      if (validated.state) denyUrl.searchParams.set('state', validated.state);
      return c.redirect(denyUrl.toString(), 302);
    }

    const { redirectUrl } = await issueAuthorizationCode(deps.store, auth, validated);
    return c.redirect(redirectUrl, 302);
  });

  app.post('/oauth/token', async (c) => {
    if (oauthCfg.mode !== 'proxy') {
      return c.json({ error: 'unsupported_operation' }, 404);
    }

    const contentType = c.req.header('content-type') ?? '';
    let body: Record<string, string> = {};
    if (contentType.includes('application/json')) {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string') body[k] = v;
      }
    } else {
      const params = new URLSearchParams(await c.req.text());
      for (const [k, v] of params.entries()) body[k] = v;
    }

    const basic = parseBasicClientAuth(c.req.header('authorization'));
    const clientId = basic?.clientId ?? body.client_id;
    const clientSecret = basic?.clientSecret ?? body.client_secret;

    try {
      const tokenResponse = await exchangeOAuthToken(deps.store, oauthCfg, {
        grantType: body.grant_type ?? '',
        code: body.code,
        redirectUri: body.redirect_uri,
        codeVerifier: body.code_verifier,
        refreshToken: body.refresh_token,
        clientId,
        clientSecret,
        resource: body.resource,
      });
      c.header('Cache-Control', 'no-store');
      c.header('Pragma', 'no-cache');
      return c.json(tokenResponse, 200);
    } catch (error) {
      if (isCloudError(error)) {
        const oauthError =
          error.status === 401
            ? 'invalid_client'
            : error.message.startsWith('unsupported_grant_type')
              ? 'unsupported_grant_type'
              : 'invalid_grant';
        return c.json({ error: oauthError, error_description: error.message }, error.status as 400 | 401);
      }
      throw error;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const contentType = c.req.header('content-type') ?? '';
    let token = '';
    if (contentType.includes('application/json')) {
      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof raw.token === 'string') token = raw.token;
    } else {
      const params = new URLSearchParams(await c.req.text());
      token = params.get('token') ?? '';
    }
    await revokeOAuthToken(deps.store, token);
    return c.json({ ok: true }, 200);
  });

  // -------------------------------------------------------------------------
  // Personal Access Token (PAT) Lifecycle Endpoints
  // -------------------------------------------------------------------------

  app.get('/motion-api/tokens', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    const tokens = await listPats(deps.store, auth);
    return c.json({ tokens });
  });

  app.post('/motion-api/tokens', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    // Restrict PAT minting to browser sessions or dev bypass (prevent PAT-minting-PAT privilege loops).
    if (auth.authMethod !== 'session_cookie' && auth.authMethod !== 'dev_bypass') {
      return c.json(
        { code: 'FORBIDDEN', error: 'Personal access tokens can only be created from an interactive browser session.' },
        403,
      );
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ code: 'INVALID_ARGUMENT', error: 'Invalid JSON body' }, 400);
    }
    try {
      const created = await createPat(deps.store, auth, {
        name: typeof body.name === 'string' ? body.name : '',
        scopes: Array.isArray(body.scopes) ? (body.scopes as string[]) : undefined,
        expiresInDays:
          typeof body.expiresInDays === 'number' || body.expiresInDays === null
            ? (body.expiresInDays as number | null)
            : undefined,
      });
      return c.json(created, 201);
    } catch (error) {
      if (isCloudError(error)) {
        return c.json(error.toJSON(), error.status as 400 | 401 | 403 | 404 | 409 | 500);
      }
      throw error;
    }
  });

  app.delete('/motion-api/tokens/:id', authMiddleware, async (c) => {
    const auth = getAuthContext(c);
    if (auth.authMethod !== 'session_cookie' && auth.authMethod !== 'dev_bypass') {
      return c.json(
        { code: 'FORBIDDEN', error: 'Personal access tokens can only be revoked from an interactive browser session.' },
        403,
      );
    }
    const tokenId = c.req.param('id');
    if (!isUuid(tokenId)) {
      return c.json({ code: 'INVALID_ARGUMENT', error: 'Invalid token ID' }, 400);
    }
    const revoked = await revokePat(deps.store, auth, tokenId);
    if (!revoked) {
      return c.json({ code: 'NOT_FOUND', error: 'Token not found or already revoked' }, 404);
    }
    return c.json({ ok: true, id: tokenId });
  });

  return app;
}
