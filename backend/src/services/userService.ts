/**
 * User administration.
 *
 * Two rules beyond ordinary permission checks:
 *
 *   1. Privilege escalation is blocked. An administrator may only assign a role
 *      at or below their own level, so a STATE_ADMIN cannot mint a SUPER_ADMIN
 *      and cannot promote anyone past themselves.
 *   2. Scope applies to people as well as projects. A STATE_ADMIN administers
 *      accounts inside their own state only, and cannot move an account out of
 *      that state.
 */

import bcrypt from 'bcryptjs';
import { Prisma, type Role } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/AppError.js';
import type { AccessScope } from '../authz/scope.js';

/** Ranked so an actor can never assign a role above their own. */
const ROLE_RANK: Record<Role, number> = {
  SUPER_ADMIN: 5,
  STATE_ADMIN: 4,
  DISTRICT_OFFICER: 3,
  PROJECT_OFFICER: 2,
  ANALYST: 1,
  VIEWER: 0,
};

const PUBLIC_FIELDS = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  stateCode: true,
  districtCode: true,
  department: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export const assignableRoles = (actorRole: Role): Role[] =>
  (Object.keys(ROLE_RANK) as Role[]).filter((role) => ROLE_RANK[role] <= ROLE_RANK[actorRole]);

const assertAssignable = (actorRole: Role, targetRole: Role): void => {
  if (ROLE_RANK[targetRole] > ROLE_RANK[actorRole]) {
    throw new AppError(403, 'ROLE_ESCALATION_BLOCKED', 'You cannot assign a role above your own', {
      assignable: assignableRoles(actorRole),
    });
  }
};

/** Restricts the account list to the administrator's own scope. */
const userScopeWhere = (scope: AccessScope): Prisma.UserWhereInput => {
  switch (scope.level) {
    case 'GLOBAL':
      return {};
    case 'STATE':
      return { stateCode: { equals: scope.stateCode!, mode: 'insensitive' } };
    case 'DISTRICT':
      return { districtCode: { equals: scope.districtCode!, mode: 'insensitive' } };
    case 'DEPARTMENT':
      return { department: { equals: scope.department!, mode: 'insensitive' } };
    default:
      return { id: { in: [] } };
  }
};

/** An administrator may not place an account outside their own scope. */
/**
 * An account outside the administrator's scope is reported as not found, for the
 * same reason as every other resource: a 403 would confirm the identifier is a
 * real account.
 */
const assertTargetInScope = (scope: AccessScope, target: { stateCode?: string | null; districtCode?: string | null }): void => {
  if (scope.level === 'GLOBAL') return;
  const matchesState =
    scope.stateCode === undefined || target.stateCode?.trim().toLowerCase() === scope.stateCode.toLowerCase();
  const matchesDistrict =
    scope.level !== 'DISTRICT' ||
    target.districtCode?.trim().toLowerCase() === scope.districtCode?.toLowerCase();
  if (!matchesState || !matchesDistrict) {
    throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
  }
};

export const userService = {
  async list(scope: AccessScope, query: Record<string, unknown>) {
    const page = Math.max(1, Number(query.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 25)));
    const where: Prisma.UserWhereInput = {
      ...userScopeWhere(scope),
      ...(typeof query.role === 'string' ? { role: query.role as Role } : {}),
      ...(query.active === 'false' ? { active: false } : query.active === 'true' ? { active: true } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.user.findMany({ where, select: PUBLIC_FIELDS, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.user.count({ where }),
    ]);
    return { items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  },

  async get(scope: AccessScope, id: string) {
    const user = await prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
    assertTargetInScope(scope, user);
    return user;
  },

  async create(scope: AccessScope, actorRole: Role, data: {
    email: string;
    password: string;
    displayName: string;
    role: Role;
    stateCode?: string;
    districtCode?: string;
    department?: string;
  }) {
    assertAssignable(actorRole, data.role);
    // A scoped administrator creates accounts inside their own scope by default.
    const stateCode = data.stateCode ?? scope.stateCode;
    const districtCode = data.districtCode ?? scope.districtCode;
    assertTargetInScope(scope, { stateCode, districtCode });

    const email = data.email.toLowerCase();
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      throw new AppError(409, 'EMAIL_IN_USE', 'An account already exists for this email');
    }
    return prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(data.password, 12),
        displayName: data.displayName,
        role: data.role,
        stateCode: stateCode ?? null,
        districtCode: districtCode ?? null,
        department: data.department ?? scope.department ?? null,
      },
      select: PUBLIC_FIELDS,
    });
  },

  async update(scope: AccessScope, actorRole: Role, id: string, data: Partial<{
    displayName: string;
    role: Role;
    stateCode: string;
    districtCode: string;
    department: string;
    active: boolean;
  }>) {
    const existing = await prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!existing) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
    assertTargetInScope(scope, existing);
    // Both the current role and the requested role must be within reach, so an
    // administrator cannot edit an account more privileged than their own.
    assertAssignable(actorRole, existing.role);
    if (data.role) assertAssignable(actorRole, data.role);
    assertTargetInScope(scope, {
      stateCode: data.stateCode ?? existing.stateCode,
      districtCode: data.districtCode ?? existing.districtCode,
    });
    return prisma.user.update({ where: { id }, data, select: PUBLIC_FIELDS });
  },

  async deactivate(scope: AccessScope, actorRole: Role, actorId: string, id: string) {
    if (actorId === id) throw new AppError(409, 'CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    const existing = await prisma.user.findUnique({ where: { id }, select: PUBLIC_FIELDS });
    if (!existing) throw new AppError(404, 'USER_NOT_FOUND', 'User was not found');
    assertTargetInScope(scope, existing);
    assertAssignable(actorRole, existing.role);
    return prisma.user.update({ where: { id }, data: { active: false }, select: PUBLIC_FIELDS });
  },
};
