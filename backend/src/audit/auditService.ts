/**
 * Audit recording.
 *
 * Writes never throw into the request path: a failed audit write is logged and
 * the request continues. Losing an audit row is bad, but failing a legitimate
 * request because the audit table is unavailable is worse, and the failure is
 * itself logged for the operator.
 */

import { Prisma, type AuditOutcome, type Role } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from '../config/prisma.js';
import { AUDIT_POLICY, type AuditActionName } from './auditPolicy.js';
import { normalizeIp, redact } from './redact.js';
import type { Resource } from '../authz/permissions.js';

/**
 * The caller's IP.
 *
 * `request.ip` already honours the app's configured trust-proxy setting, so a
 * spoofed `x-forwarded-for` from an untrusted hop is not used.
 */
export const clientIp = (request: Request): string | null =>
  normalizeIp(request.ip ?? request.socket?.remoteAddress ?? null);

const asJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  redact(value) as Prisma.InputJsonValue | undefined;

export type AuditEntry = {
  action: AuditActionName;
  request: Request;
  resourceId?: string | null;
  outcome?: AuditOutcome;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** Overrides the policy's resource, used by the generic denial recorder. */
  resource?: Resource;
  actor?: { id?: string | null; email?: string | null; role?: Role | null };
};

export const auditService = {
  /** Records one audit row. Never rejects. */
  async record(entry: AuditEntry): Promise<void> {
    const policy = AUDIT_POLICY[entry.action];
    const { request } = entry;
    const actor = entry.actor ?? request.user;
    try {
      await prisma.auditLog.create({
        data: {
          actorId: actor?.id ?? null,
          actorEmail: actor?.email ?? null,
          actorRole: (actor?.role as Role | undefined) ?? null,
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
    } catch (error) {
      request.log?.error({ err: error, action: entry.action }, 'audit write failed');
    }
  },

  /** Records a refused request, so denials are investigable. */
  async recordDenial(
    request: Request,
    details: { reason: string; resource?: Resource; resourceId?: string | null; required?: readonly string[] },
  ): Promise<void> {
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
  async list(where: Prisma.AuditLogWhereInput, skip: number, take: number) {
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
