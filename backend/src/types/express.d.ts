import type { Role } from '@prisma/client';
import type { AccessScope } from '../authz/scope.js';
import type { LoadedSubject } from '../authz/subjects.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      log?: { error: (payload: unknown, message: string) => void };
      user?: { id: string; email: string; role: Role; districtCode?: string; stateCode?: string; department?: string };
      /** Resolved by `attachScope`, after authentication. */
      scope?: AccessScope;
      /** Set by `enforceScope`, so handlers do not reload the same row. */
      scopeSubject?: LoadedSubject;
      /** Captured by the audit middleware before a mutation runs. */
      auditBefore?: unknown;
    }
  }
}

export {};
