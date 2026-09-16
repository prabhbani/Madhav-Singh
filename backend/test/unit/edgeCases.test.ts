import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateRecommendations } from '../../src/recommendations/engine.js';
import { evaluateAlerts } from '../../src/alerts/engine.js';
import { CATALOG } from '../../src/recommendations/catalog.js';
import { DETECTORS } from '../../src/alerts/detectors.js';
import { ENGINE_LIMITS } from '../../src/recommendations/policy.js';
import {
  ALREADY_COMPLETED,
  CONFLICTING_DATES,
  DUPLICATE_RECORDS,
  EDGE_CASES,
  EXTREMELY_LARGE,
  HOSTILE_NUMBERS,
  MISSING_COMPENSATION,
  MISSING_DOCUMENTS,
  NO_HISTORY,
  NOMINAL,
  NULL_VALUES,
  ZERO_LANDOWNERS,
} from '../fixtures/edgeCases.js';
import { alertInputFor, recommendationInputFor, risingHistory } from '../fixtures/engineInputs.js';
import type { ExistingAlert } from '../../src/alerts/types.js';

/** Every number an engine emits must be finite and inside its documented range. */
const assertWellFormed = (label: string, value: unknown, path = 'root'): void => {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${label}: ${path} is not finite (${value})`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertWellFormed(label, entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) assertWellFormed(label, nested, `${path}.${key}`);
  }
};

describe('every edge case survives both engines', () => {
  for (const edge of EDGE_CASES) {
    it(`handles ${edge.name} without failing`, () => {
      const recommendations = generateRecommendations(recommendationInputFor(edge));
      const alerts = evaluateAlerts(alertInputFor(edge));

      assertWellFormed(edge.name, recommendations);
      assertWellFormed(edge.name, alerts);

      for (const recommendation of recommendations.recommendations) {
        assert.ok(recommendation.rankingScore >= 0 && recommendation.rankingScore <= 1, 'score left [0,1]');
        assert.ok(recommendation.suggestedDeadline.days >= ENGINE_LIMITS.minDeadlineDays, 'deadline below the floor');
        assert.ok(recommendation.suggestedDeadline.days <= ENGINE_LIMITS.maxDeadlineDays, 'deadline above the ceiling');
        assert.ok(!Number.isNaN(Date.parse(recommendation.suggestedDeadline.dueAt)), 'deadline is not a date');
        assert.ok(recommendation.evidence.severity >= 0 && recommendation.evidence.severity <= 1);
      }
      for (const alert of alerts.alerts) {
        assert.ok(['INFO', 'WARNING', 'HIGH', 'CRITICAL'].includes(alert.severity));
        assert.ok(!Number.isNaN(Date.parse(alert.triggeredAt)));
      }

      // Nothing is dropped without a recorded reason, whatever the input shape.
      assert.equal(recommendations.recommendations.length + recommendations.suppressed.length, CATALOG.length);
      assert.equal(alerts.alerts.length + alerts.suppressed.length + alerts.resolved.length, DETECTORS.length);
    });
  }
});

describe('zero landowners', () => {
  it('raises no ownership or objection work when there is nobody to compensate', () => {
    const result = generateRecommendations(recommendationInputFor(ZERO_LANDOWNERS));
    const codes = result.recommendations.map((recommendation) => recommendation.evidence.code);
    assert.equal(codes.includes('OWNERSHIP_UNRESOLVED'), false);
    assert.equal(codes.includes('OPEN_OBJECTION_COUNT'), false);
  });

  it('records a measured zero as "no evidence", not as missing data', () => {
    const result = generateRecommendations(recommendationInputFor(ZERO_LANDOWNERS));
    const ownership = result.suppressed.find((entry) => entry.evidenceCode === 'OWNERSHIP_UNRESOLVED');
    assert.equal(ownership?.reason, 'NO_EVIDENCE');
  });

  it('does not divide by the landowner count anywhere in the output', () => {
    const alerts = evaluateAlerts(alertInputFor(ZERO_LANDOWNERS));
    assertWellFormed('zero landowners', alerts);
  });
});

describe('missing compensation data', () => {
  it('does not invent a backlog from an absent amount', () => {
    const result = generateRecommendations(recommendationInputFor(MISSING_COMPENSATION));
    assert.equal(
      result.recommendations.some((recommendation) => recommendation.evidence.code === 'COMPENSATION_PENDING'),
      false,
    );
    const suppressed = result.suppressed.find((entry) => entry.evidenceCode === 'COMPENSATION_PENDING');
    assert.equal(suppressed?.reason, 'NO_EVIDENCE');
  });

  it('raises no compensation alert either', () => {
    const alerts = evaluateAlerts(alertInputFor(MISSING_COMPENSATION));
    assert.equal(alerts.alerts.some((alert) => alert.alertType === 'COMPENSATION_BACKLOG'), false);
  });

  it('still raises a labelled warning when approval is open but ageing was never recorded', () => {
    const edge = {
      ...MISSING_COMPENSATION,
      metrics: { ...MISSING_COMPENSATION.metrics, compensationApprovalPendingFlag: true, pendingCompensationAmount: 18_400_000 },
    };
    const alerts = evaluateAlerts(alertInputFor(edge));
    const alert = alerts.alerts.find((entry) => entry.alertType === 'COMPENSATION_BACKLOG');
    assert.equal(alert?.severity, 'WARNING');
    assert.ok(alert?.appliedOverrides.some((entry) => entry.startsWith('NO_AGEING_DATA')));
  });
});

describe('no historical data', () => {
  it('raises no trend, jump, or increase alert without a baseline', () => {
    const alerts = evaluateAlerts(alertInputFor(NO_HISTORY));
    for (const type of ['RISK_TREND_INCREASING', 'RISK_SCORE_JUMP', 'OBJECTIONS_INCREASING'] as const) {
      assert.equal(alerts.alerts.some((alert) => alert.alertType === type), false, `${type} fired without history`);
      assert.ok(alerts.suppressed.some((entry) => entry.alertType === type && entry.reason === 'NO_CONDITION'));
    }
  });

  it('scores historical support at zero and says why', () => {
    const result = generateRecommendations(recommendationInputFor(NO_HISTORY, { historicalPatterns: null }));
    for (const recommendation of result.recommendations) {
      assert.equal(recommendation.scoreBreakdown.historicalSupport, 0);
      assert.ok(recommendation.scoreBreakdown.notes.some((note) => note.includes('No historical pattern data')));
      assert.ok(recommendation.limitations.some((note) => note.includes('No validated outcome history')));
    }
  });

  it('names the missing input blocks rather than assuming them', () => {
    const alerts = evaluateAlerts(alertInputFor(NO_HISTORY));
    assert.ok(alerts.dataQuality.missingInputBlocks.includes('predictionHistory'));
    assert.ok(alerts.dataQuality.missingInputBlocks.includes('observationHistory'));
  });

  it('still raises the work that current evidence supports', () => {
    const result = generateRecommendations(recommendationInputFor(NO_HISTORY));
    const codes = result.recommendations.map((recommendation) => recommendation.evidence.code);
    assert.ok(codes.includes('OWNERSHIP_UNRESOLVED'), 'forty-four unresolved records is present evidence');
    assert.ok(codes.includes('MISSING_DOCUMENT_COUNT'));
  });
});

describe('extremely large project', () => {
  it('saturates severity instead of overflowing it', () => {
    const result = generateRecommendations(recommendationInputFor(EXTREMELY_LARGE));
    for (const recommendation of result.recommendations) {
      assert.ok(recommendation.evidence.severity <= 1, 'severity exceeded one');
      assert.ok(recommendation.rankingScore <= 1, 'score exceeded one');
    }
  });

  it('keeps deadlines inside the policy bounds despite a target date long past', () => {
    const result = generateRecommendations(recommendationInputFor(EXTREMELY_LARGE));
    for (const recommendation of result.recommendations) {
      assert.ok(recommendation.suggestedDeadline.days >= ENGINE_LIMITS.minDeadlineDays);
      assert.ok(recommendation.suggestedDeadline.days <= ENGINE_LIMITS.maxDeadlineDays);
    }
  });

  it('still respects the action cap, so the queue stays usable', () => {
    const result = generateRecommendations(recommendationInputFor(EXTREMELY_LARGE));
    assert.ok(result.recommendations.length <= ENGINE_LIMITS.maxRecommendations);
    assert.ok(result.suppressed.some((entry) => entry.reason === 'BELOW_RANK_CUTOFF'));
  });

  it('caps alert severity at CRITICAL rather than inventing a higher band', () => {
    const alerts = evaluateAlerts(alertInputFor(EXTREMELY_LARGE));
    for (const alert of alerts.alerts) {
      assert.ok(['INFO', 'WARNING', 'HIGH', 'CRITICAL'].includes(alert.severity));
    }
    assert.ok(alerts.alerts.some((alert) => alert.severity === 'CRITICAL'), 'this scale should reach the top band');
  });
});

describe('missing documents', () => {
  it('raises the document action and reports the measured count', () => {
    const result = generateRecommendations(recommendationInputFor(MISSING_DOCUMENTS));
    const documents = result.recommendations.find((entry) => entry.evidence.code === 'MISSING_DOCUMENT_COUNT');
    assert.ok(documents, 'expected a missing-document action');
    assert.equal(documents.evidence.measuredValue, 18);
    assert.equal(documents.responsibleDepartment, 'Revenue Department');
  });

  it('does not divide by a total when every document is outstanding', () => {
    const result = generateRecommendations(recommendationInputFor(MISSING_DOCUMENTS));
    assertWellFormed('missing documents', result);
  });
});

describe('project already completed', () => {
  it('raises no recommendation against a closed case', () => {
    const result = generateRecommendations(recommendationInputFor(ALREADY_COMPLETED));
    assert.equal(result.recommendations.length, 0);
    assert.ok(result.suppressed.every((entry) => entry.reason === 'PROJECT_CLOSED'));
    assert.ok(result.dataQuality.warnings.some((warning) => warning.includes('COMPLETED')));
  });

  it('raises no alert against a closed case', () => {
    const alerts = evaluateAlerts(alertInputFor(ALREADY_COMPLETED));
    assert.equal(alerts.alerts.length, 0);
    assert.equal(alerts.notifications.length, 0);
  });

  it('resolves anything still open when the case closes', () => {
    const existing: ExistingAlert[] = [
      { alertType: 'MILESTONE_OVERDUE', severity: 'HIGH', status: 'OPEN', conditionHash: 'abc' },
      { alertType: 'COMPENSATION_BACKLOG', severity: 'WARNING', status: 'ACKNOWLEDGED', conditionHash: 'def' },
    ];
    const alerts = evaluateAlerts(alertInputFor(ALREADY_COMPLETED, { existingAlerts: existing }));
    assert.equal(alerts.resolved.length, 2);
    for (const resolution of alerts.resolved) assert.match(resolution.reason, /PROJECT_CLOSED/);
  });

  it('applies the same rule to a cancelled case', () => {
    const cancelled = { ...ALREADY_COMPLETED, context: { ...ALREADY_COMPLETED.context, status: 'CANCELLED' } };
    assert.equal(generateRecommendations(recommendationInputFor(cancelled)).recommendations.length, 0);
    assert.equal(evaluateAlerts(alertInputFor(cancelled)).alerts.length, 0);
  });
});

describe('conflicting dates', () => {
  it('never produces a negative or absurd deadline', () => {
    const result = generateRecommendations(recommendationInputFor(CONFLICTING_DATES));
    for (const recommendation of result.recommendations) {
      assert.ok(recommendation.suggestedDeadline.days >= ENGINE_LIMITS.minDeadlineDays, 'deadline went below the floor');
      assert.ok(
        Date.parse(recommendation.suggestedDeadline.dueAt) > Date.parse(result.asOfAt),
        'a deadline must fall after the snapshot',
      );
    }
  });

  it('treats a target date already passed as maximum schedule pressure', () => {
    const result = generateRecommendations(recommendationInputFor(CONFLICTING_DATES));
    const scheduled = result.recommendations.find((entry) => entry.impactCategory === 'SCHEDULE_RECOVERY');
    assert.ok(scheduled, 'expected a schedule-recovery action');
    assert.equal(scheduled.scoreBreakdown.urgency, 1);
  });

  it('does not raise an approaching-deadline alert for a milestone past the project target', () => {
    const alerts = evaluateAlerts(alertInputFor(CONFLICTING_DATES));
    const approaching = alerts.alerts.find((alert) => alert.alertType === 'MILESTONE_DEADLINE_APPROACHING');
    // The milestone is 200 days out, far outside the fourteen-day window.
    assert.equal(approaching, undefined);
  });
});

describe('null values', () => {
  it('raises nothing from absent metrics rather than treating them as zero-crossings', () => {
    const result = generateRecommendations(recommendationInputFor(NULL_VALUES));
    assert.equal(result.recommendations.length, 0);
    assert.ok(result.suppressed.every((entry) => entry.reason === 'NO_EVIDENCE'));
  });

  it('raises no metric-derived alert, while a real prediction still speaks', () => {
    const alerts = evaluateAlerts(alertInputFor(NULL_VALUES));
    // The prediction is present and genuine, so its own alert is correct. What
    // must not happen is a null metric being read as a threshold crossing.
    const metricDerived = alerts.alerts.filter((alert) => alert.evidence.source === 'PROJECT_DATA');
    assert.deepEqual(metricDerived, []);
    assert.deepEqual(
      alerts.alerts.map((alert) => alert.alertType),
      ['HIGH_DELAY_PROBABILITY'],
    );
    assertWellFormed('null values', alerts);
  });

  it('reports a null target date as absent rather than as the epoch', () => {
    const alerts = evaluateAlerts(alertInputFor(NULL_VALUES));
    for (const alert of alerts.alerts) {
      // An epoch target date would make every urgency read as maximum pressure.
      assert.ok(Date.parse(alert.triggeredAt) > Date.parse('2020-01-01T00:00:00.000Z'));
    }
  });

  it('survives a prediction with no history and a null milestone', () => {
    const alerts = evaluateAlerts(alertInputFor(NULL_VALUES, { currentMilestone: null, upcomingMilestones: [] }));
    assert.ok(alerts.dataQuality.missingInputBlocks.includes('upcomingMilestones'));
  });
});

describe('duplicate records', () => {
  it('produces one action per condition, not one per import', () => {
    const result = generateRecommendations(recommendationInputFor(DUPLICATE_RECORDS));
    const codes = result.recommendations.map((recommendation) => recommendation.evidence.code);
    assert.equal(new Set(codes).size, codes.length, 'an evidence code appeared twice');
  });

  it('gives the same recommendation identifier for the same project and evidence', () => {
    const first = generateRecommendations(recommendationInputFor(NOMINAL));
    const second = generateRecommendations(recommendationInputFor(DUPLICATE_RECORDS));
    const identifiers = (result: typeof first) =>
      Object.fromEntries(result.recommendations.map((entry) => [entry.evidence.code, entry.recommendationId]));
    assert.deepEqual(identifiers(first), identifiers(second));
  });

  it('does not raise a second alert when the same case is evaluated again', () => {
    const first = evaluateAlerts(alertInputFor(DUPLICATE_RECORDS));
    const existing: ExistingAlert[] = first.alerts.map((alert) => ({
      alertType: alert.alertType,
      severity: alert.severity,
      status: alert.acknowledgement.status,
      conditionHash: alert.conditionHash,
      occurrenceCount: alert.acknowledgement.occurrenceCount,
      firstTriggeredAt: alert.acknowledgement.firstTriggeredAt,
      cooldownUntil: alert.cooldownUntil,
    }));
    const second = evaluateAlerts(alertInputFor(DUPLICATE_RECORDS, { existingAlerts: existing }));
    assert.ok(first.notifications.length > 0, 'the first evaluation should notify');
    assert.equal(second.notifications.length, 0, 'the repeat must notify nobody');
    assert.ok(second.alerts.every((alert) => alert.decision === 'UNCHANGED'));
  });

  it('counts a duplicate observation without duplicating the alert', () => {
    const first = evaluateAlerts(alertInputFor(DUPLICATE_RECORDS));
    const existing: ExistingAlert[] = first.alerts.map((alert) => ({
      alertType: alert.alertType,
      severity: alert.severity,
      status: 'OPEN' as const,
      conditionHash: alert.conditionHash,
      occurrenceCount: alert.acknowledgement.occurrenceCount,
    }));
    const second = evaluateAlerts(alertInputFor(DUPLICATE_RECORDS, { existingAlerts: existing }));
    assert.equal(second.alerts.length, first.alerts.length);
    for (const alert of second.alerts) assert.equal(alert.acknowledgement.occurrenceCount, 2);
  });
});

describe('hostile numbers', () => {
  const hostile = { name: 'hostile numbers', hazard: 'NaN and infinity in every field', metrics: HOSTILE_NUMBERS };

  it('never emits a non-finite number, whatever arrives', () => {
    const result = generateRecommendations(recommendationInputFor(hostile));
    const alerts = evaluateAlerts(alertInputFor(hostile));
    assertWellFormed('hostile recommendations', result);
    assertWellFormed('hostile alerts', alerts);
  });

  it('survives a non-finite delay probability', () => {
    const alerts = evaluateAlerts(
      alertInputFor(hostile, {
        prediction: { riskLevel: 'HIGH', delayProbability: Number.NaN, horizonDays: 90, predictionStatus: 'OK' },
      }),
    );
    assertWellFormed('hostile prediction', alerts);
  });

  it('survives a negative horizon and a zero-length history window', () => {
    const alerts = evaluateAlerts(
      alertInputFor(hostile, {
        prediction: { riskLevel: 'LOW', delayProbability: 0.1, horizonDays: -5, predictionStatus: 'OK' },
        predictionHistory: risingHistory([]),
      }),
    );
    assertWellFormed('negative horizon', alerts);
  });
});
