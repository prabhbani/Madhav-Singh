/**
 * Audit middleware.
 *
 * Wraps a mutating route so the audit row reflects what actually happened:
 *
 *   1. Before the handler runs, optionally load the row being changed, giving
 *      the "before" snapshot.
 *   2. Capture the response body the handler sends, giving the "after" snapshot.
 *   3. When the response finishes, write one row recording the actor, action,
 *      resource, resource id, timestamp, route, and outcome.
 *
 * The row is written on completion rather than on entry, so a request that fails
 * validation or authorization is not recorded as a successful change. Failures
 * are still recorded, with outcome `FAILED`.
 */
import { AUDIT_POLICY } from '../audit/auditPolicy.js';
import { auditService } from '../audit/auditService.js';
import { loadSubject } from '../authz/subjects.js';
import { prisma } from '../config/prisma.js';
const readPath = (request, path) => {
    const [section, key] = path.split('.');
    const container = request[section];
    const value = container?.[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
};
/** Full row for the "before" snapshot, rather than only its scope columns. */
const loadBefore = async (subject, id) => {
    switch (subject) {
        case 'project':
            return prisma.project.findUnique({ where: { id } });
        case 'milestone':
            return prisma.milestone.findUnique({ where: { id } });
        case 'document':
            return prisma.document.findUnique({ where: { id } });
        case 'alert':
            return prisma.alert.findUnique({ where: { id } });
        case 'recommendation':
            return prisma.recommendation.findUnique({ where: { id } });
        default:
            return null;
    }
};
const defaultIdFromResponse = (body) => {
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
        const id = body.id;
        if (typeof id === 'string')
            return id;
    }
    return undefined;
};
/** Records one audited action around a route handler. */
export const audit = (action, options = {}) => (request, response, next) => {
    const policy = AUDIT_POLICY[action];
    const idFrom = options.idFrom ?? 'params.id';
    void (async () => {
        const requestId = readPath(request, idFrom);
        if (policy.captureBefore && options.subject && requestId) {
            try {
                request.auditBefore = await loadBefore(options.subject, requestId);
            }
            catch (error) {
                // A missing "before" must not block the request; the row records the
                // gap rather than the audit failing the action.
                request.log?.error({ err: error, action }, 'audit before-snapshot failed');
            }
        }
        captureAndRecord(action, request, response, requestId, options);
        next();
    })();
};
const captureAndRecord = (action, request, response, requestId, options) => {
    let captured;
    const originalJson = response.json.bind(response);
    response.json = (body) => {
        captured = body;
        return originalJson(body);
    };
    response.on('finish', () => {
        const failed = response.statusCode >= 400;
        // A 401 or 403 is recorded by the authorization layer as ACCESS_DENIED, so
        // recording it here as well would double-count the same refusal.
        if (response.statusCode === 401 || response.statusCode === 403)
            return;
        const resolvedId = requestId ??
            (options.idFromResponse ? options.idFromResponse(captured) : defaultIdFromResponse(captured)) ??
            request.scopeSubject?.resourceId ??
            null;
        void auditService.record({
            action,
            request,
            resourceId: resolvedId,
            outcome: failed ? 'FAILED' : 'SUCCESS',
            reason: failed ? `Request failed with status ${response.statusCode}` : null,
            before: request.auditBefore,
            after: failed ? undefined : captured,
        });
    });
};
/**
 * Records an action with no response body worth keeping, such as a bulk sweep.
 * The handler calls it directly instead of wrapping the route.
 */
export const auditNow = auditService.record;
export { loadSubject };
