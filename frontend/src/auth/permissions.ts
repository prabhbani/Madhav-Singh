/**
 * Mirror of the backend permission catalogue.
 *
 * THIS IS NOT A SECURITY BOUNDARY. It exists so the interface does not offer a
 * person a button that the server will refuse. Anyone can edit what runs in a
 * browser, so every permission here is checked again on the server, and the
 * server's answer is the only one that decides anything.
 *
 * Keep this file in step with `backend/src/authz/permissions.ts`. The live
 * matrix is served at `GET /api/v1/authz/permissions`, and the session endpoint
 * `GET /api/v1/auth/me` returns the caller's effective permissions, which take
 * precedence over this table whenever the API is reachable.
 */

export const ROLES = ['SUPER_ADMIN', 'STATE_ADMIN', 'DISTRICT_OFFICER', 'PROJECT_OFFICER', 'ANALYST', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'projects:read', 'projects:create', 'projects:update', 'projects:delete',
  'cases:read', 'cases:create', 'cases:update', 'cases:delete',
  'documents:read', 'documents:create', 'documents:update', 'documents:delete',
  'predictions:read', 'predictions:create',
  'analytics:read', 'analytics:export',
  'alerts:read', 'alerts:acknowledge', 'alerts:manage', 'alerts:evaluate',
  'recommendations:read', 'recommendations:generate', 'recommendations:manage',
  'users:read', 'users:create', 'users:update', 'users:deactivate',
  'auditLogs:read', 'auditLogs:export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  STATE_ADMIN: [
    'projects:read', 'projects:create', 'projects:update', 'projects:delete',
    'cases:read', 'cases:create', 'cases:update', 'cases:delete',
    'documents:read', 'documents:create', 'documents:update', 'documents:delete',
    'predictions:read', 'predictions:create',
    'analytics:read', 'analytics:export',
    'alerts:read', 'alerts:acknowledge', 'alerts:manage', 'alerts:evaluate',
    'recommendations:read', 'recommendations:generate', 'recommendations:manage',
    'users:read', 'users:create', 'users:update', 'users:deactivate',
    'auditLogs:read',
  ],
  DISTRICT_OFFICER: [
    'projects:read', 'projects:create', 'projects:update',
    'cases:read', 'cases:create', 'cases:update', 'cases:delete',
    'documents:read', 'documents:create', 'documents:update', 'documents:delete',
    'predictions:read', 'predictions:create',
    'analytics:read',
    'alerts:read', 'alerts:acknowledge', 'alerts:manage', 'alerts:evaluate',
    'recommendations:read', 'recommendations:generate', 'recommendations:manage',
    'users:read',
  ],
  PROJECT_OFFICER: [
    'projects:read', 'projects:update',
    'cases:read', 'cases:create', 'cases:update',
    'documents:read', 'documents:create', 'documents:update',
    'predictions:read', 'predictions:create',
    'analytics:read',
    'alerts:read', 'alerts:acknowledge',
    'recommendations:read', 'recommendations:generate',
  ],
  ANALYST: [
    'projects:read', 'cases:read', 'documents:read',
    'predictions:read', 'predictions:create',
    'analytics:read', 'analytics:export',
    'alerts:read', 'recommendations:read',
  ],
  VIEWER: ['projects:read', 'cases:read', 'predictions:read', 'analytics:read', 'alerts:read', 'recommendations:read'],
};

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super administrator',
  STATE_ADMIN: 'State administrator',
  DISTRICT_OFFICER: 'District officer',
  PROJECT_OFFICER: 'Project officer',
  ANALYST: 'Analyst',
  VIEWER: 'Viewer',
};

export const SCOPE_LABELS: Record<string, string> = {
  GLOBAL: 'All states',
  STATE: 'State',
  DISTRICT: 'District',
  DEPARTMENT: 'Department',
  NONE: 'No scope assigned',
};

export const permissionsForRole = (role: Role): readonly Permission[] => ROLE_PERMISSIONS[role] ?? [];
