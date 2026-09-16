import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ageInDays, readMetricsFromSnapshot, toNumber } from '../../src/services/caseSnapshot.js';
import { AS_OF, daysFrom } from '../fixtures/edgeCases.js';

describe('snapshot feature reading', () => {
  it('reads snake_case columns, the form the feature pipeline writes', () => {
    const metrics = readMetricsFromSnapshot({
      parcel_count: 184,
      unresolved_record_count: 23,
      unresolved_objection_count: 14,
      missing_document_count: 4,
      payment_processing_days: 62,
      open_legal_case_count: 2,
      days_in_current_stage: 74,
      average_stage_duration_days: 40,
    });
    assert.equal(metrics.parcelCount, 184);
    assert.equal(metrics.unresolvedRecordCount, 23);
    assert.equal(metrics.unresolvedObjectionCount, 14);
    assert.equal(metrics.paymentProcessingDays, 62);
    assert.equal(metrics.averageStageDurationDays, 40);
  });

  it('reads camelCase columns too, so a hand-built snapshot is not silently ignored', () => {
    const metrics = readMetricsFromSnapshot({ parcelCount: 91, missingDocumentCount: 2 });
    assert.equal(metrics.parcelCount, 91);
    assert.equal(metrics.missingDocumentCount, 2);
  });

  it('reads a nested features envelope, which is how the model service replies', () => {
    const metrics = readMetricsFromSnapshot({ projectId: 'p-1', features: { parcel_count: 44, missing_document_count: 12 } });
    assert.equal(metrics.parcelCount, 44);
    assert.equal(metrics.missingDocumentCount, 12);
  });

  it('omits absent keys entirely, so a snapshot cannot overwrite a derived value with a gap', () => {
    const metrics = readMetricsFromSnapshot({ parcel_count: 55 });
    assert.equal(Object.hasOwn(metrics, 'parcelCount'), true);
    assert.equal(Object.hasOwn(metrics, 'missingDocumentCount'), false);
    // Spreading it over derived metrics must leave the derived value standing.
    const merged = { missingDocumentCount: 7, ...metrics };
    assert.equal(merged.missingDocumentCount, 7);
  });

  it('distinguishes a recorded zero from an absent value', () => {
    const metrics = readMetricsFromSnapshot({ unresolved_objection_count: 0, affected_landowner_count: 0 });
    assert.equal(metrics.unresolvedObjectionCount, 0);
    assert.equal(metrics.affectedLandownerCount, 0);
    assert.equal(Object.hasOwn(metrics, 'parcelCount'), false);
  });

  it('accepts the several ways a flag is written across sources', () => {
    for (const truthy of [true, 1, '1', 'true']) {
      assert.equal(readMetricsFromSnapshot({ stay_order_flag: truthy }).stayOrderFlag, true, String(truthy));
    }
    for (const falsy of [false, 0, '0', 'false']) {
      assert.equal(readMetricsFromSnapshot({ stay_order_flag: falsy }).stayOrderFlag, false, String(falsy));
    }
    assert.equal(Object.hasOwn(readMetricsFromSnapshot({ stay_order_flag: 'unknown' }), 'stayOrderFlag'), false);
  });

  it('reads a numeric string, which is what a CSV import yields', () => {
    assert.equal(readMetricsFromSnapshot({ parcel_count: '184' }).parcelCount, 184);
  });

  it('survives a snapshot that is not an object', () => {
    for (const snapshot of [null, undefined, 'text', 42, [1, 2, 3]]) {
      assert.deepEqual(readMetricsFromSnapshot(snapshot), {});
    }
  });

  it('ignores a value that is not a number where a number is required', () => {
    const metrics = readMetricsFromSnapshot({ parcel_count: 'not-a-number', missing_document_count: null });
    assert.equal(Object.hasOwn(metrics, 'parcelCount'), false);
    assert.equal(Object.hasOwn(metrics, 'missingDocumentCount'), false);
  });

  it('does not import an unexpected key from an untrusted snapshot', () => {
    const metrics = readMetricsFromSnapshot({ parcel_count: 10, role: 'SUPER_ADMIN', isAdmin: true }) as Record<string, unknown>;
    assert.equal(metrics.role, undefined);
    assert.equal(metrics.isAdmin, undefined);
  });
});

describe('numeric coercion', () => {
  it('accepts a number, a numeric string, and a decimal-like object', () => {
    assert.equal(toNumber(42), 42);
    assert.equal(toNumber('42.5'), 42.5);
    assert.equal(toNumber({ toNumber: () => 0.82 } as never), undefined, 'only Prisma decimals are unwrapped');
  });

  it('refuses a value that is not a finite number', () => {
    for (const value of [null, undefined, '', '   ', 'abc', Number.NaN, Number.POSITIVE_INFINITY, {}, []]) {
      assert.equal(toNumber(value), undefined, `unexpectedly accepted ${JSON.stringify(value)}`);
    }
  });
});

describe('age derivation', () => {
  it('measures whole days elapsed', () => {
    assert.equal(ageInDays(daysFrom(-26), AS_OF), 26);
    assert.equal(ageInDays(AS_OF, AS_OF), 0);
  });

  it('never returns a negative age for a future date', () => {
    assert.equal(ageInDays(daysFrom(40), AS_OF), 0);
  });

  it('returns nothing for an absent date rather than an epoch age', () => {
    assert.equal(ageInDays(null, AS_OF), undefined);
    assert.equal(ageInDays(undefined, AS_OF), undefined);
  });

  it('floors a partial day rather than rounding it up', () => {
    const almostTwoDays = new Date(AS_OF.getTime() - (2 * 86_400_000 - 3_600_000));
    assert.equal(ageInDays(almostTwoDays, AS_OF), 1);
  });
});
