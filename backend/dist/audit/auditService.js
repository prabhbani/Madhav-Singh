/**
 * Audit recording.
 *
 * Writes never throw into the request path: a failed audit write is logged and
 * the request continues. Losing an audit row is bad, but failing a legitimate
 * request because the audit table is unavailable is worse, and the failure is
 * itself logged for the operator.
 */
import { prisma } from '../config/prisma.js';
import { AUDIT_POLICY } from './auditPolicy.js';
import { normalizeIp, redact } from './redact.js';
/**
 * The caller's IP.
 *
 * `request.ip` already honours the app's configured trust-proxy setting, so a
 * spoofed `x-forwarded-for` from an untrusted hop is not used.
 */
export const clientIp = (request) => normalizeIp(request.ip ?? request.socket?.remoteAddress ?? null);
const asJson = (value) => redact(value);
export const auditService = {
    /** Records one audit row. Never rejects. */
    async record(entry) {
        const policy = AUDIT_POLICY[entry.action];
        const { request } = entry;
        const actor = entry.actor ?? request.user;
        try {
            await prisma.auditLog.create({
                data: {
                    actorId: actor?.id ?? null,
                    actorEmail: actor?.email ?? null,
                    actorRole: actor?.role ?? null,
                    action: entry.action,
                    resource: entry.resource ?? policy.resource,
                    tableName: policy.tableName,
                    resourceId: entry.resourceId ?? null,
                    requestId: request.requestId ?? null,
                    route: `${request.method} ${request.originalUrl ?? request.path}`.slice(0, 200),
                    ipAddress: policy.recordIp ? clientIp(request) : null,
                    outcome: entry.outcome ?? 'SUCCESS',
                    reason: entry.reason ?? null,
                    oldValues: asJson(entry.before),
                    newValues: asJson(entry.after),
                },
            });
        }
        catch (error) {
            request.log?.error({ err: error, action: entry.action }, 'audit write failed');
        }
    },
    /** Records a refused request, so denials are investigable. */
    async recordDenial(request, details) {
        await auditService.record({
            action: 'ACCESS_DENIED',
            request,
            resource: details.resource,
            resourceId: details.resourceId ?? null,
            outcome: 'DENIED',
            reason: details.reason,
            after: details.required ? { requiredPermissions: details.required } : undefined,
        });
    },
    /** Paged audit read, already narrowed to the caller's scope by the caller. */
    async list(where, skip, take) {
        const [rows, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                skip,
                take,
                orderBy: { occurredAt: 'desc' },
                include: { actor: { select: { id: true, displayName: true, role: true } } },
            }),
            prisma.auditLog.count({ where }),
        ]);
        return { items: rows.map((row) => ({ ...row, id: row.id.toString() })), total };
    },
};
