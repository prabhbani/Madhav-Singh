/**
 * Authorization middleware.
 *
 * Three independent gates, applied in order on every protected route:
 *
 *   1. `requireRole`       — coarse role check, for routes reserved to a role.
 *   2. `requirePermission` — the permission the route needs, from the catalogue.
 *   3. `enforceScope`      — the row being touched is inside the caller's scope.
 *
 * This is the security boundary. The frontend hides what a role cannot use, but
 * nothing there is trusted; a request that reaches here is authorized here or
 * not at all. Every refusal is written to the audit log before it is returned.
 */
import { AppError } from '../errors/AppError.js';
import { auditService } from '../audit/auditService.js';
import { permissionsFor, roleHasAnyPermission, roleHasPermission } from '../authz/permissions.js';
import { assertBodyFieldsInScope, isInScope, resolveScope } from '../authz/scope.js';
import { loadSubject } from '../authz/subjects.js';
/** Records the refusal, then raises it. Denials are audited before they return. */
const deny = async (request, error, details) => {
    await auditService.recordDenial(request, details);
    return error;
};
/** Resolves the caller's scope once and attaches it to the request. */
export const attachScope = (request, _response, next) => {
    if (!request.user)
        return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
    request.scope = resolveScope(request.user);
    next();
};
export const currentScope = (request) => {
    if (!request.scope)
        throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
    return request.scope;
};
/** Coarse role gate, for routes reserved to specific roles. */
export const requireRole = (...roles) => (request, _response, next) => {
    const user = request.user;
    if (!user)
        return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
    if (roles.includes(user.role))
        return next();
    void deny(request, new AppError(403, 'FORBIDDEN_ROLE', 'Your role is not permitted to perform this action'), { reason: `Role ${user.role} is not one of ${roles.join(', ')}`, required: roles }).then(next).catch(next);
};
/** Requires every listed permission. */
export const requirePermission = (...permissions) => (request, _response, next) => {
    const user = request.user;
    if (!user)
        return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
    const missing = permissions.filter((permission) => !roleHasPermission(user.role, permission));
    if (missing.length === 0)
        return next();
    void deny(request, new AppError(403, 'FORBIDDEN_PERMISSION', 'You do not have permission to perform this action'), { reason: `Role ${user.role} is missing ${missing.join(', ')}`, required: permissions }).then(next).catch(next);
};
/** Requires at least one of the listed permissions. */
export const requireAnyPermission = (...permissions) => (request, _response, next) => {
    const user = request.user;
    if (!user)
        return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication is required'));
    if (roleHasAnyPermission(user.role, permissions))
        return next();
    void deny(request, new AppError(403, 'FORBIDDEN_PERMISSION', 'You do not have permission to perform this action'), { reason: `Role ${user.role} holds none of ${permissions.join(', ')}`, required: permissions }).then(next).catch(next);
};
const readPath = (request, path) => {
    const [section, key] = path.split('.');
    const container = request[section];
    const value = container?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
};
/**
 * Loads the target row and refuses when it falls outside the caller's scope.
 *
 * A row that exists but is out of scope and a row that does not exist both
 * return their own status, but neither response repeats the row's attributes, so
 * a denial cannot be used to probe for records the caller may not see.
 */
export const enforceScope = (kind, options = {}) => (request, _response, next) => {
    const from = options.from ?? 'params.id';
    const resource = options.resource ?? (kind === 'milestone' ? 'cases' : `${kind}s`);
    void (async () => {
        try {
            const user = request.user;
            if (!user)
                throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
            const scope = currentScope(request);
            const id = readPath(request, from);
            if (!id) {
                if (options.optional)
                    return next();
                throw await deny(request, new AppError(400, 'RESOURCE_ID_REQUIRED', `A ${kind} identifier is required for this request`), { reason: `No identifier found at ${from}`, resource });
            }
            const subject = await loadSubject(kind, id);
            const notFound = new AppError(404, 'RESOURCE_NOT_FOUND', `The requested ${kind} was not found`);
            if (!subject)
                throw notFound;
            if (!isInScope(scope, subject)) {
                // A row that exists but is out of scope answers exactly as a row that
                // does not exist. Returning 403 here would confirm the identifier is
                // real, which is all an attacker walking identifiers needs. The true
                // reason is recorded in the audit log, where it belongs.
                throw await deny(request, notFound, {
                    reason: `${kind} ${id} exists but is outside scope: ${scope.basis}`,
                    resource,
                    resourceId: subject.resourceId,
                });
            }
            // Handlers and audit middleware reuse the loaded row rather than
            // querying for the same scope attributes a second time.
            request.scopeSubject = subject;
            next();
        }
        catch (error) {
            next(error);
        }
    })();
};
/**
 * Scope check for the scope-bearing fields of a request body.
 *
 * Needed on create, where there is no existing row to load, and on update, where
 * loading the existing row proves only where it is now and not where the body is
 * trying to move it.
 */
export const enforceScopeOnBody = (resource, options = {}) => (request, _response, next) => {
    void (async () => {
        try {
            const scope = currentScope(request);
            const body = (request.body ?? {});
            const read = (key) => (typeof body[key] === 'string' ? body[key] : undefined);
            const fields = { state: read('state'), district: read('district'), department: read('department') };
            if (options.required && scope.level !== 'GLOBAL' && !fields.state && !fields.district && !fields.department) {
                throw await deny(request, new AppError(400, 'SCOPE_FIELDS_REQUIRED', 'The request must state where this record belongs'), { reason: 'Create request omitted every scope-bearing field', resource });
            }
            try {
                assertBodyFieldsInScope(scope, fields, resource);
            }
            catch (scopeError) {
                throw await deny(request, scopeError, {
                    reason: `Request body places the ${resource} outside scope: ${scope.basis}`,
                    resource,
                    resourceId: request.scopeSubject?.resourceId ?? null,
                });
            }
            next();
        }
        catch (error) {
            next(error);
        }
    })();
};
/** The caller's own session: role, scope, and effective permissions. */
export const sessionSummary = (request) => {
    const user = request.user;
    if (!user)
        throw new AppError(401, 'UNAUTHENTICATED', 'Authentication is required');
    const scope = currentScope(request);
    return {
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            stateCode: user.stateCode ?? null,
            districtCode: user.districtCode ?? null,
            department: user.department ?? null,
        },
        scope: { level: scope.level, stateCode: scope.stateCode ?? null, districtCode: scope.districtCode ?? null, department: scope.department ?? null, basis: scope.basis },
        permissions: permissionsFor(user.role),
    };
};
