export const WORKSPACE_ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const AUTH_MODES = ['oidc', 'dev'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const AUTH_METHODS = [
  'session_cookie',
  'pat',
  'oauth_bearer',
  'oidc_jwt',
  'dev_bypass',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const PAT_SCOPES = [
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'exports:write',
  'media:generate',
  'mcp:tools',
  'workspace:admin',
] as const;
export type PatScope = (typeof PAT_SCOPES)[number];

export const DEFAULT_PAT_SCOPES: readonly PatScope[] = [
  'projects:read',
  'projects:write',
  'assets:read',
  'assets:write',
  'exports:write',
  'media:generate',
  'mcp:tools',
] as const;

export const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export interface AuthContext {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly scopes: readonly PatScope[];
  readonly authMode: AuthMode;
  readonly authMethod: AuthMethod;
  readonly externalWorkspaceId?: string | null;
  readonly sessionId?: string;
  readonly tokenId?: string;
  readonly email?: string | null;
  readonly displayName?: string;
}

export function hasScope(ctx: Pick<AuthContext, 'scopes' | 'role'>, required: PatScope): boolean {
  if (ctx.scopes.includes('workspace:admin')) return true;
  if (required === 'workspace:admin') {
    return ctx.role === 'owner' || ctx.role === 'admin';
  }
  return ctx.scopes.includes(required);
}

export function hasMinRole(ctx: Pick<AuthContext, 'role'>, minimum: WorkspaceRole): boolean {
  return ROLE_RANK[ctx.role] >= ROLE_RANK[minimum];
}
