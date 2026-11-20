import {
  DEFAULT_PAT_SCOPES,
  type AuthContext,
  type AuthMode,
  type PatScope,
} from '../contracts/auth.ts';
import { CloudError } from '../contracts/errors.ts';
import type { AppConfig } from '../infra/config.ts';
import { verifyPkceS256 } from './oidc.ts';
import {
  intersectScopesWithRole,
  isValidPatScope,
  randomBase64Url,
  randomHex,
  sha256Hex,
  timingSafeStringEqual,
  type AuthStore,
  type OAuthAuthMethod,
  type OAuthClientRecord,
} from './store.ts';

export const OAUTH_ACCESS_TOKEN_PREFIX = 'om_oat_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'om_ort_';
const AUTH_CODE_TTL_SEC = 300; // 5 minutes
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export type McpOAuthMode = 'proxy' | 'delegated';

export interface OAuth21Config {
  mode: McpOAuthMode;
  publicOrigin: string;
  issuer: string;
  resourceUrl: string;
  resourceMetadataUrl: string;
  supportedScopes: readonly PatScope[];
}

export function buildOAuth21Config(
  config: Pick<AppConfig, 'APP_PUBLIC_ORIGIN' | 'MCP_OAUTH_MODE' | 'MCP_OAUTH_ISSUER' | 'OIDC_ISSUER'>,
): OAuth21Config {
  const publicOrigin = config.APP_PUBLIC_ORIGIN.replace(/\/$/, '');
  const resourceUrl = `${publicOrigin}/mcp`;
  const resourceMetadataUrl = `${publicOrigin}/.well-known/oauth-protected-resource/mcp`;
  const issuer = (
    config.MCP_OAUTH_ISSUER ??
    (config.MCP_OAUTH_MODE === 'delegated' && config.OIDC_ISSUER
      ? config.OIDC_ISSUER
      : publicOrigin)
  ).replace(/\/$/, '');

  return {
    mode: config.MCP_OAUTH_MODE,
    publicOrigin,
    issuer,
    resourceUrl,
    resourceMetadataUrl,
    supportedScopes: [...DEFAULT_PAT_SCOPES],
  };
}

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata document.
 */
export function buildProtectedResourceMetadata(cfg: OAuth21Config): Record<string, unknown> {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [...cfg.supportedScopes],
    resource_name: 'OpenMotion MCP',
  };
}

/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata document (proxy mode).
 */
export function buildAuthorizationServerMetadata(cfg: OAuth21Config): Record<string, unknown> {
  const base = cfg.publicOrigin;
  return {
    issuer: cfg.issuer,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [...cfg.supportedScopes],
  };
}

export function normalizeResourceUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function isAllowedOAuthRedirectUri(raw: string): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === 'https:') return Boolean(parsed.hostname);
  if (parsed.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  }
  return false;
}

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) && token.length >= 40;
}

export function parseScopeString(raw: string | null | undefined, fallback: readonly PatScope[]): PatScope[] {
  if (!raw || !raw.trim()) return [...fallback];
  const scopes: PatScope[] = [];
  for (const part of raw.trim().split(/\s+/)) {
    if (isValidPatScope(part) && !scopes.includes(part)) {
      scopes.push(part);
    }
  }
  return scopes.length > 0 ? scopes : [...fallback];
}

// ---------------------------------------------------------------------------
// RFC 7591 Dynamic Client Registration
// ---------------------------------------------------------------------------

export interface RegisterClientInput {
  client_name?: unknown;
  redirect_uris?: unknown;
  grant_types?: unknown;
  token_endpoint_auth_method?: unknown;
}

export interface RegisterClientResult {
  client_id: string;
  client_secret?: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method: OAuthAuthMethod;
  client_id_issued_at: number;
}

export async function registerOAuthClient(
  store: AuthStore,
  input: RegisterClientInput,
): Promise<RegisterClientResult> {
  const clientName =
    typeof input.client_name === 'string' && input.client_name.trim().length > 0
      ? input.client_name.trim().slice(0, 160)
      : 'MCP Client';

  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0 || input.redirect_uris.length > 10) {
    throw new CloudError('INVALID_ARGUMENT', 'redirect_uris must be a non-empty array (max 10)', {
      status: 400,
    });
  }
  const redirectUris: string[] = [];
  for (const uri of input.redirect_uris) {
    if (typeof uri !== 'string' || !isAllowedOAuthRedirectUri(uri)) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        'redirect_uris must contain only HTTPS or loopback HTTP URIs without fragments',
        { status: 400 },
      );
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri);
  }

  const allowedAuthMethods: readonly OAuthAuthMethod[] = [
    'none',
    'client_secret_post',
    'client_secret_basic',
  ];
  const authMethod: OAuthAuthMethod =
    typeof input.token_endpoint_auth_method === 'string' &&
    allowedAuthMethods.includes(input.token_endpoint_auth_method as OAuthAuthMethod)
      ? (input.token_endpoint_auth_method as OAuthAuthMethod)
      : 'none';

  const supportedGrants = new Set(['authorization_code', 'refresh_token']);
  const requestedGrants = Array.isArray(input.grant_types)
    ? input.grant_types.filter((g): g is string => typeof g === 'string' && supportedGrants.has(g))
    : ['authorization_code', 'refresh_token'];
  const grantTypes =
    requestedGrants.length > 0 ? [...new Set(requestedGrants)] : ['authorization_code', 'refresh_token'];

  const clientId = `om_client_${randomHex(12)}`;
  const rawSecret = authMethod === 'none' ? null : `om_csec_${randomBase64Url(32)}`;
  const clientSecretHash = rawSecret ? sha256Hex(rawSecret) : null;

  const created = await store.createOAuthClient({
    clientId,
    clientSecretHash,
    clientName,
    redirectUris,
    grantTypes,
    tokenEndpointAuthMethod: authMethod,
  });

  return {
    client_id: created.clientId,
    ...(rawSecret ? { client_secret: rawSecret } : {}),
    client_name: created.clientName,
    redirect_uris: created.redirectUris,
    grant_types: created.grantTypes,
    token_endpoint_auth_method: created.tokenEndpointAuthMethod,
    client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Authorization Code Validation & Issuance (OAuth 2.1 + Mandatory PKCE S256)
// ---------------------------------------------------------------------------

export interface ValidatedAuthorizeParams {
  client: OAuthClientRecord;
  redirectUri: string;
  state: string | null;
  scope: string;
  scopes: PatScope[];
  codeChallenge: string;
  resource: string | null;
}

export async function validateAuthorizeRequest(
  store: AuthStore,
  cfg: OAuth21Config,
  params: {
    clientId?: string | null;
    redirectUri?: string | null;
    responseType?: string | null;
    codeChallenge?: string | null;
    codeChallengeMethod?: string | null;
    scope?: string | null;
    state?: string | null;
    resource?: string | null;
  },
): Promise<ValidatedAuthorizeParams> {
  if (!params.clientId) {
    throw new CloudError('INVALID_ARGUMENT', 'client_id is required', { status: 400 });
  }
  const client = await store.findOAuthClient(params.clientId);
  if (!client) {
    throw new CloudError('INVALID_ARGUMENT', 'Unknown OAuth client_id', { status: 400 });
  }
  if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) {
    throw new CloudError('INVALID_ARGUMENT', 'redirect_uri does not match registered client', {
      status: 400,
    });
  }
  if (params.responseType !== 'code') {
    throw new CloudError('INVALID_ARGUMENT', 'response_type must be code', { status: 400 });
  }
  if (!params.codeChallenge || params.codeChallenge.length < 43 || params.codeChallenge.length > 128) {
    throw new CloudError('INVALID_ARGUMENT', 'PKCE code_challenge is required', { status: 400 });
  }
  if (params.codeChallengeMethod !== 'S256') {
    throw new CloudError('INVALID_ARGUMENT', 'OAuth 2.1 requires code_challenge_method=S256', {
      status: 400,
    });
  }

  let normalizedResource: string | null = null;
  if (params.resource) {
    normalizedResource = normalizeResourceUrl(params.resource);
    const expectedResource = normalizeResourceUrl(cfg.resourceUrl);
    if (!normalizedResource || normalizedResource !== expectedResource) {
      throw new CloudError('INVALID_ARGUMENT', 'Invalid RFC 8707 resource parameter', {
        status: 400,
      });
    }
  }

  const scopes = parseScopeString(params.scope, cfg.supportedScopes);
  return {
    client,
    redirectUri: params.redirectUri,
    state: params.state ?? null,
    scope: scopes.join(' '),
    scopes,
    codeChallenge: params.codeChallenge,
    resource: normalizedResource ?? normalizeResourceUrl(cfg.resourceUrl),
  };
}

export async function issueAuthorizationCode(
  store: AuthStore,
  auth: AuthContext,
  validated: ValidatedAuthorizeParams,
): Promise<{ code: string; redirectUrl: string }> {
  const effectiveScopes = intersectScopesWithRole(validated.scopes, auth.role);
  if (effectiveScopes.length === 0) {
    throw new CloudError('FORBIDDEN', 'No requested scopes are permitted for your workspace role', {
      status: 403,
    });
  }

  const code = randomBase64Url(32);
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + AUTH_CODE_TTL_SEC * 1000);

  await store.createOAuthAuthCode({
    codeHash,
    clientId: validated.client.clientId,
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    redirectUri: validated.redirectUri,
    scope: effectiveScopes.join(' '),
    codeChallenge: validated.codeChallenge,
    resource: validated.resource,
    expiresAt,
  });

  const redirect = new URL(validated.redirectUri);
  redirect.searchParams.set('code', code);
  if (validated.state) {
    redirect.searchParams.set('state', validated.state);
  }
  return { code, redirectUrl: redirect.toString() };
}

// ---------------------------------------------------------------------------
// Token Exchange & Rotation (`POST /oauth/token`)
// ---------------------------------------------------------------------------

export interface OAuthTokenRequest {
  grantType: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  resource?: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function authenticateOAuthClient(
  client: OAuthClientRecord,
  suppliedSecret?: string,
): void {
  if (client.tokenEndpointAuthMethod === 'none') return;
  if (!suppliedSecret || !client.clientSecretHash) {
    throw new CloudError('UNAUTHORIZED', 'invalid_client', { status: 401 });
  }
  if (!timingSafeStringEqual(sha256Hex(suppliedSecret), client.clientSecretHash)) {
    throw new CloudError('UNAUTHORIZED', 'invalid_client', { status: 401 });
  }
}

export async function exchangeOAuthToken(
  store: AuthStore,
  cfg: OAuth21Config,
  req: OAuthTokenRequest,
): Promise<OAuthTokenResponse> {
  if (!req.clientId) {
    throw new CloudError('INVALID_ARGUMENT', 'client_id is required', { status: 400 });
  }
  const client = await store.findOAuthClient(req.clientId);
  if (!client) {
    throw new CloudError('UNAUTHORIZED', 'invalid_client', { status: 401 });
  }
  authenticateOAuthClient(client, req.clientSecret);

  if (req.grantType === 'authorization_code') {
    if (!req.code || !req.redirectUri || !req.codeVerifier) {
      throw new CloudError('INVALID_ARGUMENT', 'code, redirect_uri, and code_verifier are required', {
        status: 400,
      });
    }
    const consumed = await store.consumeOAuthAuthCode(sha256Hex(req.code));
    if (!consumed) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: authorization code expired or already used', {
        status: 400,
      });
    }
    if (consumed.clientId !== client.clientId || consumed.redirectUri !== req.redirectUri) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: client or redirect_uri mismatch', {
        status: 400,
      });
    }
    if (!verifyPkceS256(req.codeVerifier, consumed.codeChallenge)) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: PKCE verification failed', {
        status: 400,
      });
    }
    if (req.resource && consumed.resource) {
      if (normalizeResourceUrl(req.resource) !== normalizeResourceUrl(consumed.resource)) {
        throw new CloudError('INVALID_ARGUMENT', 'invalid_target: resource mismatch', {
          status: 400,
        });
      }
    }

    return mintOAuthTokenPair(store, {
      clientId: client.clientId,
      userId: consumed.userId,
      workspaceId: consumed.workspaceId,
      scope: consumed.scope,
      resource: consumed.resource ?? normalizeResourceUrl(cfg.resourceUrl),
    });
  }

  if (req.grantType === 'refresh_token') {
    if (!req.refreshToken) {
      throw new CloudError('INVALID_ARGUMENT', 'refresh_token is required', { status: 400 });
    }
    const existing = await store.findActiveOAuthTokenByRefreshHash(sha256Hex(req.refreshToken));
    if (!existing || existing.clientId !== client.clientId) {
      throw new CloudError('INVALID_ARGUMENT', 'invalid_grant: refresh token is invalid or expired', {
        status: 400,
      });
    }
    // Rotate refresh token atomically: revoke previous row before issuing a fresh pair.
    const revoked = await store.revokeOAuthTokenById(existing.id);
    if (!revoked) {
      throw new CloudError(
        'INVALID_ARGUMENT',
        'invalid_grant: refresh token already used or revoked',
        { status: 400 },
      );
    }

    return mintOAuthTokenPair(store, {
      clientId: client.clientId,
      userId: existing.userId,
      workspaceId: existing.workspaceId,
      scope: existing.scope,
      resource: existing.resource,
    });
  }

  throw new CloudError('INVALID_ARGUMENT', 'unsupported_grant_type', { status: 400 });
}

async function mintOAuthTokenPair(
  store: AuthStore,
  input: {
    clientId: string;
    userId: string;
    workspaceId: string;
    scope: string;
    resource: string | null;
  },
): Promise<OAuthTokenResponse> {
  const accessToken = `${OAUTH_ACCESS_TOKEN_PREFIX}${randomBase64Url(36)}`;
  const refreshToken = `${OAUTH_REFRESH_TOKEN_PREFIX}${randomBase64Url(36)}`;
  const now = Date.now();
  const accessExpiresAt = new Date(now + ACCESS_TOKEN_TTL_SEC * 1000);
  const refreshExpiresAt = new Date(now + REFRESH_TOKEN_TTL_SEC * 1000);

  await store.createOAuthToken({
    clientId: input.clientId,
    userId: input.userId,
    workspaceId: input.workspaceId,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    scope: input.scope,
    resource: input.resource,
    accessExpiresAt,
    refreshExpiresAt,
  });

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: refreshToken,
    scope: input.scope,
  };
}

export async function revokeOAuthToken(store: AuthStore, token: string): Promise<void> {
  if (!token) return;
  await store.revokeOAuthTokenByHash(sha256Hex(token));
}

/**
 * Verify an OAuth 2.1 access token stored in PG `oauth_tokens`.
 * Enforces revocation, expiry, RFC 8707 resource binding, live membership, and strict scope intersection.
 */
export async function verifyOAuthAccessToken(
  store: AuthStore,
  rawToken: string,
  options: { authMode: AuthMode; expectedResource: string },
): Promise<AuthContext | null> {
  if (!isOAuthAccessToken(rawToken)) return null;
  const computedHash = sha256Hex(rawToken);
  const row = await store.findActiveOAuthTokenByAccessHash(computedHash);
  if (!row) return null;
  if (!timingSafeStringEqual(computedHash, row.accessTokenHash)) return null;

  if (row.resource) {
    const expected = normalizeResourceUrl(options.expectedResource);
    const actual = normalizeResourceUrl(row.resource);
    if (!expected || !actual || expected !== actual) return null;
  }

  const membership = await store.findMembership(row.workspaceId, row.userId);
  if (!membership) return null;

  const tokenScopes = parseScopeString(row.scope, []);
  const effectiveScopes = intersectScopesWithRole(tokenScopes, membership.role);

  return {
    workspaceId: membership.workspace.id,
    userId: membership.user.id,
    role: membership.role,
    scopes: effectiveScopes,
    authMode: options.authMode,
    authMethod: 'oauth_bearer',
    externalWorkspaceId: membership.workspace.externalWorkspaceId,
    tokenId: row.id,
    email: membership.user.email,
    displayName: membership.user.displayName,
  };
}

// ---------------------------------------------------------------------------
// Minimal Escaped HTML Consent Page for OAuth 2.1 Proxy Mode
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderOAuthConsentHtml(input: {
  clientName: string;
  workspaceName: string;
  scopes: readonly string[];
  formAction: string;
  hiddenFields: Record<string, string>;
}): string {
  const hiddenInputs = Object.entries(input.hiddenFields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join('\n');
  const scopeList = input.scopes
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize ${escapeHtml(input.clientName)} — OpenMotion</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;background:#111;color:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1rem;}
    main{background:#1c1c1e;border:1px solid #333;border-radius:12px;max-width:440px;width:100%;padding:24px;}
    h1{font-size:1.25rem;margin:0 0 8px;}
    p{color:#bbb;font-size:0.95rem;line-height:1.45;}
    ul{padding-left:20px;margin:12px 0 20px;}
    li{margin:4px 0;}
    .actions{display:flex;gap:12px;margin-top:20px;}
    button{flex:1;padding:10px 16px;border-radius:8px;border:1px solid #444;font-size:0.95rem;cursor:pointer;}
    .approve{background:#fff;color:#111;border-color:#fff;font-weight:600;}
    .deny{background:#2c2c2e;color:#f5f5f5;}
  </style>
</head>
<body>
  <main>
    <h1>Authorize ${escapeHtml(input.clientName)}</h1>
    <p>Grant MCP access to workspace <strong>${escapeHtml(input.workspaceName)}</strong> with these permissions:</p>
    <ul>${scopeList}</ul>
    <form method="POST" action="${escapeHtml(input.formAction)}">
      ${hiddenInputs}
      <div class="actions">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
      </div>
    </form>
  </main>
</body>
</html>`;
}
