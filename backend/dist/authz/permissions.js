/**
 * Permission catalogue and role matrix.
 *
 * This is the single source of truth for what each role may do. Routes reference
 * permissions, never roles, so widening a role is a change to one table here
 * rather than a hunt through the router.
 *
 * The frontend mirrors this file for menu and route hiding. That mirror is a
 * usability convenience only. Every permission is enforced again on the server,
 * which is the security boundary.
 */
export const AUTHZ_POLICY_VERSION = 'authz-policy-v1';
/** The eight governed resources, plus recommendations for the action queue. */
export const RESOURCES = [
    'projects',
    'cases',
    'documents',
    'predictions',
    'analytics',
    'alerts',
    'recommendations',
    'users',
    'auditLogs',
];
/**
 * Every permission in the system, as `resource:action`.
 *
 * `cases` covers the per-case workflow records. In the operational schema those
 * are the milestone rows hanging off a project; the permission name is kept at
 * the domain level so it still applies when the full case entity lands.
 */
export const PERMISSIONS = [
    'projects:read',
    'projects:create',
    'projects:update',
    'projects:delete',
    'cases:read',
    'cases:create',
    'cases:update',
    'cases:delete',
    'documents:read',
    'documents:create',
    'documents:update',
    'documents:delete',
    'predictions:read',
    'predictions:create',
    'analytics:read',
    'analytics:export',
    'alerts:read',
    'alerts:acknowledge',
    'alerts:manage',
    'alerts:evaluate',
    'recommendations:read',
    'recommendations:generate',
    'recommendations:manage',
    'users:read',
    'users:create',
    'users:update',
    'users:deactivate',
    'auditLogs:read',
    'auditLogs:export',
];
const ALL_PERMISSIONS = PERMISSIONS;
/**
 * Role matrix, least privilege first.
 *
 * Two choices worth stating:
 *
 *  - VIEWER has no `documents:read`. Case documents hold landowner records and
 *    personal details; a read-only observer gets case status and aggregates,
 *    not the personal file.
 *  - Only SUPER_ADMIN and STATE_ADMIN read audit logs, and STATE_ADMIN is
 *    additionally narrowed to actors in their own state by the scope layer.
 */
export const ROLE_PERMISSIONS = {
    SUPER_ADMIN: ALL_PERMISSIONS,
    STATE_ADMIN: [
        'projects:read',
        'projects:create',
        'projects:update',
        'projects:delete',
        'cases:read',
        'cases:create',
        'cases:update',
        'cases:delete',
        'documents:read',
        'documents:create',
        'documents:update',
        'documents:delete',
        'predictions:read',
        'predictions:create',
        'analytics:read',
        'analytics:export',
        'alerts:read',
        'alerts:acknowledge',
        'alerts:manage',
        'alerts:evaluate',
        'recommendations:read',
        'recommendations:generate',
        'recommendations:manage',
        'users:read',
        'users:create',
        'users:update',
        'users:deactivate',
        'auditLogs:read',
    ],
    DISTRICT_OFFICER: [
        'projects:read',
        'projects:create',
        'projects:update',
        'cases:read',
        'cases:create',
        'cases:update',
        'cases:delete',
        'documents:read',
        'documents:create',
        'documents:update',
        'documents:delete',
        'predictions:read',
        'predictions:create',
        'analytics:read',
        'alerts:read',
        'alerts:acknowledge',
        'alerts:manage',
        'alerts:evaluate',
        'recommendations:read',
        'recommendations:generate',
        'recommendations:manage',
        'users:read',
    ],
    PROJECT_OFFICER: [
        'projects:read',
        'projects:update',
        'cases:read',
        'cases:create',
        'cases:update',
        'documents:read',
        'documents:create',
        'documents:update',
        'predictions:read',
        'predictions:create',
        'analytics:read',
        'alerts:read',
        'alerts:acknowledge',
        'recommendations:read',
        'recommendations:generate',
    ],
    ANALYST: [
        'projects:read',
        'cases:read',
        'documents:read',
        'predictions:read',
        'predictions:create',
        'analytics:read',
        'analytics:export',
        'alerts:read',
        'recommendations:read',
    ],
    VIEWER: ['projects:read', 'cases:read', 'predictions:read', 'analytics:read', 'alerts:read', 'recommendations:read'],
};
const PERMISSION_SETS = new Map(Object.keys(ROLE_PERMISSIONS).map((role) => [role, new Set(ROLE_PERMISSIONS[role])]));
/** True when the role holds the permission. Unknown roles are denied. */
export const roleHasPermission = (role, permission) => PERMISSION_SETS.get(role)?.has(permission) ?? false;
export const roleHasAllPermissions = (role, permissions) => permissions.every((permission) => roleHasPermission(role, permission));
export const roleHasAnyPermission = (role, permissions) => permissions.some((permission) => roleHasPermission(role, permission));
export const permissionsFor = (role) => ROLE_PERMISSIONS[role] ?? [];
/** The catalogue as a matrix, for the API and for documentation. */
export const permissionMatrix = () => ({
    policyVersion: AUTHZ_POLICY_VERSION,
    resources: RESOURCES,
    permissions: PERMISSIONS,
    roles: Object.fromEntries(Object.keys(ROLE_PERMISSIONS).map((role) => [role, ROLE_PERMISSIONS[role]])),
});
