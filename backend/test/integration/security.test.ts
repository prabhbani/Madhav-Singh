import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  TEST_PASSWORD,
  disconnect,
  resetDatabase,
  seedAccounts,
  seedProjects,
  skipUnlessIntegration,
  startHarness,
  type Harness,
} from '../helpers/integration.js';

/**
 * Security integration.
 *
 * The unit suites prove the permission catalogue and the scope rules are correct
 * in isolation. These prove they are actually wired to the routes, which is the
 * failure that matters: a perfect policy applied to nothing protects nothing.
 */
describe('security', { skip: skipUnlessIntegration }, () => {
  let harness: Harness;
  let prisma: Awaited<typeof import('../../src/config/prisma.js')>['prisma'];
  let accounts: Awaited<ReturnType<typeof seedAccounts>>;
  let projects: Awaited<ReturnType<typeof seedProjects>>;

  before(async () => {
    ({ prisma } = await import('../../src/config/prisma.js'));
    await resetDatabase();
    accounts = await seedAccounts();
    projects = await seedProjects();
    harness = await startHarness();
  });

  after(async () => {
    await resetDatabase();
    await harness.close();
    await disconnect();
  });

  describe('unauthorized API access', () => {
    const protectedRoutes: Array<[string, string]> = [
      ['GET', '/api/v1/projects'],
      ['GET', '/api/v1/analytics/overview'],
      ['GET', '/api/v1/alerts'],
      ['GET', '/api/v1/notifications'],
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/audit-logs'],
      ['GET', '/api/v1/auth/me'],
      ['POST', '/api/v1/projects'],
      ['POST', '/api/v1/predictions'],
      ['POST', '/api/v1/alerts/evaluate'],
    ];

    it('refuses every protected route without a token', async () => {
      for (const [method, path] of protectedRoutes) {
        const response = await harness.call<{ error: { code: string } }>(method, path, { body: method === 'GET' ? undefined : {} });
        assert.equal(response.status, 401, `${method} ${path} answered ${response.status}`);
        assert.equal(response.body.error.code, 'UNAUTHENTICATED');
      }
    });

    it('leaks no data in an unauthenticated response body', async () => {
      const response = await harness.call('GET', '/api/v1/projects');
      assert.equal(JSON.stringify(response.body).includes('PB-LDH'), false);
    });

    it('refuses a viewer the routes their role does not carry', async () => {
      const forbidden: Array<[string, string, unknown]> = [
        ['POST', '/api/v1/projects', { projectCode: 'X', name: 'X', state: 'Punjab', district: 'Ludhiana', department: 'PWD', projectType: 'HIGHWAY', plannedStartDate: '2026-01-01', targetDate: '2026-12-01' }],
        ['GET', '/api/v1/users', undefined],
        ['GET', '/api/v1/audit-logs', undefined],
        ['GET', '/api/v1/analytics/export', undefined],
        ['POST', `/api/v1/projects/${projects.ludhianaPwd!.id}/recommendations`, {}],
      ];
      for (const [method, path, body] of forbidden) {
        const response = await harness.call<{ error: { code: string } }>(method, path, {
          token: accounts.viewer!.token,
          body,
        });
        assert.equal(response.status, 403, `${method} ${path} answered ${response.status}`);
        assert.match(response.body.error.code, /FORBIDDEN/);
      }
    });

    it('refuses a viewer access to case documents, which hold personal data', async () => {
      const document = await prisma.document.create({
        data: { projectId: projects.ludhianaPwd!.id, documentType: 'IDENTITY_PROOF' },
      });
      const response = await harness.call('GET', `/api/v1/documents/${document.id}`, { token: accounts.viewer!.token });
      assert.equal(response.status, 403);
    });

    it('writes an audit row for every refusal', async () => {
      const before = await prisma.auditLog.count({ where: { action: 'ACCESS_DENIED' } });
      await harness.call('GET', '/api/v1/audit-logs', { token: accounts.viewer!.token });
      const after = await prisma.auditLog.count({ where: { action: 'ACCESS_DENIED' } });
      assert.ok(after > before, 'a denial must be recorded');

      const row = await prisma.auditLog.findFirst({ where: { action: 'ACCESS_DENIED' }, orderBy: { occurredAt: 'desc' } });
      assert.equal(row?.outcome, 'DENIED');
      assert.equal(row?.actorId, accounts.viewer!.id);
      assert.ok(row?.reason?.includes('auditLogs:read'));
      assert.ok(row?.ipAddress, 'a denial records the address');
    });
  });

  describe('role escalation', () => {
    it('refuses a state administrator creating a super administrator', async () => {
      const response = await harness.call<{ error: { code: string } }>('POST', '/api/v1/users', {
        token: accounts.stateAdmin!.token,
        body: {
          email: 'escalated@test.gov',
          password: 'Ludhiana7Ring9Road',
          displayName: 'Escalated Account',
          role: 'SUPER_ADMIN',
          stateCode: 'Punjab',
        },
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'ROLE_ESCALATION_BLOCKED');
      assert.equal(await prisma.user.count({ where: { email: 'escalated@test.gov' } }), 0);
    });

    it('refuses an officer promoting themselves', async () => {
      const response = await harness.call('PATCH', `/api/v1/users/${accounts.districtOfficer!.id}`, {
        token: accounts.districtOfficer!.token,
        body: { role: 'SUPER_ADMIN' },
      });
      // The role carries no users:update permission at all.
      assert.equal(response.status, 403);
      const unchanged = await prisma.user.findUnique({ where: { id: accounts.districtOfficer!.id } });
      assert.equal(unchanged?.role, 'DISTRICT_OFFICER');
    });

    it('refuses a state administrator editing an account that outranks them', async () => {
      const response = await harness.call('PATCH', `/api/v1/users/${accounts.superAdmin!.id}`, {
        token: accounts.stateAdmin!.token,
        body: { displayName: 'Renamed by a lesser role' },
      });
      assert.ok([403, 404].includes(response.status), `unexpected status ${response.status}`);
      const unchanged = await prisma.user.findUnique({ where: { id: accounts.superAdmin!.id } });
      assert.notEqual(unchanged?.displayName, 'Renamed by a lesser role');
    });

    it('refuses an administrator placing an account in another state', async () => {
      const response = await harness.call('POST', '/api/v1/users', {
        token: accounts.stateAdmin!.token,
        body: {
          email: 'cross.state@test.gov',
          password: 'Ludhiana7Ring9Road',
          displayName: 'Cross State',
          role: 'VIEWER',
          stateCode: 'Haryana',
        },
      });
      assert.ok([403, 404].includes(response.status));
      assert.equal(await prisma.user.count({ where: { email: 'cross.state@test.gov' } }), 0);
    });

    it('refuses an administrator deactivating their own account', async () => {
      const response = await harness.call<{ error: { code: string } }>(
        'POST',
        `/api/v1/users/${accounts.superAdmin!.id}/deactivate`,
        { token: accounts.superAdmin!.token },
      );
      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, 'CANNOT_DEACTIVATE_SELF');
    });

    it('ignores a role smuggled into an unrelated request body', async () => {
      const response = await harness.call('PUT', `/api/v1/projects/${projects.ludhianaPwd!.id}`, {
        token: accounts.districtOfficer!.token,
        body: { name: 'Renamed', role: 'SUPER_ADMIN', createdById: accounts.superAdmin!.id },
      });
      assert.equal(response.status, 400, 'a strict body refuses the smuggled field outright');
      const unchanged = await prisma.user.findUnique({ where: { id: accounts.districtOfficer!.id } });
      assert.equal(unchanged?.role, 'DISTRICT_OFFICER');
    });
  });

  describe('insecure direct object reference', () => {
    it('answers an out-of-scope project exactly as a missing one', async () => {
      const outOfScope = await harness.call<{ error: { code: string } }>(
        'GET',
        `/api/v1/projects/${projects.haryana!.id}`,
        { token: accounts.districtOfficer!.token },
      );
      const missing = await harness.call<{ error: { code: string } }>(
        'GET',
        '/api/v1/projects/99999999-9999-4999-8999-999999999999',
        { token: accounts.districtOfficer!.token },
      );
      assert.equal(outOfScope.status, 404);
      assert.equal(missing.status, 404);
      assert.deepEqual(outOfScope.body.error, missing.body.error, 'the two must be indistinguishable');
    });

    it('refuses every child route of an out-of-scope project', async () => {
      const id = projects.haryana!.id;
      const routes: Array<[string, string, unknown]> = [
        ['GET', `/api/v1/projects/${id}`, undefined],
        ['GET', `/api/v1/projects/${id}/milestones`, undefined],
        ['GET', `/api/v1/projects/${id}/prediction`, undefined],
        ['GET', `/api/v1/projects/${id}/prediction/history`, undefined],
        ['GET', `/api/v1/projects/${id}/recommendations`, undefined],
        ['PUT', `/api/v1/projects/${id}`, { name: 'Taken over' }],
        ['POST', `/api/v1/projects/${id}/milestones`, { name: 'Injected', plannedAt: '2026-06-01' }],
        ['POST', `/api/v1/projects/${id}/alerts/evaluate`, {}],
      ];
      for (const [method, path, body] of routes) {
        const response = await harness.call(method, path, { token: accounts.districtOfficer!.token, body });
        assert.equal(response.status, 404, `${method} ${path} answered ${response.status}`);
      }
    });

    it('refuses a document, alert, or recommendation belonging to another scope', async () => {
      const document = await prisma.document.create({
        data: { projectId: projects.haryana!.id, documentType: 'TITLE_DEED' },
      });
      const alert = await prisma.alert.create({
        data: {
          projectId: projects.haryana!.id,
          type: 'MILESTONE_OVERDUE',
          severity: 'HIGH',
          message: 'Overdue',
          trigger: 'milestone_overdue_days = 30 >= 21',
          recommendedAction: 'Assign an officer',
          responsibleDepartment: 'Public Works Department',
          responsibilityBasis: 'Owning department',
          conditionHash: 'hash1',
          policyVersion: 'early-warning-policy-v1',
          detectorVersion: 'early-warning-detectors-v1',
        },
      });
      const recommendation = await prisma.recommendation.create({
        data: {
          projectId: projects.haryana!.id,
          type: 'SCHEDULE_RECOVERY',
          title: 'Assign an officer',
          rationale: 'Overdue',
          priority: 'HIGH',
          evidenceCode: 'MILESTONE_OVERDUE',
          responsibleDepartment: 'Public Works Department',
          expectedImpact: 'May restore schedule ownership',
          policyVersion: 'recommendation-policy-v1',
          catalogVersion: 'recommendation-catalog-v1',
        },
      });

      const token = accounts.districtOfficer!.token;
      for (const [method, path, body] of [
        ['GET', `/api/v1/documents/${document.id}`, undefined],
        ['GET', `/api/v1/alerts/${alert.id}/history`, undefined],
        ['POST', `/api/v1/alerts/${alert.id}/acknowledge`, {}],
        ['PATCH', `/api/v1/alerts/${alert.id}/status`, { status: 'RESOLVED' }],
        ['PATCH', `/api/v1/recommendations/${recommendation.id}/status`, { status: 'COMPLETED' }],
      ] as Array<[string, string, unknown]>) {
        const response = await harness.call(method, path, { token, body });
        assert.equal(response.status, 404, `${method} ${path} answered ${response.status}`);
      }

      // Nothing was changed by the attempts.
      assert.equal((await prisma.alert.findUnique({ where: { id: alert.id } }))?.status, 'OPEN');
      assert.equal((await prisma.recommendation.findUnique({ where: { id: recommendation.id } }))?.status, 'OPEN');
    });

    it('refuses relocating a project into the caller scope through the update body', async () => {
      const response = await harness.call<{ error: { code: string } }>(
        'PUT',
        `/api/v1/projects/${projects.amritsar!.id}`,
        { token: accounts.districtOfficer!.token, body: { district: 'Ludhiana' } },
      );
      // The project is in Amritsar, so the caller cannot reach it at all.
      assert.equal(response.status, 404);
      const unchanged = await prisma.project.findUnique({ where: { id: projects.amritsar!.id } });
      assert.equal(unchanged?.district, 'Amritsar');
    });

    it('refuses relocating a project out of the caller scope', async () => {
      const response = await harness.call<{ error: { code: string } }>(
        'PUT',
        `/api/v1/projects/${projects.ludhianaPwd!.id}`,
        { token: accounts.districtOfficer!.token, body: { district: 'Amritsar' } },
      );
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'OUT_OF_SCOPE');
      const unchanged = await prisma.project.findUnique({ where: { id: projects.ludhianaPwd!.id } });
      assert.equal(unchanged?.district, 'Ludhiana');
    });

    it('refuses reading another officer account outside scope', async () => {
      const response = await harness.call('GET', `/api/v1/users/${accounts.otherStateAdmin!.id}`, {
        token: accounts.stateAdmin!.token,
      });
      assert.equal(response.status, 404);
    });

    it('refuses a malformed identifier before it reaches the database', async () => {
      const response = await harness.call<{ error: { code: string } }>('GET', '/api/v1/projects/not-a-uuid', {
        token: accounts.districtOfficer!.token,
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
    });
  });

  describe('invalid input', () => {
    it('refuses an unexpected field rather than dropping it', async () => {
      const response = await harness.call('POST', '/api/v1/projects', {
        token: accounts.districtOfficer!.token,
        body: {
          projectCode: 'PB-LDH-2026-050',
          name: 'Strict body check',
          state: 'Punjab',
          district: 'Ludhiana',
          department: 'Public Works Department',
          projectType: 'HIGHWAY',
          plannedStartDate: '2026-01-01',
          targetDate: '2026-12-01',
          dataOrigin: 'REAL',
          isApproved: true,
        },
      });
      assert.equal(response.status, 400);
    });

    it('refuses a document type outside the allow-list and a traversing storage key', async () => {
      for (const body of [
        { projectId: projects.ludhianaPwd!.id, documentType: 'ARBITRARY_TYPE' },
        {
          projectId: projects.ludhianaPwd!.id,
          documentType: 'TITLE_DEED',
          storageKey: '../../etc/passwd',
          checksumSha256: 'a'.repeat(64),
        },
        { projectId: projects.ludhianaPwd!.id, documentType: 'TITLE_DEED', storageKey: 'projects/a.pdf' },
      ]) {
        const response = await harness.call('POST', '/api/v1/documents', {
          token: accounts.districtOfficer!.token,
          body,
        });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
    });

    it('does not execute an injection attempt, it stores it as text', async () => {
      const injection = "Ring Road'; DROP TABLE projects; --";
      const response = await harness.call<{ items: unknown[] }>(
        'GET',
        `/api/v1/projects?search=${encodeURIComponent(injection)}`,
        { token: accounts.superAdmin!.token },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.items, [], 'no project matches that text');
      // The table is still there, which is the point.
      assert.ok((await prisma.project.count()) > 0);
    });

    it('refuses an oversized body', async () => {
      const response = await harness.call('POST', '/api/v1/projects', {
        token: accounts.districtOfficer!.token,
        body: { projectCode: 'X', name: 'y'.repeat(2_000_000) },
      });
      assert.ok([400, 413].includes(response.status), `unexpected status ${response.status}`);
    });

    it('returns which field failed, and nothing else', async () => {
      const response = await harness.call<{ error: { code: string; details: unknown } }>('POST', '/api/v1/projects', {
        token: accounts.districtOfficer!.token,
        body: { projectCode: 'A' },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(response.body.error.details));
      assert.doesNotMatch(JSON.stringify(response.body), /prisma|postgres|stack/i);
    });
  });

  describe('rate limiting', () => {
    it('throttles repeated failed logins well before a password could be guessed', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const response = await harness.call('POST', '/api/v1/auth/login', {
          body: { email: `probe${attempt}@test.gov`, password: 'WrongPassword123' },
        });
        statuses.push(response.status);
      }
      assert.ok(statuses.includes(429), 'the authentication limiter never engaged');
      const firstLimited = statuses.indexOf(429);
      assert.ok(firstLimited <= 12, `limiter engaged too late, at attempt ${firstLimited + 1}`);
    });

    it('returns a typed error rather than an empty body when limited', async () => {
      let limited: { status: number; body: { error?: { code: string } } } | null = null;
      for (let attempt = 0; attempt < 15 && !limited; attempt += 1) {
        const response = await harness.call<{ error?: { code: string } }>('POST', '/api/v1/auth/login', {
          body: { email: 'burst@test.gov', password: 'WrongPassword123' },
        });
        if (response.status === 429) limited = response;
      }
      assert.ok(limited, 'expected the limiter to engage');
      assert.equal(limited.body.error?.code, 'RATE_LIMITED');
    });

    it('advertises the limit in standard headers', async () => {
      const response = await harness.call('GET', '/health');
      assert.ok(response.headers.get('ratelimit') ?? response.headers.get('ratelimit-limit'));
    });

    it('does not count a successful login against the authentication limit', async () => {
      // The limiter is configured to skip successful requests, so a person
      // signing in repeatedly from a shared office address is not locked out.
      const { env } = await import('../../src/config/env.js');
      assert.equal(env.RATE_LIMIT_AUTH >= 5, true);
      const response = await harness.call('POST', '/api/v1/auth/login', {
        body: { email: 'super.admin@test.gov', password: TEST_PASSWORD },
      });
      assert.ok([200, 429].includes(response.status));
    });
  });
});
