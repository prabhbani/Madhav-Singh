import type { Prisma, AuditOutcome } from '@prisma/client';
import type { RequestHandler } from 'express';
import { auditService } from '../audit/auditService.js';
import { auditScopeWhere } from '../authz/scope.js';
import { currentScope } from '../middlewares/authorize.js';
import { pageResult, pagination } from '../utils/pagination.js';

/**
 * Audit trail read.
 *
 * A SUPER_ADMIN sees every row. A STATE_ADMIN sees rows whose actor belongs to
 * their own state, which is the narrowest honest scoping available: audit rows
 * record an action, not a geography, so the actor is what ties one to a state.
 */
export const list: RequestHandler = async (request, response) => {
  const scope = currentScope(request);
  const query = request.query as Record<string, unknown>;
  const { page, pageSize, skip, take } = pagination(query);

  const where: Prisma.AuditLogWhereInput = {
    AND: [
      auditScopeWhere(scope),
      {
        ...(typeof query.action === 'string' ? { action: query.action } : {}),
        ...(typeof query.resource === 'string' ? { resource: query.resource } : {}),
        ...(typeof query.outcome === 'string' ? { outcome: query.outcome as AuditOutcome } : {}),
        ...(typeof query.actorId === 'string' ? { actorId: query.actorId } : {}),
        ...(typeof query.resourceId === 'string' ? { resourceId: query.resourceId } : {}),
      },
    ],
  };

  const { items, total } = await auditService.list(where, skip, take);
  response.json(pageResult(items, total, page, pageSize));
};
