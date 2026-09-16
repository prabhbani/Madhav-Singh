/**
 * Geographic and departmental scope.
 *
 * Holding a permission answers "may this role do this at all". Scope answers
 * "may this user do it to this row". Both have to pass.
 *
 * The scope resolver fails closed. A role whose level requires a state or
 * district gets an empty scope when that assignment is missing, which matches no
 * rows at all. Granting wider access on missing data is the mistake this avoids.
 */
import { AppError } from '../errors/AppError.js';
/** The widest scope each role may ever hold. */
export const ROLE_SCOPE_LEVEL = {
    SUPER_ADMIN: 'GLOBAL',
    STATE_ADMIN: 'STATE',
    DISTRICT_OFFICER: 'DISTRICT',
    PROJECT_OFFICER: 'DEPARTMENT',
    ANALYST: 'STATE',
    VIEWER: 'STATE',
};
const clean = (value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
};
/**
 * User columns and project columns hold the same identifier space, so a casing
 * or padding difference must not silently deny a legitimate request.
 */
const sameValue = (left, right) => {
    const a = clean(left);
    const b = clean(right);
    return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
};
/** Resolves the effective scope for a user, narrowest of role level and assignment. */
export const resolveScope = (user) => {
    const level = ROLE_SCOPE_LEVEL[user.role];
    const stateCode = clean(user.stateCode);
    const districtCode = clean(user.districtCode);
    const department = clean(user.department);
    if (level === 'GLOBAL') {
        return { level: 'GLOBAL', basis: `${user.role} holds unrestricted scope.` };
    }
    if (level === 'STATE') {
        if (!stateCode) {
            return { level: 'NONE', basis: `${user.role} requires an assigned state; none is recorded on the account.` };
        }
        return { level: 'STATE', stateCode, basis: `${user.role} is scoped to the state "${stateCode}".` };
    }
    if (level === 'DISTRICT') {
        if (!districtCode) {
            return { level: 'NONE', basis: `${user.role} requires an assigned district; none is recorded on the account.` };
        }
        return {
            level: 'DISTRICT',
            districtCode,
            stateCode,
            basis: `${user.role} is scoped to the district "${districtCode}"${stateCode ? ` in "${stateCode}"` : ''}.`,
        };
    }
    // DEPARTMENT. The department is required; district and state narrow further.
    if (!department) {
        return { level: 'NONE', basis: `${user.role} requires an assigned department; none is recorded on the account.` };
    }
    return {
        level: 'DEPARTMENT',
        department,
        districtCode,
        stateCode,
        basis: `${user.role} is scoped to the department "${department}"${districtCode ? ` in district "${districtCode}"` : ''}.`,
    };
};
const insensitive = (value) => ({ equals: value, mode: 'insensitive' });
/**
 * A Prisma filter restricting a project query to the scope.
 *
 * A `NONE` scope returns a filter that matches nothing, so a misconfigured
 * account sees an empty list rather than the whole estate.
 */
export const projectScopeWhere = (scope) => {
    switch (scope.level) {
        case 'GLOBAL':
            return {};
        case 'STATE':
            return { state: insensitive(scope.stateCode) };
        case 'DISTRICT':
            return {
                district: insensitive(scope.districtCode),
                ...(scope.stateCode ? { state: insensitive(scope.stateCode) } : {}),
            };
        case 'DEPARTMENT':
            return {
                department: insensitive(scope.department),
                ...(scope.districtCode ? { district: insensitive(scope.districtCode) } : {}),
                ...(scope.stateCode ? { state: insensitive(scope.stateCode) } : {}),
            };
        default:
            return { id: { in: [] } };
    }
};
/** The same restriction expressed against a relation named `project`. */
export const nestedProjectScopeWhere = (scope) => scope.level === 'NONE' ? { id: { in: [] } } : { project: projectScopeWhere(scope) };
/** True when the subject row falls inside the scope. */
export const isInScope = (scope, subject) => {
    switch (scope.level) {
        case 'GLOBAL':
            return true;
        case 'STATE':
            return sameValue(scope.stateCode, subject.state);
        case 'DISTRICT':
            return (sameValue(scope.districtCode, subject.district) &&
                (scope.stateCode === undefined || sameValue(scope.stateCode, subject.state)));
        case 'DEPARTMENT':
            return (sameValue(scope.department, subject.department) &&
                (scope.districtCode === undefined || sameValue(scope.districtCode, subject.district)) &&
                (scope.stateCode === undefined || sameValue(scope.stateCode, subject.state)));
        default:
            return false;
    }
};
/**
 * Throws 403 when the subject is outside scope.
 *
 * The message names the scope but never the out-of-scope row's attributes, so a
 * denial cannot be used to probe for records the caller may not see.
 */
export const assertInScope = (scope, subject, resource) => {
    if (isInScope(scope, subject))
        return;
    throw new AppError(403, 'OUT_OF_SCOPE', `This ${resource} is outside your assigned scope`, { scope: scope.basis });
};
/** Scope applied to audit-log reads: a state admin sees actors in their state. */
export const auditScopeWhere = (scope) => {
    if (scope.level === 'GLOBAL')
        return {};
    if (scope.stateCode)
        return { actor: { stateCode: insensitive(scope.stateCode) } };
    return { id: { in: [] } };
};
/**
 * Checks scope-bearing fields supplied in a request body.
 *
 * Used on create and update. `enforceScope` validates the row as it currently
 * stands, which is not enough on an update: a body that rewrites `state`,
 * `district`, or `department` would move the row somewhere the caller has no
 * authority over, and the pre-change check would still have passed. Only fields
 * actually present are checked, so a partial update of unrelated fields is not
 * refused.
 */
export const assertBodyFieldsInScope = (scope, fields, resource) => {
    if (scope.level === 'GLOBAL')
        return;
    if (scope.level === 'NONE') {
        throw new AppError(403, 'OUT_OF_SCOPE', `You have no assigned scope for this ${resource}`, { scope: scope.basis });
    }
    const refuse = (field) => {
        throw new AppError(403, 'OUT_OF_SCOPE', `The requested ${field} is outside your assigned scope`, { scope: scope.basis });
    };
    const state = clean(fields.state);
    if (state !== undefined && scope.stateCode !== undefined && !sameValue(scope.stateCode, state))
        refuse('state');
    const district = clean(fields.district);
    // A state-level role may place a row in any district of its own state, so the
    // district is only constrained when the scope itself names one.
    if (district !== undefined && scope.districtCode !== undefined && !sameValue(scope.districtCode, district))
        refuse('district');
    const department = clean(fields.department);
    if (department !== undefined && scope.department !== undefined && !sameValue(scope.department, department)) {
        refuse('department');
    }
};
