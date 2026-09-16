import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateAlerts } from '../../src/alerts/engine.js';
import { DETECTORS } from '../../src/alerts/detectors.js';
import { ALERT_POLICY_VERSION, COOLDOWN_HOURS, NOTIFICATION_POLICY } from '../../src/alerts/policy.js';
import type {
  AlertEvaluationInput,
  AlertEvaluationResult,
  AlertType,
  DetectedAlert,
  ExistingAlert,
} from '../../src/alerts/types.js';

const AS_OF = new Date('2026-09-15T09:00:00.000Z');
const day = (offset: number) => new Date(AS_OF.getTime() + offset * 86_400_000);

/** A quiet project: nothing crosses a threshold unless a test adds it. */
const baseInput = (overrides: Partial<AlertEvaluationInput> = {}): AlertEvaluationInput => ({
  asOfAt: AS_OF,
  project: {
    projectId: '11111111-1111-4111-8111-111111111111',
    projectCode: 'NH-2026-014',
    name: 'Ring Road Phase II',
    state: 'Punjab',
    district: 'Ludhiana',
    department: 'Public Works Department',
    targetDate: day(120),
    dataOrigin: 'SYNTHETIC_DEMO',
    metrics: {},
  },
  currentMilestone: { milestoneId: 'm-1', name: 'Section 19 declaration', status: 'IN_PROGRESS', plannedAt: day(60) },
  upcomingMilestones: [{ milestoneId: 'm-1', name: 'Section 19 declaration', status: 'IN_PROGRESS', plannedAt: day(60) }],
  prediction: {
    riskLevel: 'LOW',
    delayProbability: 0.2,
    horizonDays: 90,
    confidenceBand: 'MEDIUM',
    predictionStatus: 'OK',
    modelVersion: 'synthetic-delay-20260915T173246Z',
  },
  predictionHistory: [],
  observationHistory: [],
  departmentWorkload: [],
  responsibleOfficers: [
    { department: 'Land Records Department', officerId: 'u-1', officerName: 'Records Officer', matchBasis: 'Officer recorded for this department.' },
    { department: 'Legal Department', officerId: 'u-2', officerName: 'Legal Officer' },
  ],
  existingAlerts: [],
  ...overrides,
});

const find = (result: AlertEvaluationResult, type: AlertType): DetectedAlert => {
  const match = result.alerts.find((alert) => alert.alertType === type);
  assert.ok(match, `expected an alert of type ${type}`);
  return match;
};

const has = (result: AlertEvaluationResult, type: AlertType): boolean =>
  result.alerts.some((alert) => alert.alertType === type);

/** Feeds one run's output back in as stored state, as the service does. */
const toExisting = (result: AlertEvaluationResult): ExistingAlert[] =>
  result.alerts.map((alert) => ({
    alertType: alert.alertType,
    severity: alert.severity,
    status: alert.acknowledgement.status,
    conditionHash: alert.conditionHash,
    occurrenceCount: alert.acknowledgement.occurrenceCount,
    firstTriggeredAt: alert.acknowledgement.firstTriggeredAt,
    lastObservedAt: alert.acknowledgement.lastObservedAt,
    cooldownUntil: alert.cooldownUntil,
    acknowledgedAt: alert.acknowledgement.acknowledgedAt,
  }));

describe('early warning detectors', () => {
  it('stays silent on a project with no threshold crossing', () => {
    const result = evaluateAlerts(baseInput());
    assert.equal(result.alerts.length, 0);
    assert.equal(result.notifications.length, 0);
    assert.ok(result.suppressed.every((entry) => entry.reason === 'NO_CONDITION'));
  });

  it('accounts for every detector in each run', () => {
    const result = evaluateAlerts(baseInput());
    assert.equal(result.alerts.length + result.suppressed.length, DETECTORS.length);
    assert.equal(result.summary.evaluatedDetectors, DETECTORS.length);
  });

  it('detects an approaching milestone deadline and scales with proximity', () => {
    const near = (days: number) =>
      evaluateAlerts(
        baseInput({
          currentMilestone: { milestoneId: 'm-1', name: 'Award declaration', plannedAt: day(days) },
          upcomingMilestones: [{ milestoneId: 'm-1', name: 'Award declaration', plannedAt: day(days) }],
        }),
      );
    assert.equal(find(near(10), 'MILESTONE_DEADLINE_APPROACHING').severity, 'INFO');
    assert.equal(find(near(5), 'MILESTONE_DEADLINE_APPROACHING').severity, 'WARNING');
    assert.equal(find(near(2), 'MILESTONE_DEADLINE_APPROACHING').severity, 'HIGH');
    assert.equal(find(near(1), 'MILESTONE_DEADLINE_APPROACHING').severity, 'CRITICAL');
    assert.equal(has(near(30), 'MILESTONE_DEADLINE_APPROACHING'), false);
  });

  it('detects an overdue milestone and reports the measured value', () => {
    const input = baseInput({
      currentMilestone: { milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-26), overdueDays: 26 },
      upcomingMilestones: [{ milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-26) }],
    });
    const alert = find(evaluateAlerts(input), 'MILESTONE_OVERDUE');
    assert.equal(alert.severity, 'HIGH');
    assert.equal(alert.evidence.measuredValue, 26);
    assert.match(alert.trigger, /milestone_overdue_days = 26 >= 21/);
    assert.match(alert.description, /26 day\(s\) past its planned date/);
  });

  it('detects a sustained rise in predicted risk', () => {
    const input = baseInput({
      prediction: { ...baseInput().prediction, delayProbability: 0.58 },
      predictionHistory: [
        { predictedAt: day(-30), delayProbability: 0.4 },
        { predictedAt: day(-20), delayProbability: 0.46 },
        { predictedAt: day(-10), delayProbability: 0.52 },
      ],
    });
    const alert = find(evaluateAlerts(input), 'RISK_TREND_INCREASING');
    assert.equal(alert.severity, 'HIGH');
    assert.match(alert.trigger, /rose 0\.18 across 4 predictions/);
  });

  it('does not read a single spike as a trend', () => {
    const input = baseInput({
      prediction: { ...baseInput().prediction, delayProbability: 0.55 },
      predictionHistory: [
        { predictedAt: day(-30), delayProbability: 0.42 },
        { predictedAt: day(-20), delayProbability: 0.4 },
        { predictedAt: day(-10), delayProbability: 0.39 },
      ],
    });
    // Only the final step rises, which is a jump rather than a trend.
    assert.equal(has(evaluateAlerts(input), 'RISK_TREND_INCREASING'), false);
    assert.equal(has(evaluateAlerts(input), 'RISK_SCORE_JUMP'), true);
  });

  it('detects a sudden single-step risk increase', () => {
    const input = baseInput({
      prediction: { ...baseInput().prediction, delayProbability: 0.58 },
      predictionHistory: [{ predictedAt: day(-7), delayProbability: 0.43 }],
    });
    const alert = find(evaluateAlerts(input), 'RISK_SCORE_JUMP');
    assert.equal(alert.severity, 'HIGH');
    assert.match(alert.trigger, /rose 0\.15 in one step over 7 day\(s\)/);
  });

  it('detects a high delay probability at the right rung', () => {
    const at = (probability: number) =>
      evaluateAlerts(baseInput({ prediction: { ...baseInput().prediction, delayProbability: probability } }));
    assert.equal(has(at(0.4), 'HIGH_DELAY_PROBABILITY'), false);
    assert.equal(find(at(0.55), 'HIGH_DELAY_PROBABILITY').severity, 'INFO');
    assert.equal(find(at(0.68), 'HIGH_DELAY_PROBABILITY').severity, 'WARNING');
    assert.equal(find(at(0.78), 'HIGH_DELAY_PROBABILITY').severity, 'HIGH');
  });

  it('detects a critical risk classification', () => {
    const result = evaluateAlerts(
      baseInput({ prediction: { ...baseInput().prediction, riskLevel: 'CRITICAL', delayProbability: 0.88 } }),
    );
    const alert = find(result, 'CRITICAL_RISK_LEVEL');
    assert.equal(alert.severity, 'CRITICAL');
    assert.equal(alert.trigger, 'risk_level = CRITICAL (governed classification)');
  });

  it('detects a compensation backlog from payment ageing', () => {
    const input = baseInput();
    const alert = find(
      evaluateAlerts({ ...input, project: { ...input.project, metrics: { paymentProcessingDays: 80 } } }),
      'COMPENSATION_BACKLOG',
    );
    assert.equal(alert.severity, 'HIGH');
    assert.equal(alert.responsible.department, 'Finance and Compensation Department');
  });

  it('labels a compensation alert raised without ageing data', () => {
    const input = baseInput();
    const alert = find(
      evaluateAlerts({
        ...input,
        project: {
          ...input.project,
          metrics: { compensationApprovalPendingFlag: true, pendingCompensationAmount: 18_400_000 },
        },
      }),
      'COMPENSATION_BACKLOG',
    );
    assert.equal(alert.severity, 'WARNING');
    assert.equal(alert.severityBasis, 'POLICY_OVERRIDE');
    assert.ok(alert.appliedOverrides.some((entry) => entry.startsWith('NO_AGEING_DATA')));
  });

  it('detects objections increasing against an earlier observation', () => {
    const input = baseInput();
    const alert = find(
      evaluateAlerts({
        ...input,
        project: { ...input.project, metrics: { unresolvedObjectionCount: 18 } },
        observationHistory: [{ observedAt: day(-40), metrics: { unresolvedObjectionCount: 11 } }],
      }),
      'OBJECTIONS_INCREASING',
    );
    assert.equal(alert.severity, 'HIGH');
    assert.match(alert.trigger, /rose by 7 \(11 to 18\)/);
  });

  it('does not fire on increasing objections without a baseline observation', () => {
    const input = baseInput();
    const result = evaluateAlerts({ ...input, project: { ...input.project, metrics: { unresolvedObjectionCount: 18 } } });
    assert.equal(has(result, 'OBJECTIONS_INCREASING'), false);
    assert.ok(result.suppressed.some((entry) => entry.alertType === 'OBJECTIONS_INCREASING' && entry.reason === 'NO_CONDITION'));
  });

  it('treats a stay order as a critical legal issue regardless of case counts', () => {
    const input = baseInput();
    const alert = find(
      evaluateAlerts({ ...input, project: { ...input.project, metrics: { stayOrderFlag: true, openLegalCaseCount: 1 } } }),
      'LEGAL_ISSUE',
    );
    assert.equal(alert.severity, 'CRITICAL');
    assert.equal(alert.severityBasis, 'POLICY_OVERRIDE');
    assert.equal(alert.responsible.department, 'Legal Department');
    assert.equal(alert.responsible.officerId, 'u-2');
    assert.match(alert.recommendedAction, /hold any acquisition step the order restrains/);
  });

  it('detects a document verification backlog', () => {
    const input = baseInput();
    const alert = find(
      evaluateAlerts({ ...input, project: { ...input.project, metrics: { documentVerificationPendingCount: 17 } } }),
      'DOCUMENT_VERIFICATION_BACKLOG',
    );
    assert.equal(alert.severity, 'HIGH');
    assert.equal(alert.responsible.department, 'Revenue Department');
  });

  it('detects department workload overload and names the department', () => {
    const alert = find(
      evaluateAlerts(
        baseInput({
          departmentWorkload: [
            { department: 'Land Records Department', workloadIndex: 0.97, openItems: 41, activeProjects: 7 },
            { department: 'Revenue Department', workloadIndex: 0.42 },
          ],
        }),
      ),
      'DEPARTMENT_WORKLOAD_OVERLOAD',
    );
    assert.equal(alert.severity, 'HIGH');
    assert.equal(alert.responsible.department, 'Land Records Department');
    assert.equal(alert.responsible.officerId, 'u-1');
  });

  it('carries every required field on each alert', () => {
    const input = baseInput();
    const result = evaluateAlerts({
      ...input,
      project: { ...input.project, metrics: { stayOrderFlag: true, documentVerificationPendingCount: 12 } },
      prediction: { ...input.prediction, riskLevel: 'CRITICAL', delayProbability: 0.88 },
    });
    assert.ok(result.alerts.length >= 3);
    for (const alert of result.alerts) {
      assert.ok(alert.project.projectId);
      assert.ok(alert.alertType);
      assert.ok(['INFO', 'WARNING', 'HIGH', 'CRITICAL'].includes(alert.severity));
      assert.ok(alert.trigger.length > 0);
      assert.ok(!Number.isNaN(Date.parse(alert.triggeredAt)));
      assert.ok(alert.description.length > 0);
      assert.ok(alert.recommendedAction.length > 0);
      assert.ok(alert.responsible.department.length > 0);
      assert.ok(['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED'].includes(alert.acknowledgement.status));
      assert.ok(alert.evidence.featureCodes.length > 0);
    }
  });
});

describe('alert fatigue controls', () => {
  const overdueInput = (overdueDays: number, existingAlerts: ExistingAlert[] = []): AlertEvaluationInput =>
    baseInput({
      currentMilestone: { milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-overdueDays), overdueDays },
      upcomingMilestones: [{ milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-overdueDays) }],
      existingAlerts,
    });

  it('raises once and never re-raises an unchanged condition', () => {
    const first = evaluateAlerts(overdueInput(26));
    assert.equal(find(first, 'MILESTONE_OVERDUE').decision, 'CREATED');
    assert.equal(find(first, 'MILESTONE_OVERDUE').notify, true);

    const second = evaluateAlerts(overdueInput(28, toExisting(first)));
    const alert = find(second, 'MILESTONE_OVERDUE');
    assert.equal(alert.decision, 'UNCHANGED');
    assert.equal(alert.notify, false);
    assert.equal(alert.acknowledgement.occurrenceCount, 2);
    assert.ok(second.suppressed.some((entry) => entry.alertType === 'MILESTONE_OVERDUE' && entry.reason === 'UNCHANGED_CONDITION'));
    assert.equal(second.notifications.length, 0);
  });

  it('keeps the condition hash stable while the condition is unchanged', () => {
    const first = evaluateAlerts(overdueInput(26));
    const second = evaluateAlerts(overdueInput(30, toExisting(first)));
    assert.equal(find(first, 'MILESTONE_OVERDUE').conditionHash, find(second, 'MILESTONE_OVERDUE').conditionHash);
  });

  it('escalates and notifies when severity rises, breaking an active cooldown', () => {
    const first = evaluateAlerts(overdueInput(26));
    const existing = toExisting(first);
    assert.ok(existing[0]?.cooldownUntil, 'a notified alert sets a forward cooldown');

    const second = evaluateAlerts(overdueInput(50, existing));
    const alert = find(second, 'MILESTONE_OVERDUE');
    assert.equal(alert.decision, 'ESCALATED');
    assert.equal(alert.severity, 'CRITICAL');
    assert.equal(alert.previousSeverity, 'HIGH');
    assert.equal(alert.notify, true);
    assert.match(alert.notifyBasis, /breaks the active cooldown/);
  });

  it('de-escalates silently when the condition weakens', () => {
    const first = evaluateAlerts(overdueInput(50));
    const second = evaluateAlerts(overdueInput(9, toExisting(first)));
    const alert = find(second, 'MILESTONE_OVERDUE');
    assert.equal(alert.decision, 'DE_ESCALATED');
    assert.equal(alert.severity, 'WARNING');
    assert.equal(alert.notify, false);
    assert.match(alert.notifyBasis, /without notifying/);
  });

  it('holds a re-raise inside the cooldown window', () => {
    const existing: ExistingAlert[] = [
      {
        alertType: 'MILESTONE_OVERDUE',
        severity: 'HIGH',
        status: 'OPEN',
        conditionHash: 'a-different-hash',
        cooldownUntil: day(1),
        occurrenceCount: 1,
        firstTriggeredAt: day(-10),
      },
    ];
    const result = evaluateAlerts(overdueInput(26, existing));
    const alert = find(result, 'MILESTONE_OVERDUE');
    assert.equal(alert.decision, 'REOPENED');
    assert.equal(alert.notify, false);
    assert.ok(result.suppressed.some((entry) => entry.alertType === 'MILESTONE_OVERDUE' && entry.reason === 'COOLDOWN'));
  });

  it('sets the forward cooldown from the severity that notified', () => {
    const result = evaluateAlerts(overdueInput(50));
    const alert = find(result, 'MILESTONE_OVERDUE');
    const expected = AS_OF.getTime() + COOLDOWN_HOURS.CRITICAL * 3_600_000;
    assert.equal(new Date(alert.cooldownUntil ?? '').getTime(), expected);
  });

  it('respects a dismissal until the condition escalates', () => {
    const dismissed: ExistingAlert[] = [
      { alertType: 'MILESTONE_OVERDUE', severity: 'HIGH', status: 'DISMISSED', conditionHash: 'x', firstTriggeredAt: day(-30) },
    ];
    const unchanged = evaluateAlerts(overdueInput(26, dismissed));
    assert.equal(has(unchanged, 'MILESTONE_OVERDUE'), false);
    assert.ok(unchanged.suppressed.some((entry) => entry.reason === 'DISMISSED_BY_OFFICER'));

    const escalated = evaluateAlerts(overdueInput(50, dismissed));
    assert.equal(find(escalated, 'MILESTONE_OVERDUE').decision, 'REOPENED');
    assert.equal(find(escalated, 'MILESTONE_OVERDUE').severity, 'CRITICAL');
  });

  it('resolves an alert once its condition clears', () => {
    const first = evaluateAlerts(overdueInput(26));
    const cleared = evaluateAlerts(baseInput({ existingAlerts: toExisting(first) }));
    assert.equal(has(cleared, 'MILESTONE_OVERDUE'), false);
    assert.equal(cleared.resolved.length, 1);
    assert.equal(cleared.resolved[0]?.alertType, 'MILESTONE_OVERDUE');
    assert.match(cleared.resolved[0]?.reason ?? '', /CONDITION_CLEARED/);
  });

  it('pages once for one signal, letting the stronger alert supersede', () => {
    const result = evaluateAlerts(
      baseInput({ prediction: { ...baseInput().prediction, riskLevel: 'CRITICAL', delayProbability: 0.88 } }),
    );
    assert.equal(has(result, 'CRITICAL_RISK_LEVEL'), true);
    assert.equal(has(result, 'HIGH_DELAY_PROBABILITY'), false);
    const correlated = result.suppressed.find((entry) => entry.alertType === 'HIGH_DELAY_PROBABILITY');
    assert.equal(correlated?.reason, 'CORRELATED_ALERT');
    assert.match(correlated?.detail ?? '', /CRITICAL_RISK_LEVEL/);
  });

  it('keeps the trend alert when it outranks the jump on the same signal', () => {
    const input = baseInput({
      prediction: { ...baseInput().prediction, delayProbability: 0.72 },
      predictionHistory: [
        { predictedAt: day(-30), delayProbability: 0.4 },
        { predictedAt: day(-20), delayProbability: 0.52 },
        { predictedAt: day(-10), delayProbability: 0.64 },
      ],
    });
    const result = evaluateAlerts(input);
    assert.equal(find(result, 'RISK_TREND_INCREASING').severity, 'CRITICAL');
    assert.equal(has(result, 'RISK_SCORE_JUMP'), false);
    assert.ok(result.suppressed.some((entry) => entry.alertType === 'RISK_SCORE_JUMP' && entry.reason === 'CORRELATED_ALERT'));
  });

  it('lists INFO alerts without pushing them', () => {
    const input = baseInput();
    const result = evaluateAlerts({ ...input, project: { ...input.project, metrics: { documentVerificationPendingCount: 4 } } });
    const alert = find(result, 'DOCUMENT_VERIFICATION_BACKLOG');
    assert.equal(alert.severity, 'INFO');
    assert.equal(alert.notify, false);
    assert.match(alert.notifyBasis, new RegExp(`below the ${NOTIFICATION_POLICY.minSeverityToNotify} notification floor`));
  });

  it('throttles lower severities with the per-run budget but never HIGH or CRITICAL', () => {
    const input = baseInput();
    const result = evaluateAlerts(
      {
        ...input,
        project: {
          ...input.project,
          metrics: {
            stayOrderFlag: true,
            documentVerificationPendingCount: 10,
            paymentProcessingDays: 50,
            overdueDays: 10,
          },
        },
        currentMilestone: { milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-10), overdueDays: 10 },
        upcomingMilestones: [{ milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-10) }],
        departmentWorkload: [{ department: 'Revenue Department', workloadIndex: 0.88 }],
      },
      { maxNotificationsPerRun: 1 },
    );
    const warnings = result.alerts.filter((alert) => alert.severity === 'WARNING');
    assert.ok(warnings.length > 1, 'this scenario needs several WARNING alerts');
    assert.equal(warnings.filter((alert) => alert.notify).length, 1);
    assert.equal(find(result, 'LEGAL_ISSUE').notify, true, 'a CRITICAL is never held by the budget');
    assert.ok(result.suppressed.some((entry) => entry.reason === 'NOTIFICATION_BUDGET'));
  });

  it('caps model-derived severity when the prediction is degraded', () => {
    const result = evaluateAlerts(
      baseInput({
        prediction: {
          ...baseInput().prediction,
          riskLevel: 'CRITICAL',
          delayProbability: 0.92,
          predictionStatus: 'RULE_ONLY_FALLBACK',
          confidenceBand: 'LOW',
        },
      }),
    );
    const alert = find(result, 'CRITICAL_RISK_LEVEL');
    assert.equal(alert.severity, 'WARNING');
    assert.equal(alert.severityBasis, 'POLICY_OVERRIDE');
    assert.ok(alert.appliedOverrides.some((entry) => entry.startsWith('DEGRADED_PREDICTION_CAP')));
    assert.ok(result.dataQuality.warnings.some((warning) => warning.includes('RULE_ONLY_FALLBACK')));
  });

  it('does not cap a stay order, which is not model-derived', () => {
    const input = baseInput();
    const result = evaluateAlerts({
      ...input,
      project: { ...input.project, metrics: { stayOrderFlag: true } },
      prediction: { ...input.prediction, predictionStatus: 'RULE_ONLY_FALLBACK', confidenceBand: 'LOW' },
    });
    assert.equal(find(result, 'LEGAL_ISSUE').severity, 'CRITICAL');
  });
});

describe('alert reporting and language', () => {
  it('is deterministic for the same snapshot', () => {
    const input = () =>
      baseInput({
        currentMilestone: { milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-26), overdueDays: 26 },
        upcomingMilestones: [{ milestoneId: 'm-1', name: 'Section 19 declaration', plannedAt: day(-26) }],
      });
    assert.deepEqual(evaluateAlerts(input()), evaluateAlerts(input()));
  });

  it('claims association, never causation or certainty', () => {
    const input = baseInput();
    const result = evaluateAlerts({
      ...input,
      project: {
        ...input.project,
        metrics: { stayOrderFlag: true, documentVerificationPendingCount: 20, paymentProcessingDays: 90, unresolvedObjectionCount: 18 },
      },
      observationHistory: [{ observedAt: day(-40), metrics: { unresolvedObjectionCount: 8 } }],
      prediction: { ...input.prediction, riskLevel: 'CRITICAL', delayProbability: 0.9 },
    });
    const banned = /\b(caus(e|es|ed|ing)|guarantee|ensures?|definitely|certainly|eliminates?|prevents?)\b|will\s+(reduce|prevent|fix|resolve)/i;
    for (const alert of result.alerts) {
      assert.doesNotMatch(alert.description, banned, `banned wording in: ${alert.description}`);
      assert.doesNotMatch(alert.recommendedAction, banned, `banned wording in: ${alert.recommendedAction}`);
    }
  });

  it('flags synthetic data and missing inputs on every alert', () => {
    const input = baseInput();
    const result = evaluateAlerts({ ...input, project: { ...input.project, metrics: { stayOrderFlag: true } } });
    assert.ok(find(result, 'LEGAL_ISSUE').limitations.some((note) => note.includes('SYNTHETIC_DEMO')));
    assert.ok(result.dataQuality.missingInputBlocks.includes('predictionHistory'));
    assert.ok(result.dataQuality.warnings.some((warning) => warning.includes('partial inputs')));
  });

  it('notes when no officer is mapped to the responsible department', () => {
    const input = baseInput({ responsibleOfficers: [] });
    const result = evaluateAlerts({ ...input, project: { ...input.project, metrics: { stayOrderFlag: true } } });
    const alert = find(result, 'LEGAL_ISSUE');
    assert.equal(alert.responsible.officerId, null);
    assert.equal(alert.responsible.department, 'Legal Department');
    assert.ok(alert.limitations.some((note) => note.includes('No officer is mapped')));
  });

  it('stamps the policy version on the result', () => {
    assert.equal(evaluateAlerts(baseInput()).policyVersion, ALERT_POLICY_VERSION);
  });
});
