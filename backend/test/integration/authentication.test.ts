import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  TEST_PASSWORD,
  disconnect,
  resetDatabase,
  seedAccounts,
  skipUnlessIntegration,
  startHarness,
  type Harness,
} from '../helpers/integration.js';

/**
 * Authentication integration.
 *
 * Covers the login path end to end: credential checking, token issuing, the
 * audit rows both outcomes write, and the account lockout that a unit test
 * cannot reach because it lives in the database.
 */
describe('authentication', { skip: skipUnlessIntegration }, () => {
  let harness: Harness;
  let prisma: Awaited<typeof import('../../src/config/prisma.js')>['prisma'];
  let accounts: Awaited<ReturnType<typeof seedAccounts>>;

  before(async () => {
    ({ prisma } = await import('../../src/config/prisma.js'));
    await resetDatabase();
    accounts = await seedAccounts();
    harness = await startHarness();
  });

  after(async () => {
    await resetDatabase();
    await harness.close();
    await disconnect();
  });

  it('issues a token, the role, the scope, and the permissions on a correct password', async () => {
    const response = await harness.call<{
      token: string;
      user: { role: string };
      scope: { level: string };
      permissions: string[];
    }>('POST', '/api/v1/auth/login', {
      body: { email: 'district.officer@test.gov', password: TEST_PASSWORD },
    });
    assert.equal(response.status, 200);
    assert.ok(response.body.token.length > 20);
    assert.equal(response.body.user.role, 'DISTRICT_OFFICER');
    assert.equal(response.body.scope.level, 'DISTRICT');
    assert.ok(response.body.permissions.includes('projects:read'));
    assert.ok(!response.body.permissions.includes('auditLogs:read'));
  });

  it('never returns the password hash', async () => {
    const response = await harness.call('POST', '/api/v1/auth/login', {
      body: { email: 'viewer@test.gov', password: TEST_PASSWORD },
    });
    assert.doesNotMatch(JSON.stringify(response.body), /passwordHash|\$2[aby]\$/);
  });

  it('answers a wrong password and an unknown account identically', async () => {
    const wrongPassword = await harness.call<{ error: { code: string; message: string } }>('POST', '/api/v1/auth/login', {
      body: { email: 'viewer@test.gov', password: 'WrongPassword123' },
    });
    const unknownAccount = await harness.call<{ error: { code: string; message: string } }>('POST', '/api/v1/auth/login', {
      body: { email: 'nobody@test.gov', password: 'WrongPassword123' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownAccount.status, 401);
    assert.deepEqual(wrongPassword.body.error, unknownAccount.body.error);
  });

  it('audits both a success and a failure, with the caller address', async () => {
    await harness.call('POST', '/api/v1/auth/login', { body: { email: 'analyst@test.gov', password: TEST_PASSWORD } });
    await harness.call('POST', '/api/v1/auth/login', { body: { email: 'analyst@test.gov', password: 'WrongPassword123' } });

    const rows = await prisma.auditLog.findMany({
      where: { action: { in: ['AUTH_LOGIN_SUCCESS', 'AUTH_LOGIN_FAILURE'] }, actorEmail: 'analyst@test.gov' },
      orderBy: { occurredAt: 'asc' },
    });
    assert.ok(rows.length >= 2);
    const success = rows.find((row) => row.action === 'AUTH_LOGIN_SUCCESS');
    const failure = rows.find((row) => row.action === 'AUTH_LOGIN_FAILURE');
    assert.equal(success?.outcome, 'SUCCESS');
    assert.equal(failure?.outcome, 'DENIED');
    assert.ok(failure?.reason?.includes('password'));
    assert.ok(success?.ipAddress, 'authentication is an IP-recorded action');
  });

  it('locks an account after repeated failures, and still answers identically', async () => {
    const email = 'project.officer@test.gov';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await harness.call('POST', '/api/v1/auth/login', { body: { email, password: 'WrongPassword123' } });
    }
    const locked = await prisma.user.findUnique({ where: { email } });
    assert.ok(locked?.lockedUntil && locked.lockedUntil > new Date(), 'the account should be locked');

    // The correct password is now refused, with the same response as any failure.
    const afterLock = await harness.call<{ error: { code: string } }>('POST', '/api/v1/auth/login', {
      body: { email, password: TEST_PASSWORD },
    });
    assert.equal(afterLock.status, 401);
    assert.equal(afterLock.body.error.code, 'INVALID_CREDENTIALS');

    await prisma.user.update({ where: { email }, data: { lockedUntil: null, failedLoginCount: 0 } });
  });

  it('clears the failure counter on a successful login', async () => {
    const email = 'state.admin@test.gov';
    await harness.call('POST', '/api/v1/auth/login', { body: { email, password: 'WrongPassword123' } });
    assert.equal((await prisma.user.findUnique({ where: { email } }))?.failedLoginCount, 1);
    await harness.call('POST', '/api/v1/auth/login', { body: { email, password: TEST_PASSWORD } });
    const user = await prisma.user.findUnique({ where: { email } });
    assert.equal(user?.failedLoginCount, 0);
    assert.ok(user?.lastLoginAt);
  });

  it('refuses an inactive account', async () => {
    await prisma.user.update({ where: { email: 'viewer@test.gov' }, data: { active: false } });
    const response = await harness.call('POST', '/api/v1/auth/login', {
      body: { email: 'viewer@test.gov', password: TEST_PASSWORD },
    });
    assert.equal(response.status, 401);
    await prisma.user.update({ where: { email: 'viewer@test.gov' }, data: { active: true } });
  });

  it('refuses a request with no token, a malformed token, and a forged token', async () => {
    const forged = `${accounts.viewer!.token.slice(0, -6)}abcdef`;
    for (const options of [{}, { token: 'not-a-token' }, { token: forged }]) {
      const response = await harness.call<{ error: { code: string } }>('GET', '/api/v1/projects', options);
      assert.equal(response.status, 401, JSON.stringify(options));
    }
  });

  it('gives the same message for an expired token as for a forged one', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('../../src/config/env.js');
    const expired = jwt.sign({ sub: accounts.viewer!.id, email: accounts.viewer!.email, role: 'VIEWER' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '-1h',
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    const response = await harness.call<{ error: { code: string; message: string } }>('GET', '/api/v1/projects', {
      token: expired,
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_TOKEN');
  });

  it('refuses a token signed for a different audience or issuer', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { env } = await import('../../src/config/env.js');
    const wrongAudience = jwt.sign({ sub: accounts.viewer!.id, email: accounts.viewer!.email, role: 'VIEWER' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
      issuer: env.JWT_ISSUER,
      audience: 'some-other-service',
    });
    const response = await harness.call('GET', '/api/v1/projects', { token: wrongAudience });
    assert.equal(response.status, 401);
  });

  it('refuses a token that claims the "none" algorithm', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: accounts.superAdmin!.id, email: 'super.admin@test.gov', role: 'SUPER_ADMIN' }),
    ).toString('base64url');
    const response = await harness.call('GET', '/api/v1/projects', { token: `${header}.${payload}.` });
    assert.equal(response.status, 401);
  });

  it('returns the caller own session from the session endpoint', async () => {
    const response = await harness.call<{ user: { role: string }; scope: { level: string; districtCode: string | null } }>(
      'GET',
      '/api/v1/auth/me',
      { token: accounts.districtOfficer!.token },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.user.role, 'DISTRICT_OFFICER');
    assert.equal(response.body.scope.districtCode, 'Ludhiana');
  });

  it('records a logout', async () => {
    const response = await harness.call('POST', '/api/v1/auth/logout', { token: accounts.viewer!.token });
    assert.equal(response.status, 204);
    const row = await prisma.auditLog.findFirst({ where: { action: 'AUTH_LOGOUT', actorId: accounts.viewer!.id } });
    assert.ok(row);
  });
});
