import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  disconnect,
  resetDatabase,
  seedAccounts,
  seedProjects,
  skipUnlessIntegration,
  startHarness,
  type Harness,
} from '../helpers/integration.js';

/**
 * API integration.
 *
 * Drives the real routes over HTTP: the full middleware chain, the Prisma
 * queries behind each handler, the scope filters applied in SQL, and the audit
 * rows the mutating routes write.
 */
describe('api', { skip: skipUnlessIntegration }, () => {
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

  describe('health and shape', () => {
    it('answers the health probe without a token', async () => {
      const response = await harness.call<{ status: string }>('GET', '/health');
      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'ok');
    });

    it('returns a request id on every response, for audit correlation', async () => {
      const response = await harness.call('GET', '/health');
      assert.ok(response.headers.get('x-request-id'));
    });

    it('answers an unknown route without echoing the path back', async () => {
      const response = await harness.call<{ error: { message: string } }>('GET', '/api/v1/no-such-route-xyz');
      assert.equal(response.status, 404);
      assert.doesNotMatch(response.body.error.message, /no-such-route-xyz/);
    });

    it('refuses a body that is not JSON', async () => {
      const response = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=a@b.gov&password=x',
      });
      assert.equal(response.status, 415);
    });

    it('sends the expected security headers', async () => {
      const response = await harness.call('GET', '/health');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);
      assert.equal(response.headers.get('x-powered-by'), null);
    });
  });

  describe('projects', () => {
    it('lists only the projects inside the caller scope', async () => {
      const district = await harness.call<{ items: Array<{ projectCode: string }> }>('GET', '/api/v1/projects', {
        token: accounts.districtOfficer!.token,
      });
      assert.equal(district.status, 200);
      const codes = district.body.items.map((item) => item.projectCode).sort();
      assert.deepEqual(codes, ['PB-LDH-2026-001', 'PB-LDH-2026-002'], 'Ludhiana only');

      const state = await harness.call<{ items: unknown[] }>('GET', '/api/v1/projects', {
        token: accounts.stateAdmin!.token,
      });
      assert.equal(state.body.items.length, 3, 'all of Punjab');

      const superAdmin = await harness.call<{ items: unknown[] }>('GET', '/api/v1/projects', {
        token: accounts.superAdmin!.token,
      });
      assert.equal(superAdmin.body.items.length, 4, 'every state');
    });

    it('narrows a project officer to their own department', async () => {
      const response = await harness.call<{ items: Array<{ projectCode: string }> }>('GET', '/api/v1/projects', {
        token: accounts.projectOfficer!.token,
      });
      assert.deepEqual(
        response.body.items.map((item) => item.projectCode),
        ['PB-LDH-2026-001'],
      );
    });

    it('creates a project and writes an audit row naming the actor', async () => {
      const response = await harness.call<{ id: string; projectCode: string }>('POST', '/api/v1/projects', {
        token: accounts.districtOfficer!.token,
        body: {
          projectCode: 'PB-LDH-2026-010',
          name: 'Ludhiana Northern Link',
          state: 'Punjab',
          district: 'Ludhiana',
          department: 'Public Works Department',
          projectType: 'HIGHWAY',
          plannedStartDate: '2026-02-01',
          targetDate: '2026-11-01',
        },
      });
      assert.equal(response.status, 201);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PROJECT_CREATE', resourceId: response.body.id },
      });
      assert.ok(audit, 'the create should be audited');
      assert.equal(audit.actorId, accounts.districtOfficer!.id);
      assert.equal(audit.outcome, 'SUCCESS');
      assert.equal(audit.resource, 'projects');
      assert.equal(audit.ipAddress, null, 'an ordinary write does not record the address');
    });

    it('records the previous values when a project is updated', async () => {
      const id = projects.ludhianaPwd!.id;
      const response = await harness.call('PUT', `/api/v1/projects/${id}`, {
        token: accounts.districtOfficer!.token,
        body: { name: 'Ludhiana Ring Road Phase II-A' },
      });
      assert.equal(response.status, 200);

      const audit = await prisma.auditLog.findFirst({
        where: { action: 'PROJECT_UPDATE', resourceId: id },
        orderBy: { occurredAt: 'desc' },
      });
      const before = audit?.oldValues as { name?: string } | null;
      const after = audit?.newValues as { name?: string } | null;
      assert.equal(before?.name, 'Ludhiana Ring Road Phase II');
      assert.equal(after?.name, 'Ludhiana Ring Road Phase II-A');
    });

    it('archives rather than deleting, so the operational record survives', async () => {
      const created = await harness.call<{ id: string }>('POST', '/api/v1/projects', {
        token: accounts.stateAdmin!.token,
        body: {
          projectCode: 'PB-LDH-2026-011',
          name: 'To be archived',
          state: 'Punjab',
          district: 'Ludhiana',
          department: 'Public Works Department',
          projectType: 'HIGHWAY',
          plannedStartDate: '2026-02-01',
          targetDate: '2026-11-01',
        },
      });
      const response = await harness.call('DELETE', `/api/v1/projects/${created.body.id}`, {
        token: accounts.stateAdmin!.token,
      });
      assert.equal(response.status, 200);
      const row = await prisma.project.findUnique({ where: { id: created.body.id } });
      assert.equal(row?.status, 'CANCELLED', 'the row is still there');
    });
  });

  describe('cases and documents', () => {
    it('creates a milestone under a project in scope', async () => {
      const response = await harness.call<{ id: string }>('POST', `/api/v1/projects/${projects.ludhianaPwd!.id}/milestones`, {
        token: accounts.districtOfficer!.token,
        body: { name: 'Section 19 declaration', plannedAt: '2026-06-01', ownerDept: 'Land Acquisition Cell' },
      });
      assert.equal(response.status, 201);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'CASE_MILESTONE_CREATE' } });
      assert.equal(audit?.resource, 'cases');
    });

    it('never returns the object-store key for a document', async () => {
      const created = await harness.call<{ id: string }>('POST', '/api/v1/documents', {
        token: accounts.districtOfficer!.token,
        body: {
          projectId: projects.ludhianaPwd!.id,
          documentType: 'TITLE_DEED',
          storageKey: 'projects/2026/pb-ldh-001/title-deed.pdf',
          checksumSha256: 'a'.repeat(64),
        },
      });
      assert.equal(created.status, 201);
      assert.equal(JSON.stringify(created.body).includes('storageKey'), false);

      const fetched = await harness.call('GET', `/api/v1/documents/${created.body.id}`, {
        token: accounts.districtOfficer!.token,
      });
      assert.equal(JSON.stringify(fetched.body).includes('storageKey'), false);
    });

    it('audits a document read with the caller address, because it is personal data', async () => {
      const audit = await prisma.auditLog.findFirst({ where: { action: 'DOCUMENT_READ' }, orderBy: { occurredAt: 'desc' } });
      assert.ok(audit);
      assert.ok(audit.ipAddress, 'a document read records the address');
    });
  });

  describe('analytics and alerts', () => {
    it('scopes an aggregate, not only a list', async () => {
      const district = await harness.call<{ projects: number }>('GET', '/api/v1/analytics/overview', {
        token: accounts.districtOfficer!.token,
      });
      const superAdmin = await harness.call<{ projects: number }>('GET', '/api/v1/analytics/overview', {
        token: accounts.superAdmin!.token,
      });
      assert.ok(district.body.projects < superAdmin.body.projects, 'a district count must not equal the national one');
    });

    it('evaluates alerts for a project and stores what the engine decided', async () => {
      const response = await harness.call<{ alerts: unknown[]; summary: { evaluatedDetectors: number } }>(
        'POST',
        `/api/v1/projects/${projects.ludhianaPwd!.id}/alerts/evaluate`,
        { token: accounts.districtOfficer!.token, body: { notify: false } },
      );
      assert.equal(response.status, 201);
      assert.equal(response.body.summary.evaluatedDetectors, 11);
      const stored = await prisma.alert.count({ where: { projectId: projects.ludhianaPwd!.id } });
      assert.equal(stored, response.body.alerts.length);
    });

    it('does not re-notify an unchanged condition on a second evaluation', async () => {
      const path = `/api/v1/projects/${projects.ludhianaWater!.id}/alerts/evaluate`;
      const first = await harness.call<{ notifications: unknown[] }>('POST', path, {
        token: accounts.districtOfficer!.token,
        body: { notify: false },
      });
      const second = await harness.call<{ notifications: unknown[]; alerts: Array<{ decision: string }> }>('POST', path, {
        token: accounts.districtOfficer!.token,
        body: { notify: false },
      });
      assert.equal(second.body.notifications.length, 0);
      if (first.body.notifications.length > 0) {
        assert.ok(second.body.alerts.every((alert) => alert.decision === 'UNCHANGED'));
      }
    });

    it('acknowledges an alert and appends an immutable history row', async () => {
      const alert = await prisma.alert.findFirst({ where: { projectId: projects.ludhianaPwd!.id } });
      if (!alert) return;
      const response = await harness.call('POST', `/api/v1/alerts/${alert.id}/acknowledge`, {
        token: accounts.districtOfficer!.token,
        body: { note: 'Reviewed at the weekly meeting' },
      });
      assert.equal(response.status, 200);

      const history = await harness.call<{ events: Array<{ eventType: string; note: string | null }> }>(
        'GET',
        `/api/v1/alerts/${alert.id}/history`,
        { token: accounts.districtOfficer!.token },
      );
      assert.ok(history.body.events.some((event) => event.eventType === 'ACKNOWLEDGED'));
    });
  });

  describe('recommendations', () => {
    it('generates and stores ranked actions', async () => {
      const response = await harness.call<{ recommendations: Array<{ rank: number; evidence: { code: string } }> }>(
        'POST',
        `/api/v1/projects/${projects.ludhianaPwd!.id}/recommendations`,
        { token: accounts.districtOfficer!.token, body: { horizonDays: 90 } },
      );
      assert.equal(response.status, 201);
      const stored = await prisma.recommendation.findMany({ where: { projectId: projects.ludhianaPwd!.id } });
      assert.equal(stored.length, response.body.recommendations.length);
      for (const row of stored) assert.ok(row.evidenceCode.length > 0);
    });

    it('does not reset a status an officer set when regenerating', async () => {
      const stored = await prisma.recommendation.findFirst({ where: { projectId: projects.ludhianaPwd!.id } });
      if (!stored) return;
      await harness.call('PATCH', `/api/v1/recommendations/${stored.id}/status`, {
        token: accounts.districtOfficer!.token,
        body: { status: 'IN_PROGRESS' },
      });
      await harness.call('POST', `/api/v1/projects/${projects.ludhianaPwd!.id}/recommendations`, {
        token: accounts.districtOfficer!.token,
        body: { horizonDays: 90 },
      });
      const after = await prisma.recommendation.findUnique({ where: { id: stored.id } });
      assert.equal(after?.status, 'IN_PROGRESS');
    });
  });

  describe('audit trail', () => {
    it('is readable by an administrator and records that it was read', async () => {
      const response = await harness.call<{ items: unknown[] }>('GET', '/api/v1/audit-logs', {
        token: accounts.superAdmin!.token,
      });
      assert.equal(response.status, 200);
      assert.ok(response.body.items.length > 0);
      const row = await prisma.auditLog.findFirst({ where: { action: 'AUDIT_LOG_READ' } });
      assert.ok(row, 'reading the trail is itself audited');
    });

    it('never contains a password hash or a token', async () => {
      const rows = await prisma.auditLog.findMany({ take: 200 });
      const serialized = JSON.stringify(rows);
      assert.doesNotMatch(serialized, /\$2[aby]\$/, 'a bcrypt hash reached the audit table');
      assert.doesNotMatch(serialized, /eyJhbGciOi/, 'a JWT reached the audit table');
    });

    it('narrows a state administrator to actors in their own state', async () => {
      const response = await harness.call<{ items: Array<{ actorId: string | null }> }>('GET', '/api/v1/audit-logs', {
        token: accounts.stateAdmin!.token,
      });
      assert.equal(response.status, 200);
      const punjabIds = new Set(
        [accounts.stateAdmin, accounts.districtOfficer, accounts.projectOfficer, accounts.analyst, accounts.viewer].map(
          (account) => account!.id,
        ),
      );
      for (const item of response.body.items) {
        if (item.actorId) assert.ok(punjabIds.has(item.actorId), 'an out-of-state actor appeared in the trail');
      }
    });
  });
});
