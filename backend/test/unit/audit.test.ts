import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_PAYLOAD_BYTES, normalizeIp, redact } from '../../src/audit/redact.js';
import { AUDIT_POLICY, type AuditActionName } from '../../src/audit/auditPolicy.js';
import { RESOURCES } from '../../src/authz/permissions.js';

describe('audit redaction', () => {
  it('removes credentials at the top level', () => {
    const output = redact({ email: 'officer@example.gov', password: 'hunter2', passwordHash: '$2b$12$abc' }) as Record<string, unknown>;
    assert.equal(output.email, 'officer@example.gov');
    assert.equal(output.password, '[redacted]');
    assert.equal(output.passwordHash, '[redacted]');
  });

  it('removes credentials nested inside objects and arrays', () => {
    const output = redact({
      users: [{ displayName: 'A. Officer', password_hash: 'secret' }],
      session: { token: 'jwt-value', nested: { refreshToken: 'r' } },
    }) as Record<string, any>;
    assert.equal(output.users[0].displayName, 'A. Officer');
    assert.equal(output.users[0].password_hash, '[redacted]');
    assert.equal(output.session.token, '[redacted]');
    assert.equal(output.session.nested.refreshToken, '[redacted]');
  });

  it('matches a credential key whatever its casing', () => {
    const output = redact({ Password: 'x', AUTHORIZATION: 'Bearer y', ApiKey: 'z' }) as Record<string, unknown>;
    assert.deepEqual(Object.values(output), ['[redacted]', '[redacted]', '[redacted]']);
  });

  it('keeps ordinary values intact', () => {
    const when = new Date('2026-09-16T09:00:00.000Z');
    const output = redact({ status: 'ACTIVE', count: 4, flag: true, when, big: 10n }) as Record<string, unknown>;
    assert.deepEqual(output, { status: 'ACTIVE', count: 4, flag: true, when: when.toISOString(), big: '10' });
  });

  it('converts a decimal-like value to a number', () => {
    const output = redact({ probability: { toNumber: () => 0.82 } }) as Record<string, unknown>;
    assert.equal(output.probability, 0.82);
  });

  it('returns undefined for an absent value rather than an empty object', () => {
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(null), undefined);
  });

  it('stops recursing rather than following a deep structure forever', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let index = 0; index < 20; index += 1) deep = { nested: deep };
    const serialized = JSON.stringify(redact(deep));
    assert.match(serialized, /truncated: max depth/);
  });

  it('survives a cycle without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'project' };
    cyclic.self = cyclic;
    assert.doesNotThrow(() => redact(cyclic));
  });

  it('truncates an oversized payload instead of storing it', () => {
    const output = redact({ blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1_000) }) as Record<string, unknown>;
    assert.equal(output.truncated, true);
    assert.ok(typeof output.preview === 'string' && output.preview.length <= 1_000);
  });

  it('caps a very long array', () => {
    const output = redact(Array.from({ length: 500 }, (_, index) => index)) as unknown[];
    assert.equal(output.length, 100);
  });
});

describe('ip normalization', () => {
  it('strips the IPv4-mapped IPv6 prefix', () => {
    assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  });

  it('passes through a plain address and handles an absent one', () => {
    assert.equal(normalizeIp('2001:db8::1'), '2001:db8::1');
    assert.equal(normalizeIp(null), null);
    assert.equal(normalizeIp(undefined), null);
  });

  it('never exceeds the column width', () => {
    assert.ok((normalizeIp('a'.repeat(200)) ?? '').length <= 45);
  });
});

describe('audit policy', () => {
  const actions = Object.keys(AUDIT_POLICY) as AuditActionName[];

  it('names a known resource for every action', () => {
    const known = new Set<string>(RESOURCES);
    for (const action of actions) {
      assert.ok(known.has(AUDIT_POLICY[action].resource), `${action} names unknown resource ${AUDIT_POLICY[action].resource}`);
      assert.ok(AUDIT_POLICY[action].tableName.length > 0, `${action} names no table`);
    }
  });

  it('records the IP for authentication, account administration, and exports', () => {
    const ipRequired: AuditActionName[] = [
      'AUTH_LOGIN_SUCCESS',
      'AUTH_LOGIN_FAILURE',
      'ACCESS_DENIED',
      'USER_CREATE',
      'USER_UPDATE',
      'USER_DEACTIVATE',
      'ANALYTICS_EXPORT',
      'AUDIT_LOG_READ',
      'PROJECT_DELETE',
      'DOCUMENT_READ',
    ];
    for (const action of ipRequired) assert.equal(AUDIT_POLICY[action].recordIp, true, `${action} should record the IP`);
  });

  it('does not collect the IP for ordinary operational writes', () => {
    const ipNotNeeded: AuditActionName[] = ['PROJECT_CREATE', 'PROJECT_UPDATE', 'CASE_MILESTONE_CREATE', 'PREDICTION_CREATE'];
    for (const action of ipNotNeeded) assert.equal(AUDIT_POLICY[action].recordIp, false, `${action} should not record the IP`);
  });

  it('captures the previous values on every update and delete', () => {
    for (const action of actions) {
      if (!/_UPDATE$|_DELETE$|_DEACTIVATE$|_ACKNOWLEDGE$/.test(action)) continue;
      assert.equal(AUDIT_POLICY[action].captureBefore, true, `${action} should capture a before snapshot`);
    }
  });

  it('does not try to capture a before snapshot for a create', () => {
    for (const action of actions) {
      if (!/_CREATE$/.test(action)) continue;
      assert.equal(AUDIT_POLICY[action].captureBefore, false, `${action} has no prior state to capture`);
    }
  });
});
