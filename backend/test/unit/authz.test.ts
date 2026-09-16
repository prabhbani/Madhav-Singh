import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Role } from '@prisma/client';

import {
  PERMISSIONS,
  RESOURCES,
  ROLE_PERMISSIONS,
  permissionMatrix,
  permissionsFor,
  roleHasAllPermissions,
  roleHasAnyPermission,
  roleHasPermission,
  type Permission,
} from '../../src/authz/permissions.js';
import {
  ROLE_SCOPE_LEVEL,
  assertInScope,
  auditScopeWhere,
  isInScope,
  nestedProjectScopeWhere,
  projectScopeWhere,
  resolveScope,
} from '../../src/authz/scope.js';
import { assignableRoles } from '../../src/services/userService.js';

const ROLES: Role[] = ['SUPER_ADMIN', 'STATE_ADMIN', 'DISTRICT_OFFICER', 'PROJECT_OFFICER', 'ANALYST', 'VIEWER'];

const setOf = (role: Role) => new Set<Permission>(permissionsFor(role));

describe('permission catalogue', () => {
  it('defines a permission set for every role', () => {
    for (const role of ROLES) {
      assert.ok(Array.isArray(ROLE_PERMISSIONS[role]), `${role} has no permission set`);
    }
    assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), [...ROLES].sort());
  });

  it('uses only catalogued permissions in every role', () => {
    const catalogue = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      for (const permission of permissionsFor(role)) {
        assert.ok(catalogue.has(permission), `${role} references unknown permission ${permission}`);
      }
    }
  });

  it('names a permission for every governed resource', () => {
    for (const resource of RESOURCES) {
      assert.ok(
        PERMISSIONS.some((permission) => permission.startsWith(`${resource}:`)),
        `no permission defined for resource ${resource}`,
      );
    }
  });

  it('grants every permission to SUPER_ADMIN and nothing beyond it to anyone else', () => {
    assert.equal(setOf('SUPER_ADMIN').size, PERMISSIONS.length);
    for (const role of ROLES) {
      assert.ok(roleHasAllPermissions('SUPER_ADMIN', permissionsFor(role)));
    }
  });

  it('nests the officer roles, each strictly inside the next', () => {
    const chain: Role[] = ['PROJECT_OFFICER', 'DISTRICT_OFFICER', 'STATE_ADMIN', 'SUPER_ADMIN'];
    for (let index = 0; index < chain.length - 1; index += 1) {
      const narrower = chain[index]!;
      const wider = chain[index + 1]!;
      for (const permission of permissionsFor(narrower)) {
        assert.ok(roleHasPermission(wider, permission), `${wider} should include ${permission} from ${narrower}`);
      }
      assert.ok(setOf(wider).size > setOf(narrower).size, `${wider} should be strictly wider than ${narrower}`);
    }
  });

  it('keeps VIEWER read-only and away from personal case documents', () => {
    for (const permission of permissionsFor('VIEWER')) {
      assert.ok(permission.endsWith(':read'), `VIEWER should not hold ${permission}`);
    }
    assert.equal(roleHasPermission('VIEWER', 'documents:read'), false);
    assert.ok(roleHasAllPermissions('ANALYST', permissionsFor('VIEWER')), 'VIEWER is a subset of ANALYST');
  });

  it('keeps ANALYST out of every write path except creating a prediction', () => {
    const writes = permissionsFor('ANALYST').filter((permission) => !permission.endsWith(':read'));
    assert.deepEqual([...writes].sort(), ['analytics:export', 'predictions:create']);
  });

  it('restricts audit access to the two administrator roles', () => {
    for (const role of ROLES) {
      const expected = role === 'SUPER_ADMIN' || role === 'STATE_ADMIN';
      assert.equal(roleHasPermission(role, 'auditLogs:read'), expected, `${role} auditLogs:read`);
    }
    for (const role of ROLES) {
      assert.equal(roleHasPermission(role, 'auditLogs:export'), role === 'SUPER_ADMIN');
    }
  });

  it('restricts user administration to the administrator roles', () => {
    for (const role of ROLES) {
      const expected = role === 'SUPER_ADMIN' || role === 'STATE_ADMIN';
      assert.equal(roleHasPermission(role, 'users:create'), expected, `${role} users:create`);
      assert.equal(roleHasPermission(role, 'users:deactivate'), expected, `${role} users:deactivate`);
    }
  });

  it('answers any-permission and all-permission checks independently', () => {
    assert.equal(roleHasAnyPermission('VIEWER', ['projects:read', 'projects:delete']), true);
    assert.equal(roleHasAllPermissions('VIEWER', ['projects:read', 'projects:delete']), false);
  });

  it('denies an unknown role rather than defaulting open', () => {
    assert.equal(roleHasPermission('NOT_A_ROLE' as Role, 'projects:read'), false);
    assert.deepEqual(permissionsFor('NOT_A_ROLE' as Role), []);
  });

  it('publishes a matrix covering every role and resource', () => {
    const matrix = permissionMatrix();
    assert.deepEqual(Object.keys(matrix.roles).sort(), [...ROLES].sort());
    assert.equal(matrix.permissions.length, PERMISSIONS.length);
  });
});

describe('route wiring', () => {
  // Catches a typo in a route's permission string, which would otherwise fail
  // open at the type level only if the literal happened to still be valid.
  it('uses only catalogued permissions in the router', () => {
    const source = readFileSync(new URL('../../src/routes/index.ts', import.meta.url), 'utf8');
    const catalogue = new Set<string>(PERMISSIONS);
    const used = [...source.matchAll(/requirePermission\(([^)]*)\)/g)]
      .flatMap((match) => [...match[1]!.matchAll(/'([^']+)'/g)].map((inner) => inner[1]!));
    assert.ok(used.length > 20, 'expected the router to declare permissions on many routes');
    for (const permission of used) {
      assert.ok(catalogue.has(permission), `router references unknown permission ${permission}`);
    }
  });

  it('protects every mutating route with a permission', () => {
    const source = readFileSync(new URL('../../src/routes/index.ts', import.meta.url), 'utf8');
    // Split on router verb calls, keeping each call's full argument list.
    const calls = source.split(/router\.(get|post|put|patch|delete)\(/).slice(1);
    const mutations: string[] = [];
    for (let index = 0; index < calls.length; index += 2) {
      const verb = calls[index]!;
      const body = calls[index + 1]!;
      if (verb === 'get') continue;
      const path = body.match(/^\s*'([^']+)'/)?.[1] ?? '(unknown)';
      if (path === '/auth/login' || path === '/auth/logout') continue;
      mutations.push(path);
      assert.match(body, /requirePermission\(/, `mutating route ${verb.toUpperCase()} ${path} declares no permission`);
    }
    assert.ok(mutations.length >= 10, 'expected several mutating routes to check');
  });

  it('audits every mutating route that changes stored state', () => {
    const source = readFileSync(new URL('../../src/routes/index.ts', import.meta.url), 'utf8');
    const calls = source.split(/router\.(get|post|put|patch|delete)\(/).slice(1);
    for (let index = 0; index < calls.length; index += 2) {
      const verb = calls[index]!;
      const body = calls[index + 1]!;
      if (verb === 'get') continue;
      const path = body.match(/^\s*'([^']+)'/)?.[1] ?? '(unknown)';
      if (path === '/auth/login' || path === '/auth/logout') continue;
      assert.match(body, /audit\('/, `mutating route ${verb.toUpperCase()} ${path} records no audit action`);
    }
  });
});

describe('scope resolution', () => {
  it('gives SUPER_ADMIN unrestricted scope', () => {
    const scope = resolveScope({ role: 'SUPER_ADMIN' });
    assert.equal(scope.level, 'GLOBAL');
    assert.deepEqual(projectScopeWhere(scope), {});
  });

  it('caps every other role below global', () => {
    for (const role of ROLES.filter((entry) => entry !== 'SUPER_ADMIN')) {
      assert.notEqual(ROLE_SCOPE_LEVEL[role], 'GLOBAL', `${role} must not hold global scope`);
    }
  });

  it('scopes a state role to its assigned state', () => {
    const scope = resolveScope({ role: 'STATE_ADMIN', stateCode: 'Punjab' });
    assert.equal(scope.level, 'STATE');
    assert.deepEqual(projectScopeWhere(scope), { state: { equals: 'Punjab', mode: 'insensitive' } });
  });

  it('scopes a district role to its district and state', () => {
    const scope = resolveScope({ role: 'DISTRICT_OFFICER', stateCode: 'Punjab', districtCode: 'Ludhiana' });
    assert.equal(scope.level, 'DISTRICT');
    assert.deepEqual(projectScopeWhere(scope), {
      district: { equals: 'Ludhiana', mode: 'insensitive' },
      state: { equals: 'Punjab', mode: 'insensitive' },
    });
  });

  it('scopes a project officer to a department', () => {
    const scope = resolveScope({
      role: 'PROJECT_OFFICER',
      stateCode: 'Punjab',
      districtCode: 'Ludhiana',
      department: 'Public Works Department',
    });
    assert.equal(scope.level, 'DEPARTMENT');
    assert.equal(scope.department, 'Public Works Department');
  });

  it('fails closed when the required assignment is missing', () => {
    for (const user of [
      { role: 'STATE_ADMIN' as Role },
      { role: 'DISTRICT_OFFICER' as Role, stateCode: 'Punjab' },
      { role: 'PROJECT_OFFICER' as Role, districtCode: 'Ludhiana' },
      { role: 'ANALYST' as Role },
      { role: 'VIEWER' as Role },
    ]) {
      const scope = resolveScope(user);
      assert.equal(scope.level, 'NONE', `${user.role} without its assignment must resolve to NONE`);
      assert.deepEqual(projectScopeWhere(scope), { id: { in: [] } }, 'an empty scope must match no rows');
      assert.match(scope.basis, /requires an assigned/);
    }
  });

  it('treats blank assignments as missing rather than as a wildcard', () => {
    const scope = resolveScope({ role: 'STATE_ADMIN', stateCode: '   ' });
    assert.equal(scope.level, 'NONE');
  });
});

describe('scope validation', () => {
  const state = resolveScope({ role: 'STATE_ADMIN', stateCode: 'Punjab' });
  const district = resolveScope({ role: 'DISTRICT_OFFICER', stateCode: 'Punjab', districtCode: 'Ludhiana' });
  const department = resolveScope({
    role: 'PROJECT_OFFICER',
    stateCode: 'Punjab',
    districtCode: 'Ludhiana',
    department: 'Public Works Department',
  });
  const inside = { state: 'Punjab', district: 'Ludhiana', department: 'Public Works Department' };

  it('admits a row inside scope at every level', () => {
    assert.equal(isInScope(resolveScope({ role: 'SUPER_ADMIN' }), inside), true);
    assert.equal(isInScope(state, inside), true);
    assert.equal(isInScope(district, inside), true);
    assert.equal(isInScope(department, inside), true);
  });

  it('refuses a row in another state, district, or department', () => {
    assert.equal(isInScope(state, { ...inside, state: 'Haryana' }), false);
    assert.equal(isInScope(district, { ...inside, district: 'Amritsar' }), false);
    assert.equal(isInScope(department, { ...inside, department: 'Water Resources' }), false);
  });

  it('compares identifiers case-insensitively so a legitimate request is not denied', () => {
    assert.equal(isInScope(state, { ...inside, state: '  punjab ' }), true);
    assert.equal(isInScope(district, { ...inside, district: 'LUDHIANA' }), true);
  });

  it('refuses everything for an empty scope', () => {
    const none = resolveScope({ role: 'VIEWER' });
    assert.equal(isInScope(none, inside), false);
  });

  it('raises a 403 that names the scope but not the row', () => {
    assert.throws(
      () => assertInScope(district, { ...inside, district: 'Amritsar' }, 'project'),
      (error: unknown) => {
        const failure = error as { statusCode: number; code: string; message: string };
        assert.equal(failure.statusCode, 403);
        assert.equal(failure.code, 'OUT_OF_SCOPE');
        assert.doesNotMatch(failure.message, /Amritsar/, 'a denial must not echo the out-of-scope row');
        return true;
      },
    );
  });

  it('nests the same restriction for related tables', () => {
    assert.deepEqual(nestedProjectScopeWhere(state), { project: { state: { equals: 'Punjab', mode: 'insensitive' } } });
    assert.deepEqual(nestedProjectScopeWhere(resolveScope({ role: 'VIEWER' })), { id: { in: [] } });
  });

  it('narrows the audit trail to the administrator own state', () => {
    assert.deepEqual(auditScopeWhere(resolveScope({ role: 'SUPER_ADMIN' })), {});
    assert.deepEqual(auditScopeWhere(state), { actor: { stateCode: { equals: 'Punjab', mode: 'insensitive' } } });
    assert.deepEqual(auditScopeWhere(resolveScope({ role: 'VIEWER' })), { id: { in: [] } });
  });
});

describe('privilege escalation', () => {
  it('lets an administrator assign only roles at or below their own', () => {
    assert.deepEqual(assignableRoles('SUPER_ADMIN').sort(), [...ROLES].sort());
    assert.equal(assignableRoles('STATE_ADMIN').includes('SUPER_ADMIN'), false);
    assert.equal(assignableRoles('DISTRICT_OFFICER').includes('STATE_ADMIN'), false);
    assert.deepEqual(assignableRoles('VIEWER'), ['VIEWER']);
  });

  it('always includes the actor own role', () => {
    for (const role of ROLES) assert.ok(assignableRoles(role).includes(role));
  });
});
