import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAllowedOrigins } from '../../src/config/cors.js';
import {
  DOCUMENT_TYPES,
  alertStatus,
  auditLogList,
  documentCreate,
  login,
  milestoneUpdate,
  projectCreate,
  projectList,
  projectUpdate,
  recommendationGenerate,
  userCreate,
} from '../../src/validators/schemas.js';
import { assertBodyFieldsInScope, resolveScope } from '../../src/authz/scope.js';

/** Built at runtime so no literal control character appears in this file. */
const control = (code: number) => String.fromCharCode(code);

const UUID = '11111111-1111-4111-8111-111111111111';

/** Supplies a valid route parameter so a body assertion fails on the body alone. */
const body = <T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T } }, value: unknown) =>
  schema.safeParse({ params: { id: UUID }, query: {}, body: value });

const validProject = {
  projectCode: 'NH-2026-014',
  name: 'Ring Road Phase II',
  state: 'Punjab',
  district: 'Ludhiana',
  department: 'Public Works Department',
  projectType: 'HIGHWAY',
  plannedStartDate: '2026-01-01',
  targetDate: '2026-12-01',
};

describe('cross-origin allow-list', () => {
  it('accepts an explicit https origin and a local development origin', () => {
    assert.deepEqual(parseAllowedOrigins('https://portal.example.gov'), ['https://portal.example.gov']);
    assert.deepEqual(parseAllowedOrigins('http://localhost:3000'), ['http://localhost:3000']);
    assert.equal(parseAllowedOrigins('https://a.example.gov, https://b.example.gov').length, 2);
  });

  it('refuses a wildcard, because this API sends credentials', () => {
    assert.throws(() => parseAllowedOrigins('*'), /must not be/);
    assert.throws(() => parseAllowedOrigins('https://a.example.gov,*'), /must not be/);
  });

  it('refuses plain http outside local development', () => {
    assert.throws(() => parseAllowedOrigins('http://portal.example.gov'), /must use https/);
  });

  it('refuses an empty list or a malformed entry', () => {
    assert.throws(() => parseAllowedOrigins(''), /at least one origin/);
    assert.throws(() => parseAllowedOrigins('portal.example.gov'), /invalid origin/);
  });

  it('refuses an origin carrying a path, which would widen the match', () => {
    assert.throws(() => parseAllowedOrigins('https://portal.example.gov/app'), /bare origin/);
  });
});

describe('text input validation', () => {
  it('rejects control characters that could forge a log line or a terminal escape', () => {
    for (const code of [0, 7, 10, 13, 27, 127]) {
      const result = body(projectCreate, { ...validProject, name: `Ring${control(code)}Road` });
      assert.equal(result.success, false, `control character ${code} must be rejected`);
    }
  });

  it('rejects markup characters in a geographic identifier', () => {
    const result = body(projectCreate, { ...validProject, district: '<script>alert(1)</script>' });
    assert.equal(result.success, false);
  });

  it('accepts ordinary place names, including punctuation and non-Latin script', () => {
    for (const district of ['Ludhiana', "Sant Ravidas Nagar", 'Y.S.R. Kadapa', 'लुधियाना']) {
      assert.equal(body(projectCreate, { ...validProject, district }).success, true, district);
    }
  });

  it('enforces length bounds', () => {
    assert.equal(body(projectCreate, { ...validProject, name: 'x'.repeat(241) }).success, false);
    assert.equal(body(projectCreate, { ...validProject, name: 'x' }).success, false);
  });
});

describe('strict bodies', () => {
  it('refuses an unexpected field rather than silently dropping it', () => {
    assert.equal(body(projectCreate, { ...validProject, isAdmin: true }).success, false);
    assert.equal(body(alertStatus, { status: 'RESOLVED', severity: 'CRITICAL' }).success, false);
    assert.equal(body(milestoneUpdate, { name: 'Award', createdById: 'x' }).success, false);
    assert.equal(
      body(userCreate, { email: 'a@example.gov', password: 'CorrectHorse1', displayName: 'A B', role: 'VIEWER', active: true })
        .success,
      false,
    );
  });

  it('refuses an attempt to set a server-controlled field', () => {
    assert.equal(body(projectUpdate, { createdById: UUID }).success, false);
    assert.equal(body(recommendationGenerate, { horizonDays: 90, policyVersion: 'forged' }).success, false);
  });

  it('accepts a legitimate partial update', () => {
    assert.equal(body(projectUpdate, { name: 'Ring Road Phase III' }).success, true);
  });
});

describe('document metadata', () => {
  const base = { projectId: UUID, documentType: 'TITLE_DEED' };
  const digest = 'a'.repeat(64);

  it('accepts only allow-listed document types', () => {
    assert.equal(body(documentCreate, { ...base, documentType: 'MALWARE_PAYLOAD' }).success, false);
    for (const documentType of DOCUMENT_TYPES) {
      assert.equal(body(documentCreate, { ...base, documentType }).success, true, documentType);
    }
  });

  it('refuses a storage key that traverses, escapes, or names a scheme', () => {
    for (const storageKey of [
      '../../etc/passwd',
      '/etc/passwd',
      'documents/../../secrets/key',
      'file:///etc/passwd',
      'http://169.254.169.254/latest/meta-data',
      'documents//deed.pdf',
      'documents\\deed.pdf',
      'C:/windows/system32',
    ]) {
      assert.equal(
        body(documentCreate, { ...base, storageKey, checksumSha256: digest }).success,
        false,
        `storage key must be rejected: ${storageKey}`,
      );
    }
  });

  it('accepts an ordinary object key', () => {
    const result = body(documentCreate, {
      ...base,
      storageKey: 'projects/2026/nh-2026-014/title-deed.pdf',
      checksumSha256: digest,
    });
    assert.equal(result.success, true);
  });

  it('requires a digest whenever an object is attached', () => {
    assert.equal(body(documentCreate, { ...base, storageKey: 'projects/a/b.pdf' }).success, false);
    assert.equal(body(documentCreate, { ...base, storageKey: 'projects/a/b.pdf', checksumSha256: digest }).success, true);
  });

  it('refuses a checksum that is not a SHA-256 digest', () => {
    for (const checksumSha256 of ['abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      assert.equal(body(documentCreate, { ...base, storageKey: 'projects/a/b.pdf', checksumSha256 }).success, false);
    }
  });
});

describe('credential handling', () => {
  it('refuses a short or unvaried password', () => {
    const account = { email: 'officer@example.gov', displayName: 'A Officer', role: 'VIEWER' as const };
    assert.equal(body(userCreate, { ...account, password: 'Short1' }).success, false);
    assert.equal(body(userCreate, { ...account, password: 'alllowercase123' }).success, false);
    assert.equal(body(userCreate, { ...account, password: 'ALLUPPERCASE123' }).success, false);
    assert.equal(body(userCreate, { ...account, password: 'NoDigitsAtAllHere' }).success, false);
  });

  it('refuses a password built from the account name', () => {
    const result = body(userCreate, {
      email: 'officer@example.gov',
      password: 'Officer123456',
      displayName: 'A Officer',
      role: 'VIEWER',
    });
    assert.equal(result.success, false);
  });

  it('accepts a long varied password', () => {
    const result = body(userCreate, {
      email: 'officer@example.gov',
      password: 'Ludhiana7Ring9Road',
      displayName: 'A Officer',
      role: 'VIEWER',
    });
    assert.equal(result.success, true);
  });

  it('normalizes the login email and rejects extra login fields', () => {
    const parsed = login.safeParse({ params: {}, query: {}, body: { email: '  Officer@Example.GOV ', password: 'anything' } });
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.body.email, 'officer@example.gov');
    assert.equal(body(login, { email: 'a@b.gov', password: 'x', role: 'SUPER_ADMIN' }).success, false);
  });
});

describe('resource bounds', () => {
  it('caps page size so one request cannot drain a table', () => {
    const over = projectList.safeParse({ params: {}, query: { pageSize: '1000' }, body: {} });
    assert.equal(over.success, false);
    assert.equal(projectList.safeParse({ params: {}, query: { pageSize: '100' }, body: {} }).success, true);
  });

  it('caps supplied snapshot arrays', () => {
    const tasks = Array.from({ length: 51 }, () => ({ taskCode: 'OWNERSHIP_UNRESOLVED', count: 1 }));
    const result = recommendationGenerate.safeParse({
      params: { id: UUID },
      query: {},
      body: { snapshot: { pendingTasks: tasks } },
    });
    assert.equal(result.success, false);
  });

  it('rejects an identifier filter that is not a uuid', () => {
    const result = auditLogList.safeParse({ params: {}, query: { actorId: 'not-a-uuid' }, body: {} });
    assert.equal(result.success, false);
  });

  it('rejects a target date that precedes the start date', () => {
    assert.equal(body(projectCreate, { ...validProject, targetDate: '2025-01-01' }).success, false);
  });
});

describe('scope cannot be escaped through the request body', () => {
  const district = resolveScope({ role: 'DISTRICT_OFFICER', stateCode: 'Punjab', districtCode: 'Ludhiana' });
  const state = resolveScope({ role: 'STATE_ADMIN', stateCode: 'Punjab' });
  const department = resolveScope({
    role: 'PROJECT_OFFICER',
    stateCode: 'Punjab',
    districtCode: 'Ludhiana',
    department: 'Public Works Department',
  });

  it('blocks relocating a record into another district', () => {
    assert.throws(() => assertBodyFieldsInScope(district, { district: 'Amritsar' }, 'projects'), /outside your assigned scope/);
  });

  it('blocks relocating a record into another state', () => {
    assert.throws(() => assertBodyFieldsInScope(state, { state: 'Haryana' }, 'projects'), /outside your assigned scope/);
    assert.throws(() => assertBodyFieldsInScope(district, { state: 'Haryana' }, 'projects'), /outside your assigned scope/);
  });

  it('blocks reassigning a record to another department', () => {
    assert.throws(
      () => assertBodyFieldsInScope(department, { department: 'Water Resources' }, 'projects'),
      /outside your assigned scope/,
    );
  });

  it('allows a state role to place a record in any district of its own state', () => {
    assert.doesNotThrow(() => assertBodyFieldsInScope(state, { state: 'Punjab', district: 'Amritsar' }, 'projects'));
  });

  it('allows a partial update that does not touch a scope field', () => {
    assert.doesNotThrow(() => assertBodyFieldsInScope(district, {}, 'projects'));
    assert.doesNotThrow(() => assertBodyFieldsInScope(district, { district: undefined }, 'projects'));
  });

  it('compares scope fields case-insensitively', () => {
    assert.doesNotThrow(() => assertBodyFieldsInScope(district, { district: ' LUDHIANA ' }, 'projects'));
  });

  it('places no restriction on a global scope', () => {
    const global = resolveScope({ role: 'SUPER_ADMIN' });
    assert.doesNotThrow(() => assertBodyFieldsInScope(global, { state: 'Anything', district: 'Anywhere' }, 'projects'));
  });

  it('refuses everything for an account with no assigned scope', () => {
    const none = resolveScope({ role: 'STATE_ADMIN' });
    assert.throws(() => assertBodyFieldsInScope(none, { state: 'Punjab' }, 'projects'), /no assigned scope/);
  });
});
