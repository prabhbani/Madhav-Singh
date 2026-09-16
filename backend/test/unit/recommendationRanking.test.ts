import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateRecommendations } from '../../src/recommendations/engine.js';
import { CATALOG } from '../../src/recommendations/catalog.js';
import { CODE_POLICY, POLICY_VERSION, RANKING_WEIGHTS } from '../../src/recommendations/policy.js';
import { WordingViolationError, assertNonCausal, renderImpact, renderReason } from '../../src/recommendations/wording.js';
import type { RecommendationInput, RecommendedAction } from '../../src/recommendations/types.js';

const AS_OF = new Date('2026-09-15T09:00:00.000Z');

/** A project carrying several distinct, measurable bottlenecks. */
const baseInput = (overrides: Partial<RecommendationInput> = {}): RecommendationInput => ({
  asOfAt: AS_OF,
  project: {
    projectId: '11111111-1111-4111-8111-111111111111',
    projectCode: 'NH-2026-014',
    name: 'Ring Road Phase II',
    state: 'Punjab',
    district: 'Ludhiana',
    department: 'Public Works Department',
    projectType: 'HIGHWAY',
    priority: 'HIGH',
    status: 'ACTIVE',
    targetDate: new Date('2026-12-01T00:00:00.000Z'),
    dataOrigin: 'SYNTHETIC_DEMO',
    metrics: {
      parcelCount: 180,
      unresolvedRecordCount: 23,
      unresolvedObjectionCount: 14,
      requiredDocumentCount: 16,
      missingDocumentCount: 4,
      pendingApprovalCount: 6,
      paymentProcessingDays: 62,
      daysInCurrentStage: 74,
      averageStageDurationDays: 40,
      milestoneSlippageCount: 2,
      daysSinceLastUpdate: 9,
    },
  },
  currentMilestone: {
    milestoneId: 'm-1',
    name: 'Section 19 declaration',
    status: 'IN_PROGRESS',
    plannedAt: new Date('2026-08-20T00:00:00.000Z'),
    ownerDepartment: 'Land Acquisition Cell',
    stage: 'Declaration',
  },
  prediction: {
    predictionId: 'p-1',
    riskLevel: 'HIGH',
    delayProbability: 0.68,
    expectedDelayDays: 41,
    horizonDays: 90,
    confidenceBand: 'MEDIUM',
    predictionStatus: 'OK',
    modelVersion: 'synthetic-delay-20260915T173246Z',
  },
  topRiskFactors: [
    { factorCode: 'unresolved_record_count', direction: 'INCREASES_RISK', relativeContribution: 0.31, source: 'ML' },
    { factorCode: 'missing_document_count', direction: 'INCREASES_RISK', relativeContribution: 0.19, source: 'ML' },
    { factorCode: 'unresolved_objection_count', direction: 'INCREASES_RISK', relativeContribution: 0.16, source: 'ML_AND_RULE' },
    { factorCode: 'document_completeness_ratio', direction: 'REDUCES_RISK', relativeContribution: 0.08, source: 'ML' },
  ],
  historicalPatterns: {
    departmentDelayRate: 0.44,
    districtDelayRate: 0.39,
    evidenceOutcomeRates: {
      OWNERSHIP_UNRESOLVED: { delayRateWhenPresent: 0.71, delayRateWhenAbsent: 0.28, sampleSize: 420 },
    },
    medianResolutionDays: { OWNERSHIP_UNRESOLVED: 26 },
  },
  pendingTasks: [
    { taskCode: 'OWNERSHIP_UNRESOLVED', count: 23, unit: 'parcel', ownerDepartment: 'Land Records Department', oldestAgeDays: 58 },
    { taskCode: 'MISSING_DOCUMENT_COUNT', count: 4, unit: 'document', ownerDepartment: 'Revenue Department', oldestAgeDays: 12 },
  ],
  departmentWorkload: [
    { department: 'Land Records Department', workloadIndex: 0.91, openItems: 41, activeProjects: 7 },
    { department: 'Revenue Department', workloadIndex: 0.42, openItems: 11, activeProjects: 4 },
  ],
  ...overrides,
});

const find = (actions: RecommendedAction[], code: string): RecommendedAction => {
  const match = actions.find((action) => action.evidence.code === code);
  assert.ok(match, `expected a recommendation for ${code}`);
  return match;
};

describe('recommendation engine', () => {
  it('emits an evidence-backed action for each measured bottleneck', () => {
    const result = generateRecommendations(baseInput());
    assert.ok(result.recommendations.length > 0);
    for (const recommendation of result.recommendations) {
      assert.ok(recommendation.evidence.measuredValue > 0, 'every action carries a measured value');
      assert.ok(recommendation.evidence.featureCodes.length > 0, 'every action names its source columns');
      assert.ok(recommendation.action.length > 0);
      assert.ok(recommendation.reason.length > 0);
      assert.ok(recommendation.responsibleDepartment.length > 0);
      assert.ok(recommendation.suggestedDeadline.days > 0);
      assert.ok(recommendation.expectedImpact.length > 0);
      assert.equal(recommendation.status, 'OPEN');
    }
  });

  it('never invents an action without evidence in the input', () => {
    const result = generateRecommendations({
      ...baseInput(),
      project: { ...baseInput().project, metrics: {} },
      pendingTasks: [],
      departmentWorkload: [],
      currentMilestone: null,
    });
    assert.equal(result.recommendations.length, 0);
    assert.equal(result.suppressed.length, CATALOG.length);
    for (const suppressed of result.suppressed) {
      assert.equal(suppressed.reason, 'NO_EVIDENCE');
    }
  });

  it('reports every suppressed code, so nothing disappears silently', () => {
    const result = generateRecommendations(baseInput());
    const accounted = result.recommendations.length + result.suppressed.length;
    assert.equal(accounted, CATALOG.length);
  });

  it('renders the worked example wording for unresolved ownership', () => {
    const result = generateRecommendations(baseInput());
    const ownership = find(result.recommendations, 'OWNERSHIP_UNRESOLVED');
    assert.match(ownership.action, /Complete ownership verification for the 23 parcels/);
    assert.match(ownership.reason, /incomplete for 23 parcels/);
    assert.match(ownership.reason, /is associated with elevated predicted delay risk/);
    assert.equal(ownership.responsibleDepartment, 'Land Records Department');
    assert.match(ownership.expectedImpact, /^May reduce the administrative bottleneck/);
  });

  it('ranks by the documented weighted score and orders priority first', () => {
    const result = generateRecommendations(baseInput());
    const scores = result.recommendations.map((recommendation) => recommendation.rankingScore);
    const priorities = result.recommendations.map((recommendation) => recommendation.priority);
    const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
    for (let index = 1; index < result.recommendations.length; index += 1) {
      const previous = order[priorities[index - 1]!];
      const current = order[priorities[index]!];
      assert.ok(previous >= current, 'priority must not increase down the list');
      if (previous === current) assert.ok(scores[index - 1]! >= scores[index]!, 'score must not increase within a band');
    }
    result.recommendations.forEach((recommendation, index) => assert.equal(recommendation.rank, index + 1));
  });

  it('reproduces each ranking score from its own published breakdown', () => {
    const result = generateRecommendations(baseInput());
    for (const recommendation of result.recommendations) {
      const parts = recommendation.scoreBreakdown;
      const recomputed =
        RANKING_WEIGHTS.evidenceSeverity * parts.evidenceSeverity +
        RANKING_WEIGHTS.modelLinkage * parts.modelLinkage +
        RANKING_WEIGHTS.urgency * parts.urgency +
        RANKING_WEIGHTS.policyWeight * parts.policyWeight +
        RANKING_WEIGHTS.predictedRisk * parts.predictedRisk +
        RANKING_WEIGHTS.historicalSupport * parts.historicalSupport;
      assert.ok(
        Math.abs(recomputed - recommendation.rankingScore) < 0.001,
        `${recommendation.evidence.code}: breakdown ${recomputed} does not reconcile with ${recommendation.rankingScore}`,
      );
    }
  });

  it('links an action to the model factor that shares its evidence', () => {
    const result = generateRecommendations(baseInput());
    const ownership = find(result.recommendations, 'OWNERSHIP_UNRESOLVED');
    assert.equal(ownership.relatedRiskFactor?.factorCode, 'UNRESOLVED_RECORD_COUNT');
    assert.equal(ownership.relatedRiskFactor?.source, 'ML');
    assert.equal(ownership.relatedRiskFactor?.rank, 1);
    assert.ok((ownership.scoreBreakdown.modelLinkage ?? 0) > 0);
  });

  it('falls back to a rule-sourced factor when no model factor matches', () => {
    const result = generateRecommendations({ ...baseInput(), topRiskFactors: [] });
    const compensation = find(result.recommendations, 'COMPENSATION_PENDING');
    assert.equal(compensation.relatedRiskFactor?.source, 'RULE');
    assert.equal(compensation.scoreBreakdown.modelLinkage, 0);
    assert.ok(compensation.limitations.some((note) => note.includes('No model risk factor was linked')));
  });

  it('does not let a risk-reducing factor raise an action', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      topRiskFactors: [
        { factorCode: 'missing_document_count', direction: 'REDUCES_RISK', relativeContribution: 0.9, source: 'ML' },
      ],
    });
    const documents = find(result.recommendations, 'MISSING_DOCUMENT_COUNT');
    assert.equal(documents.scoreBreakdown.modelLinkage, 0);
  });

  it('forces CRITICAL for a governed hard stop and records the override', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      project: { ...input.project, metrics: { ...input.project.metrics, stayOrderFlag: true } },
    });
    const stay = find(result.recommendations, 'ACTIVE_STAY_ORDER');
    assert.equal(stay.priority, 'CRITICAL');
    assert.equal(stay.priorityBasis, 'POLICY_OVERRIDE');
    assert.equal(stay.rank, 1, 'a hard stop is shown before any action it may forbid');
    assert.ok(stay.appliedOverrides.some((entry) => entry.startsWith('HARD_STOP_POLICY')));
    assert.equal(stay.responsibleDepartment, 'Legal Department');
  });

  it('caps priority when the prediction is degraded, except for hard stops', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      project: { ...input.project, metrics: { ...input.project.metrics, stayOrderFlag: true } },
      prediction: { ...input.prediction, riskLevel: 'CRITICAL', predictionStatus: 'RULE_ONLY_FALLBACK', confidenceBand: 'LOW' },
    });
    for (const recommendation of result.recommendations) {
      if (recommendation.evidence.code === 'ACTIVE_STAY_ORDER') {
        assert.equal(recommendation.priority, 'CRITICAL');
        continue;
      }
      assert.notEqual(recommendation.priority, 'CRITICAL');
    }
    assert.ok(result.dataQuality.warnings.some((warning) => warning.includes('RULE_ONLY_FALLBACK')));
  });

  it('shortens deadlines with priority and lengthens them under department load', () => {
    const input = baseInput();
    const loaded = generateRecommendations(input);
    const unloaded = generateRecommendations({ ...input, departmentWorkload: [] });
    const ownershipLoaded = find(loaded.recommendations, 'OWNERSHIP_UNRESOLVED');
    const ownershipUnloaded = find(unloaded.recommendations, 'OWNERSHIP_UNRESOLVED');
    assert.ok(
      ownershipLoaded.suggestedDeadline.days > ownershipUnloaded.suggestedDeadline.days,
      'a saturated department gets a longer, explicitly reasoned deadline',
    );
    assert.equal(ownershipLoaded.suggestedDeadline.baseSlaDays, CODE_POLICY.OWNERSHIP_UNRESOLVED.slaDays);
    assert.match(ownershipLoaded.suggestedDeadline.basis, /workload index 0\.91/);
    assert.ok(ownershipLoaded.capacityNote);
    const dueAt = new Date(ownershipLoaded.suggestedDeadline.dueAt).getTime();
    assert.equal(dueAt, AS_OF.getTime() + ownershipLoaded.suggestedDeadline.days * 86_400_000);
  });

  it('raises a capacity action for the saturated department', () => {
    const result = generateRecommendations(baseInput(), { maxRecommendations: 15 });
    const capacity = find(result.recommendations, 'DEPARTMENT_CAPACITY');
    assert.equal(capacity.responsibleDepartment, 'Land Records Department');
    assert.equal(capacity.evidence.source, 'DEPARTMENT_WORKLOAD');
  });

  it('uses outcome history when the sample is large enough and says so', () => {
    const result = generateRecommendations(baseInput());
    const ownership = find(result.recommendations, 'OWNERSHIP_UNRESOLVED');
    assert.ok(Math.abs(ownership.scoreBreakdown.historicalSupport - 0.43) < 0.0001);
    assert.ok(ownership.scoreBreakdown.notes.some((note) => note.includes('over 420 cases')));
    assert.match(ownership.reason, /median of 26 days/);
  });

  it('ignores an outcome rate whose sample is too small', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      historicalPatterns: {
        evidenceOutcomeRates: {
          OWNERSHIP_UNRESOLVED: { delayRateWhenPresent: 0.9, delayRateWhenAbsent: 0.1, sampleSize: 4 },
        },
      },
    });
    const ownership = find(result.recommendations, 'OWNERSHIP_UNRESOLVED');
    assert.equal(ownership.scoreBreakdown.historicalSupport, 0);
    assert.ok(ownership.scoreBreakdown.notes.some((note) => note.includes('below the 30-case minimum')));
  });

  it('keeps an officer decision instead of resetting status', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      existingRecommendations: [
        { evidenceCode: 'OWNERSHIP_UNRESOLVED', status: 'IN_PROGRESS' },
        { evidenceCode: 'MISSING_DOCUMENT_COUNT', status: 'DISMISSED' },
        { evidenceCode: 'PENDING_APPROVAL_COUNT', status: 'COMPLETED' },
      ],
    });
    assert.equal(find(result.recommendations, 'OWNERSHIP_UNRESOLVED').status, 'IN_PROGRESS');
    assert.equal(find(result.recommendations, 'MISSING_DOCUMENT_COUNT').status, 'DISMISSED');
    const reopened = find(result.recommendations, 'PENDING_APPROVAL_COUNT');
    assert.equal(reopened.status, 'OPEN');
    assert.match(reopened.statusBasis, /reopened/);
  });

  it('is deterministic and stamps a stable id per project and evidence code', () => {
    const first = generateRecommendations(baseInput());
    const second = generateRecommendations(baseInput());
    assert.deepEqual(first, second);
    assert.equal(
      find(first.recommendations, 'OWNERSHIP_UNRESOLVED').recommendationId,
      find(second.recommendations, 'OWNERSHIP_UNRESOLVED').recommendationId,
    );
  });

  it('caps the emitted list and records what fell below the cutoff', () => {
    const result = generateRecommendations(baseInput(), { maxRecommendations: 3 });
    assert.equal(result.recommendations.length, 3);
    assert.ok(result.suppressed.some((entry) => entry.reason === 'BELOW_RANK_CUTOFF'));
  });

  it('reports missing input blocks rather than assuming values', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      topRiskFactors: [],
      historicalPatterns: null,
      departmentWorkload: [],
      pendingTasks: [],
    });
    assert.deepEqual(result.dataQuality.missingInputBlocks.sort(), [
      'departmentWorkload',
      'historicalPatterns',
      'pendingTasks',
      'topRiskFactors',
    ]);
    assert.ok(result.dataQuality.warnings.some((warning) => warning.includes('partial inputs')));
  });

  it('flags synthetic data in every recommendation it emits', () => {
    const result = generateRecommendations(baseInput());
    for (const recommendation of result.recommendations) {
      assert.ok(recommendation.limitations.some((note) => note.includes('SYNTHETIC_DEMO')));
    }
  });

  it('reports a below-threshold measurement as immaterial, not as missing data', () => {
    const input = baseInput();
    const result = generateRecommendations({
      ...input,
      project: { ...input.project, metrics: { ...input.project.metrics, daysSinceLastUpdate: 9 } },
    });
    const stale = result.suppressed.find((entry) => entry.evidenceCode === 'STALE_CASE_DATA');
    assert.equal(stale?.reason, 'BELOW_MATERIALITY_THRESHOLD');
    assert.match(stale?.detail ?? '', /not been updated for 9 days/);
  });

  it('stamps the policy version on the result', () => {
    const result = generateRecommendations(baseInput());
    assert.equal(result.policyVersion, POLICY_VERSION);
  });
});

describe('controlled language', () => {
  it('claims association, never causation or certainty', () => {
    const result = generateRecommendations(baseInput());
    const banned = /\b(caus(e|es|ed|ing)|guarantee|ensures?|definitely|certainly|eliminates?|prevents?)\b|will\s+(reduce|prevent|fix|resolve)/i;
    for (const recommendation of result.recommendations) {
      for (const field of [recommendation.action, recommendation.reason, recommendation.expectedImpact]) {
        assert.doesNotMatch(field, banned, `banned wording in: ${field}`);
      }
      assert.match(recommendation.expectedImpact, /\b(may|could|is intended to|supports)\b/i);
      assert.match(recommendation.reason, /\b(is recommended because|is associated with|are associated with|may|could)\b/i);
    }
  });

  it('rejects a causal claim outright', () => {
    assert.throws(() => assertNonCausal('reason', 'Missing documents caused the delay.'), WordingViolationError);
    assert.throws(() => renderImpact('Will reduce delay by 20 days.'), WordingViolationError);
    assert.throws(() => renderReason('There are 4 missing documents.'), WordingViolationError);
  });

  it('accepts correctly hedged wording', () => {
    assert.ok(renderReason('Four documents are missing and this is associated with elevated predicted delay risk.'));
    assert.ok(renderImpact('May reduce the administrative bottleneck.'));
  });
});
