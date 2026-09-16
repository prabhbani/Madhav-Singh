/**
 * Authentication.
 *
 * Three properties this implementation is built around:
 *
 *   1. Every failure looks the same. Same status, same message, and comparable
 *      work done, so a response cannot be used to learn whether an account
 *      exists, is locked, or simply has a different password.
 *   2. Repeated failures lock the account for a period. Per-address rate
 *      limiting alone does not stop a distributed attack on one account.
 *   3. Both outcomes are audited with the caller's address, because a run of
 *      failures against one account is exactly what an audit trail is for.
 */

import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { signToken } from '../middlewares/auth.js';
import { auditService } from '../audit/auditService.js';
import { permissionsFor } from '../authz/permissions.js';
import { resolveScope } from '../authz/scope.js';

/**
 * A real hash of a value nobody knows, compared against when no account matches.
 * Without it, an unknown email returns in a fraction of the time a known one
 * does, which is a reliable account-enumeration oracle.
 */
const DECOY_HASH = bcrypt.hashSync(randomBytes(32).toString('hex'), 12);

/** The single response every failed login produces. */
const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export const authService = {
  async login(request: Request, email: string, password: string) {
    const normalizedEmail = email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

    // Always spend the cost of one comparison, whether or not the account exists.
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DECOY_HASH);

    const now = new Date();
    const locked = user?.lockedUntil !== null && user?.lockedUntil !== undefined && user.lockedUntil > now;

    const fail = async (reason: string) => {
      if (user && !locked) {
        const failures = user.failedLoginCount + 1;
        const reachedLimit = failures >= env.LOGIN_MAX_FAILURES;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: reachedLimit ? 0 : failures,
            lockedUntil: reachedLimit ? new Date(now.getTime() + env.LOGIN_LOCKOUT_MINUTES * 60_000) : user.lockedUntil,
          },
        });
        if (reachedLimit) reason = `${reason}; account locked for ${env.LOGIN_LOCKOUT_MINUTES} minutes after ${env.LOGIN_MAX_FAILURES} failures`;
      }
      await auditService.record({
        action: 'AUTH_LOGIN_FAILURE',
        request,
        resourceId: user?.id ?? null,
        outcome: 'DENIED',
        reason,
        actor: { id: user?.id ?? null, email: normalizedEmail, role: user?.role ?? null },
      });
      // The caller learns only that the attempt failed.
      throw invalidCredentials();
    };

    if (!user) await fail('No account for this email');
    if (locked) await fail('Account is locked after repeated failures');
    if (!user!.active) await fail('Account is inactive');
    if (!passwordMatches) await fail('Incorrect password');

    const account = user!;
    await prisma.user.update({
      where: { id: account.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });

    const scope = resolveScope(account);
    await auditService.record({
      action: 'AUTH_LOGIN_SUCCESS',
      request,
      resourceId: account.id,
      actor: { id: account.id, email: account.email, role: account.role },
      after: { role: account.role, scopeLevel: scope.level },
    });

    return {
      token: signToken({
        sub: account.id,
        email: account.email,
        role: account.role,
        districtCode: account.districtCode ?? undefined,
        stateCode: account.stateCode ?? undefined,
        department: account.department ?? undefined,
      }),
      expiresIn: env.JWT_EXPIRES_IN,
      user: {
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        role: account.role,
        stateCode: account.stateCode,
        districtCode: account.districtCode,
        department: account.department,
      },
      scope: { level: scope.level, basis: scope.basis },
      permissions: permissionsFor(account.role),
    };
  },

  async logout(request: Request) {
    // Tokens are stateless and short-lived, so this records the intent rather
    // than revoking anything. See SECURITY.md for the accepted residual risk.
    await auditService.record({ action: 'AUTH_LOGOUT', request, resourceId: request.user?.id ?? null });
  },
};
