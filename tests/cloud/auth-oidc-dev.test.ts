import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import {
  DEFAULT_PAT_SCOPES,
  PAT_SCOPES,
  hasScope,
} from '../../src/contracts/auth.ts';
import { parseConfig, type AppConfig } from '../../src/infra/config.ts';
import {
  InMemoryAuthCache,
  InMemoryAuthStore,
  OidcService,
  SESSION_COOKIE_NAME,
  createAuthMiddleware,
  createAuthRoutes,
  createBrowserSession,
  createMcpBearerAuthMiddleware,
  createPat,
  generatePkcePair,
  getAuthContext,
  requireScope,
  sha256Hex,
  verifyPat,
  type AuthEnv,
} from '../../src/auth/index.ts';

// ---------------------------------------------------------------------------
// Test Config & Ephemeral RSA Keypair Helpers (Zero Static Keys on Disk!)
// ---------------------------------------------------------------------------

function makeConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    WORKER_ROLE: 'api',
    APP_PUBLIC_ORIGIN: 'https://motion.example.test',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'openmotion-cloud-client',
    OIDC_CLIENT_SECRET: 'ephemeral-test-client-secret',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    MODEL_GATEWAY_MODE: 'mock',
    DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/openmotion',
    REDIS_URL: 'redis://127.0.0.1:6379',
    ...overrides,
  });
}

async function createEphemeralOidcFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const kid = 'ephemeral-test-kid-1';
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [publicJwk] });

  async function signJwt(
    claims: Record<string, unknown>,
    options: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuedAt()
      .setIssuer(options.issuer ?? 'https://idp.example.test')
      .setAudience(options.audience ?? 'openmotion-cloud-client')
      .setExpirationTime(options.expiresIn ?? '1h')
      .sign(privateKey);
  }

  return { jwks, signJwt };
}

function extractCookieValue(setCookieHeaders: string[], name: string): string | null {
  for (const header of setCookieHeaders) {
    const match = new RegExp(`^${name}=([^;]+)`).exec(header.trim());
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('AUTH_MODE=dev Auto-Provisioning & /mcp Bearer Isolation', () => {
  it('auto-provisions deterministic dev tenant for browser API and enforces DEV_PAT / no-cookie rules on /mcp', async () => {
    const config = makeConfig({
      APP_PUBLIC_ORIGIN: 'http://127.0.0.1:4173',
      AUTH_MODE: 'dev',
      DEV_PAT: 'om_pat_devlocal_123456789012345678901234',
    });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache }), (c) => {
      const auth = getAuthContext(c);
      return c.json({ ok: true, workspaceId: auth.workspaceId, authMethod: auth.authMethod });
    });

    // Browser API auto-provisions deterministic DEV_WORKSPACE_ID + DEV_USER_ID
    const meRes = await app.request('/auth/me');
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as {
      authMode: string;
      authMethod: string;
      activeWorkspaceId: string;
      user: { id: string };
    };
    assert.equal(me.authMode, 'dev');
    assert.equal(me.authMethod, 'dev_bypass');
    assert.equal(me.activeWorkspaceId, config.DEV_WORKSPACE_ID);
    assert.equal(me.user.id, config.DEV_USER_ID);

    // /mcp accepts DEV_PAT Bearer token
    const devPatRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.DEV_PAT}` },
    });
    assert.equal(devPatRes.status, 200);

    // /mcp rejects invalid Bearer token even in dev mode
    const badBearer = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(badBearer.status, 401);
    assert.match(
      badBearer.headers.get('www-authenticate') ?? '',
      /resource_metadata="http:\/\/127\.0\.0\.1:4173\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // /mcp NEVER accepts browser om_session cookie even in dev mode
    const session = await createBrowserSession(store, {
      userId: config.DEV_USER_ID,
      workspaceId: config.DEV_WORKSPACE_ID,
    });
    const cookieOnMcp = await app.request('/mcp', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(cookieOnMcp.status, 401);
  });
});

describe('AUTH_MODE=oidc Authorization Code + PKCE, Browser Sessions, CSRF & JWKS Bearer', () => {
  it('completes OIDC Auth Code + PKCE login, sets Secure HttpOnly cookie, enforces CSRF Origin, and revokes authoritatively on logout', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const { jwks, signJwt } = await createEphemeralOidcFixture();

    let capturedCodeVerifier = '';
    let capturedNonce = '';
    const oidc = new OidcService(
      {
        issuer: 'https://idp.example.test',
        clientId: 'openmotion-cloud-client',
        clientSecret: 'ephemeral-test-client-secret',
        callbackUrl: 'https://motion.example.test/auth/callback',
        scopes: 'openid profile email',
        claimSub: 'sub',
        claimEmail: 'email',
        claimName: 'name',
        discovery: {
          issuer: 'https://idp.example.test',
          authorization_endpoint: 'https://idp.example.test/authorize',
          token_endpoint: 'https://idp.example.test/token',
          jwks_uri: 'https://idp.example.test/jwks.json',
          end_session_endpoint: 'https://idp.example.test/logout',
        },
        jwks,
        fetcher: async (_url, init) => {
          const body = new URLSearchParams(String(init?.body ?? ''));
          capturedCodeVerifier = body.get('code_verifier') ?? '';
          const idToken = await signJwt({
            sub: 'opendesign-user-42',
            email: 'alice@example.test',
            name: 'Alice Motion',
            nonce: capturedNonce,
          });
          return new Response(JSON.stringify({ id_token: idToken, access_token: 'ext_at' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
      cache,
    );

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache, oidc }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache, oidc }), (c) => {
      const auth = getAuthContext(c);
      return c.json({ ok: true, userId: auth.userId, authMethod: auth.authMethod });
    });

    // Step 1: Start login -> redirects to IdP with S256 PKCE + state + nonce + HttpOnly tx cookie
    const loginRes = await app.request('/auth/login?returnTo=/projects');
    assert.equal(loginRes.status, 302);
    const location = new URL(loginRes.headers.get('location')!);
    assert.equal(location.origin, 'https://idp.example.test');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    const state = location.searchParams.get('state')!;
    capturedNonce = location.searchParams.get('nonce')!;
    const setCookies = loginRes.headers.getSetCookie();
    const txCookie = extractCookieValue(setCookies, 'om_oidc_tx');
    assert.ok(txCookie);

    // Step 2: Callback exchanges code + PKCE verifier, verifies id_token via JWKS, creates PG session
    const cbRes = await app.request(`/auth/callback?code=auth-code-123&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `om_oidc_tx=${encodeURIComponent(txCookie)}` },
    });
    assert.equal(cbRes.status, 302);
    assert.equal(cbRes.headers.get('location'), '/projects');
    assert.ok(capturedCodeVerifier.length >= 43);

    const sessionCookies = cbRes.headers.getSetCookie();
    const rawSessionCookieHeader = sessionCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
    assert.ok(rawSessionCookieHeader.includes('HttpOnly'));
    assert.ok(rawSessionCookieHeader.includes('SameSite=Lax'));
    assert.ok(rawSessionCookieHeader.includes('Secure'));
    const sessionToken = extractCookieValue(sessionCookies, SESSION_COOKIE_NAME)!;

    // Step 3: Authenticated /auth/me works via cookie
    const meRes = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(meRes.status, 200);
    const me = (await meRes.json()) as {
      user: { email: string; displayName: string };
      authMethod: string;
    };
    assert.equal(me.authMethod, 'session_cookie');
    assert.equal(me.user.email, 'alice@example.test');
    assert.equal(me.user.displayName, 'Alice Motion');

    // Step 4: Browser cookie is STRICTLY REJECTED on /mcp with RFC 9728 WWW-Authenticate
    const mcpCookieRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(mcpCookieRes.status, 401);
    assert.match(
      mcpCookieRes.headers.get('www-authenticate') ?? '',
      /resource_metadata="https:\/\/motion\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    // Step 5: Direct OIDC Bearer JWT verified via JWKS works on /mcp
    const directJwt = await signJwt({
      sub: 'opendesign-user-42',
      email: 'alice@example.test',
      name: 'Alice Motion',
    });
    const mcpJwtRes = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${directJwt}` },
    });
    assert.equal(mcpJwtRes.status, 200);
    assert.equal(((await mcpJwtRes.json()) as { authMethod: string }).authMethod, 'oidc_jwt');

    // Step 6: CSRF Origin defense blocks cross-origin and null-origin cookie mutations
    const badOriginLogout = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        Origin: 'https://evil.example.net',
      },
    });
    assert.equal(badOriginLogout.status, 403);

    const nullOriginPat = await app.request('/motion-api/tokens', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        Origin: 'null',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'csrf-attempt' }),
    });
    assert.equal(nullOriginPat.status, 403);

    // Step 7: Same-origin logout revokes session authoritatively and evicts Redis cache immediately
    const logoutRes = await app.request('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
        Origin: 'https://motion.example.test',
      },
    });
    assert.equal(logoutRes.status, 200);

    const afterLogoutMe = await app.request('/auth/me', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    });
    assert.equal(afterLogoutMe.status, 401);
  });
});

describe('PAT Lifecycle & Strict Scope Non-Escalation', () => {
  it('hashes PAT with SHA-256, uses #11 default scopes, and NEVER elevates a restricted owner PAT', async () => {
    const config = makeConfig();
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const seeded = store.seedWorkspace({ role: 'owner', displayName: 'Owner Alice' });

    const ownerBrowserAuth = {
      workspaceId: seeded.workspace.id,
      userId: seeded.user.id,
      role: 'owner' as const,
      scopes: [...PAT_SCOPES],
      authMode: 'oidc' as const,
      authMethod: 'session_cookie' as const,
    };

    // Default PAT gets exact #11 default scopes (excluding workspace:admin)
    const defaultPat = await createPat(store, ownerBrowserAuth, { name: 'CI Default' });
    assert.match(defaultPat.token, /^om_pat_[a-f0-9]{8}_[A-Za-z0-9_-]+$/);
    assert.deepEqual(defaultPat.scopes, [...DEFAULT_PAT_SCOPES]);
    assert.equal(defaultPat.scopes.includes('workspace:admin'), false);

    // Raw secret is NEVER persisted — only SHA-256 hash
    const storedRow = store.pats.get(defaultPat.id)!;
    assert.equal(storedRow.tokenHash, sha256Hex(defaultPat.token));
    assert.notEqual(storedRow.tokenHash, defaultPat.token);

    // Restricted PAT owned by an `owner` with ONLY `projects:read` MUST NOT escalate
    const restrictedPat = await createPat(store, ownerBrowserAuth, {
      name: 'Read Only Audit',
      scopes: ['projects:read'],
    });
    const verifiedRestricted = await verifyPat(store, restrictedPat.token, {
      authMode: 'oidc',
      cache,
    });
    assert.ok(verifiedRestricted);
    assert.equal(verifiedRestricted.role, 'owner');
    assert.equal(hasScope(verifiedRestricted, 'projects:read'), true);
    assert.equal(hasScope(verifiedRestricted, 'projects:write'), false);
    assert.equal(hasScope(verifiedRestricted, 'workspace:admin'), false);

    // Verify Hono middleware rejects restricted PAT on protected route
    const app = new Hono<AuthEnv>();
    app.use('/protected/*', createAuthMiddleware({ config, store, cache }));
    app.post('/protected/admin', requireScope('workspace:admin'), (c) => c.json({ ok: true }));
    app.get('/protected/read', requireScope('projects:read'), (c) => c.json({ ok: true }));

    const readOk = await app.request('/protected/read', {
      headers: { Authorization: `Bearer ${restrictedPat.token}` },
    });
    assert.equal(readOk.status, 200);

    const adminBlocked = await app.request('/protected/admin', {
      method: 'POST',
      headers: { Authorization: `Bearer ${restrictedPat.token}` },
    });
    assert.equal(adminBlocked.status, 403);
    assert.equal(((await adminBlocked.json()) as { code: string }).code, 'INSUFFICIENT_SCOPE');

    // Live demotion to viewer immediately strips write scopes from an existing default PAT
    store.setRole(seeded.workspace.id, seeded.user.id, 'viewer');
    const afterDemotion = await verifyPat(store, defaultPat.token, { authMode: 'oidc', cache });
    assert.ok(afterDemotion);
    assert.equal(hasScope(afterDemotion, 'projects:read'), true);
    assert.equal(hasScope(afterDemotion, 'projects:write'), false);
    assert.equal(hasScope(afterDemotion, 'exports:write'), false);
  });
});

describe('OAuth 2.1 Proxy & Delegated Modes (RFC 9728, RFC 8414, DCR, PKCE S256, Rotation, Revoke)', () => {
  it('completes full DCR -> PKCE authorize -> token exchange -> refresh rotation -> revocation flow', async () => {
    const config = makeConfig({ MCP_OAUTH_MODE: 'proxy' });
    const store = new InMemoryAuthStore();
    const cache = new InMemoryAuthCache();
    const seeded = store.seedWorkspace({ role: 'editor', displayName: 'Editor Bob' });
    const session = await createBrowserSession(store, {
      userId: seeded.user.id,
      workspaceId: seeded.workspace.id,
    });

    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store, cache }));
    app.post('/mcp', createMcpBearerAuthMiddleware({ config, store, cache }), (c) => {
      const auth = getAuthContext(c);
      return c.json({
        workspaceId: auth.workspaceId,
        scopes: auth.scopes,
        authMethod: auth.authMethod,
      });
    });

    // RFC 9728 Protected Resource Metadata
    const prmRes = await app.request('/.well-known/oauth-protected-resource/mcp');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, 'https://motion.example.test/mcp');
    assert.deepEqual(prm.authorization_servers, ['https://motion.example.test']);

    // RFC 8414 Authorization Server Metadata
    const asmRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asmRes.status, 200);
    const asm = (await asmRes.json()) as {
      code_challenge_methods_supported: string[];
      registration_endpoint: string;
    };
    assert.deepEqual(asm.code_challenge_methods_supported, ['S256']);
    assert.equal(asm.registration_endpoint, 'https://motion.example.test/oauth/register');

    // RFC 7591 DCR rejects non-HTTPS non-loopback redirect URI
    const badDcr = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Unsafe Client',
        redirect_uris: ['http://evil.example.com/callback'],
      }),
    });
    assert.equal(badDcr.status, 400);

    // Valid DCR registration
    const dcrRes = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'ChatGPT Cloud',
        redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(dcrRes.status, 201);
    const client = (await dcrRes.json()) as { client_id: string };
    assert.ok(client.client_id.startsWith('om_client_'));

    // PKCE S256 Authorization GET -> Consent HTML -> POST approve
    const { codeVerifier, codeChallenge } = generatePkcePair();
    const authQuery = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp:tools projects:read',
      state: 'st-xyz',
      resource: 'https://motion.example.test/mcp',
    });

    const consentRes = await app.request(`/oauth/authorize?${authQuery.toString()}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
    });
    assert.equal(consentRes.status, 200);
    const consentHtml = await consentRes.text();
    const consentTokenMatch = /name="consent_token" value="([^"]+)"/.exec(consentHtml);
    assert.ok(consentTokenMatch);

    const approveBody = new URLSearchParams({
      consent_token: consentTokenMatch[1],
      client_id: client.client_id,
      redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      scope: 'mcp:tools projects:read',
      state: 'st-xyz',
      resource: 'https://motion.example.test/mcp',
      decision: 'approve',
    });

    const approveRes = await app.request('/oauth/authorize', {
      method: 'POST',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
        Origin: 'https://motion.example.test',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: approveBody.toString(),
    });
    assert.equal(approveRes.status, 302);
    const redirectUrl = new URL(approveRes.headers.get('location')!);
    const authCode = redirectUrl.searchParams.get('code')!;
    assert.equal(redirectUrl.searchParams.get('state'), 'st-xyz');
    assert.ok(authCode.length > 20);

    // Wrong PKCE verifier fails (and single-use code is consumed!)
    // First test fresh code with valid verifier:
    const tokenRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        client_id: client.client_id,
        code_verifier: codeVerifier,
      }).toString(),
    });
    assert.equal(tokenRes.status, 200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      scope: string;
    };
    assert.equal(tokens.scope, 'mcp:tools projects:read');

    // Replaying the same authorization code fails
    const replayRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
        client_id: client.client_id,
        code_verifier: codeVerifier,
      }).toString(),
    });
    assert.equal(replayRes.status, 400);

    // Access token authenticates /mcp with exact granted scopes
    const mcpOk = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    assert.equal(mcpOk.status, 200);
    const mcpData = (await mcpOk.json()) as {
      authMethod: string;
      scopes: string[];
      workspaceId: string;
    };
    assert.equal(mcpData.authMethod, 'oauth_bearer');
    assert.equal(mcpData.workspaceId, seeded.workspace.id);
    assert.deepEqual(mcpData.scopes, ['mcp:tools', 'projects:read']);

    // Refresh token rotation invalidates previous refresh & access tokens
    const rotatedRes = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(rotatedRes.status, 200);
    const rotated = (await rotatedRes.json()) as { access_token: string; refresh_token: string };
    assert.notEqual(rotated.access_token, tokens.access_token);

    const oldRefreshReplay = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }).toString(),
    });
    assert.equal(oldRefreshReplay.status, 400);

    // RFC 7009 revocation immediately invalidates rotated access token on /mcp
    const revokeRes = await app.request('/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rotated.access_token }).toString(),
    });
    assert.equal(revokeRes.status, 200);

    const mcpAfterRevoke = await app.request('/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rotated.access_token}` },
    });
    assert.equal(mcpAfterRevoke.status, 401);
  });

  it('advertises external issuer in MCP_OAUTH_MODE=delegated and disables proxy DCR endpoints', async () => {
    const config = makeConfig({
      MCP_OAUTH_MODE: 'delegated',
      OIDC_ISSUER: 'https://auth.open-design.ai',
    });
    const store = new InMemoryAuthStore();
    const app = new Hono<AuthEnv>();
    app.route('/', createAuthRoutes({ config, store }));

    const prmRes = await app.request('/.well-known/oauth-protected-resource/mcp');
    assert.equal(prmRes.status, 200);
    const prm = (await prmRes.json()) as { authorization_servers: string[] };
    assert.deepEqual(prm.authorization_servers, ['https://auth.open-design.ai']);

    const asmRes = await app.request('/.well-known/oauth-authorization-server');
    assert.equal(asmRes.status, 404);
  });
});
