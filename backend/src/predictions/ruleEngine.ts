/**
 * Rule-based delay risk scoring.
 *
 * This is layer one of the predictive engine described in
 * `ml/PREDICTIVE_ANALYTICS_ENGINE.md`: a transparent evaluator that runs on the
 * same point-in-time feature snapshot the model reads. It is what answers when
 * no model service is configured, and it is deliberately explainable rather than
 * accurate: every contribution names the measurement behind it.
 *
 * The combination is noisy-OR, not a sum. Adding independent warnings would push
 * a project past one and imply certainty from a handful of ordinary problems;
 * noisy-OR grows with each distinct bottleneck while staying inside the
 * interval. Correlated rules are grouped first, so one underlying issue that
 * shows up as three measurements is not counted three times.
 *
 * The output is a rule score, not a calibrated probability. Anything that
 * publishes it must label it `RULE_ONLY_FALLBACK`.
 */

import type { MilestoneContext, ProjectMetrics } from '../recommendations/types.js';

export const RULE_POLICY_VERSION = 'rule-risk-policy-v1';

export type RuleFactor = {
  factorCode: string;
  label: string;
  direction: 'INCREASES_RISK' | 'REDUCES_RISK' | 'NEUTRAL';
  /** Normalized contribution in [0,1] before grouping. */
  contribution: number;
  /** Share of the total contribution, for display. */
  relativeContribution: number;
  measuredValue: number;
  unit: string;
  threshold: number;
  source: 'RULE';
  explanation: string;
};

export type RuleRiskResult = {
  ruleScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  expectedDelayDays: number;
  topRiskFactors: RuleFactor[];
  /** Which correlated group each contribution was collapsed into. */
  groups: Record<string, number>;
  policyVersion: string;
};

/** Correlated rules collapse into one group, so a single issue counts once. */
type Group = 'administrative' | 'legal' | 'readiness' | 'schedule' | 'stakeholder';

/**
 * The most any one group may contribute.
 *
 * These are the calibration. Noisy-OR compounds quickly, so five groups each
 * allowed to reach 0.7 would put an ordinary case above 0.95 and make the bands
 * meaningless. The ceilings are set so that a case with every group at its
 * maximum lands in CRITICAL, three material groups land in HIGH, one or two land
 * in MEDIUM, and a clean case stays in LOW.
 */
const GROUP_CEILING: Record<Group, number> = {
  legal: 0.52,
  schedule: 0.47,
  readiness: 0.42,
  stakeholder: 0.37,
  administrative: 0.28,
};

type RuleDefinition = {
  code: string;
  label: string;
  group: Group;
  unit: string;
  /** The value at which this measurement is normally described as material. */
  threshold: number;
  /** Reads the measurement, or returns null when it is not recorded. */
  measure: (metrics: ProjectMetrics, overdueDays: number | null) => number | null;
  /**
   * Maps the measurement to [0,1] before the group ceiling is applied.
   *
   * Every ramp has a dead zone. One pending approval and two missing documents
   * out of a hundred and fifty are ordinary administration, not a warning, and a
   * scorer that treats them as one cries wolf on every project.
   */
  normalize: (value: number, metrics: ProjectMetrics) => number;
  explain: (value: number) => string;
};

const clamp = (value: number, min = 0, max = 1): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** Zero at or below `floor`, one at or above `full`, linear between. */
const ramp = (value: number, floor: number, full: number): number =>
  full <= floor ? (value > floor ? 1 : 0) : clamp((value - floor) / (full - floor));

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A count expressed as a share of a denominator, when the denominator is known. */
const share = (value: number, denominator: number | undefined, fallbackFloor: number, fallbackFull: number, floor: number, full: number): number =>
  isNumber(denominator) && denominator > 0 ? ramp(value / denominator, floor, full) : ramp(value, fallbackFloor, fallbackFull);

/**
 * The rule catalogue. Thresholds match the recommendation engine's, so an
 * officer does not see one measurement described two different ways.
 */
const RULES: readonly RuleDefinition[] = [
  {
    code: 'OPEN_LEGAL_CASE_COUNT',
    label: 'Open legal cases',
    group: 'legal',
    unit: 'case',
    threshold: 4,
    measure: (metrics) => (isNumber(metrics.openLegalCaseCount) && metrics.openLegalCaseCount > 0 ? metrics.openLegalCaseCount : null),
    normalize: (value) => ramp(value, 0, 5),
    explain: (value) => `${value} legal case(s) are open against this acquisition.`,
  },
  {
    code: 'OWNERSHIP_UNRESOLVED',
    label: 'Unresolved ownership records',
    group: 'legal',
    unit: 'parcel',
    threshold: 15,
    measure: (metrics) => (isNumber(metrics.unresolvedRecordCount) && metrics.unresolvedRecordCount > 0 ? metrics.unresolvedRecordCount : null),
    // Twenty unresolved parcels out of twenty-five is a different case from
    // twenty out of two thousand, so the share drives this where it is known.
    normalize: (value, metrics) => share(value, metrics.parcelCount, 5, 60, 0.03, 0.3),
    explain: (value) => `Ownership verification is incomplete for ${value} parcel(s).`,
  },
  {
    code: 'MILESTONE_OVERDUE',
    label: 'Current milestone overdue',
    group: 'schedule',
    unit: 'day',
    threshold: 21,
    measure: (_metrics, overdueDays) => (overdueDays !== null && overdueDays > 0 ? overdueDays : null),
    normalize: (value) => ramp(value, 7, 60),
    explain: (value) => `The current milestone is ${value} day(s) past its planned date.`,
  },
  {
    code: 'MILESTONE_SLIPPAGE_COUNT',
    label: 'Repeated milestone slippage',
    group: 'schedule',
    unit: 'milestone',
    threshold: 3,
    measure: (metrics) => (isNumber(metrics.milestoneSlippageCount) && metrics.milestoneSlippageCount > 0 ? metrics.milestoneSlippageCount : null),
    normalize: (value) => ramp(value, 1, 6),
    explain: (value) => `${value} milestone(s) have been missed or rescheduled.`,
  },
  {
    code: 'STAGE_AGING',
    label: 'Stage older than its baseline',
    group: 'schedule',
    unit: 'day',
    threshold: 1,
    measure: (metrics) => {
      const days = metrics.daysInCurrentStage;
      const baseline = metrics.averageStageDurationDays;
      if (!isNumber(days) || !isNumber(baseline) || baseline <= 0 || days <= baseline) return null;
      return days;
    },
    normalize: (value, metrics) => {
      const baseline = isNumber(metrics.averageStageDurationDays) && metrics.averageStageDurationDays > 0 ? metrics.averageStageDurationDays : 1;
      return ramp(value / baseline - 1, 0.05, 1.5);
    },
    explain: (value) => `The current stage has been open for ${value} day(s), beyond its baseline.`,
  },
  {
    code: 'COMPENSATION_PENDING',
    label: 'Compensation ageing in processing',
    group: 'readiness',
    unit: 'day',
    threshold: 45,
    measure: (metrics) => (isNumber(metrics.paymentProcessingDays) && metrics.paymentProcessingDays > 0 ? metrics.paymentProcessingDays : null),
    normalize: (value) => ramp(value, 15, 150),
    explain: (value) => `Compensation has been in processing for ${value} day(s).`,
  },
  {
    code: 'MISSING_DOCUMENT_COUNT',
    label: 'Required documents missing',
    group: 'readiness',
    unit: 'document',
    threshold: 5,
    measure: (metrics) => (isNumber(metrics.missingDocumentCount) && metrics.missingDocumentCount > 0 ? metrics.missingDocumentCount : null),
    normalize: (value, metrics) => share(value, metrics.requiredDocumentCount, 2, 25, 0.02, 0.35),
    explain: (value) => `${value} required document(s) are missing from the case file.`,
  },
  {
    code: 'DOCUMENT_VERIFICATION_BACKLOG',
    label: 'Documents awaiting verification',
    group: 'readiness',
    unit: 'document',
    threshold: 8,
    measure: (metrics) =>
      isNumber(metrics.documentVerificationPendingCount) && metrics.documentVerificationPendingCount > 0
        ? metrics.documentVerificationPendingCount
        : null,
    normalize: (value) => 0.7 * ramp(value, 8, 40),
    explain: (value) => `${value} submitted document(s) are awaiting verification.`,
  },
  {
    code: 'PENDING_APPROVAL_COUNT',
    label: 'Approvals pending',
    group: 'administrative',
    unit: 'approval',
    threshold: 4,
    measure: (metrics) => (isNumber(metrics.pendingApprovalCount) && metrics.pendingApprovalCount > 0 ? metrics.pendingApprovalCount : null),
    normalize: (value) => ramp(value, 1, 15),
    explain: (value) => `${value} approval(s) remain pending in the queue.`,
  },
  {
    code: 'BLOCKED_DEPENDENCY_COUNT',
    label: 'Blocked inter-department dependencies',
    group: 'administrative',
    unit: 'dependency',
    threshold: 3,
    measure: (metrics) => (isNumber(metrics.blockedDependencyCount) && metrics.blockedDependencyCount > 0 ? metrics.blockedDependencyCount : null),
    normalize: (value) => ramp(value, 1, 10),
    explain: (value) => `${value} inter-department dependency(ies) are blocked.`,
  },
  {
    code: 'STALE_CASE_DATA',
    label: 'Case record not updated recently',
    group: 'administrative',
    unit: 'day',
    threshold: 30,
    measure: (metrics) => (isNumber(metrics.daysSinceLastUpdate) && metrics.daysSinceLastUpdate >= 30 ? metrics.daysSinceLastUpdate : null),
    normalize: (value) => 0.6 * ramp(value, 30, 120),
    explain: (value) => `The case record has not been updated for ${value} day(s).`,
  },
  {
    code: 'OPEN_OBJECTION_COUNT',
    label: 'Unresolved landowner objections',
    group: 'stakeholder',
    unit: 'objection',
    threshold: 12,
    measure: (metrics) => {
      const value = metrics.unresolvedObjectionCount ?? metrics.objectionCount;
      return isNumber(value) && value > 0 ? value : null;
    },
    // Six objections from eight owners is a different case from six from eight
    // hundred, so the share of affected landowners drives this.
    normalize: (value, metrics) => share(value, metrics.affectedLandownerCount, 5, 60, 0.05, 0.4),
    explain: (value) => `${value} landowner objection(s) remain unresolved.`,
  },
];

/** Noisy-OR: one minus the product of the complements. */
const noisyOr = (values: number[]): number => clamp(1 - values.reduce((product, value) => product * (1 - clamp(value)), 1));

export type RuleRiskInput = {
  metrics: ProjectMetrics;
  milestone?: MilestoneContext | null;
  asOfAt?: Date;
  /** Project priority nudges the band, as policy metadata rather than evidence. */
  priority?: string;
};

const MS_PER_DAY = 86_400_000;

const overdueDaysFor = (input: RuleRiskInput): number | null => {
  const milestone = input.milestone;
  if (milestone && isNumber(milestone.overdueDays)) return Math.max(0, milestone.overdueDays);
  const plannedAt = milestone?.plannedAt ? new Date(milestone.plannedAt) : null;
  const completed = milestone?.status === 'COMPLETED' || Boolean(milestone?.completedAt);
  if (plannedAt && !Number.isNaN(plannedAt.getTime()) && !completed) {
    const days = Math.floor(((input.asOfAt ?? new Date()).getTime() - plannedAt.getTime()) / MS_PER_DAY);
    if (days > 0) return days;
  }
  return isNumber(input.metrics.overdueDays) ? Math.max(0, input.metrics.overdueDays) : null;
};

/**
 * Scores a case from its recorded facts.
 *
 * Returns the rule score, a risk band, and the ranked factors behind it. The
 * factors are the explanation: each names its measurement, its threshold, and
 * what it contributed.
 */
export const scoreCase = (input: RuleRiskInput): RuleRiskResult => {
  const metrics = input.metrics ?? {};
  const overdueDays = overdueDaysFor(input);

  const factors: RuleFactor[] = [];
  const byGroup = new Map<Group, number>();

  for (const rule of RULES) {
    const measured = rule.measure(metrics, overdueDays);
    if (measured === null) continue;
    const contribution = clamp(GROUP_CEILING[rule.group] * rule.normalize(measured, metrics));
    if (contribution <= 0) continue;

    factors.push({
      factorCode: rule.code,
      label: rule.label,
      direction: 'INCREASES_RISK',
      contribution: Number(contribution.toFixed(4)),
      relativeContribution: 0,
      measuredValue: measured,
      unit: rule.unit,
      threshold: rule.threshold,
      source: 'RULE',
      explanation: `${rule.explain(measured)} This is associated with elevated predicted delay risk.`,
    });

    // Within a correlated group the strongest contribution stands for the group.
    byGroup.set(rule.group, Math.max(byGroup.get(rule.group) ?? 0, contribution));
  }

  const ruleScore = noisyOr([...byGroup.values()]);


  // Priority is policy metadata, not evidence, so it nudges rather than scores.
  const priorityNudge = input.priority === 'CRITICAL' ? 0.04 : input.priority === 'HIGH' ? 0.02 : 0;
  let finalScore = clamp(ruleScore + priorityNudge * (1 - ruleScore));

  // A confirmed stay order is a governed hard stop, exactly as in the alert
  // engine. It does not compete with the other measurements; it overrides them.
  const stayOrder = metrics.stayOrderFlag === true;
  if (stayOrder) {
    finalScore = Math.max(finalScore, 0.9);
    factors.unshift({
      factorCode: 'ACTIVE_STAY_ORDER',
      label: 'Active stay order',
      direction: 'INCREASES_RISK',
      contribution: 0.9,
      relativeContribution: 0,
      measuredValue: 1,
      unit: 'order',
      threshold: 1,
      source: 'RULE',
      explanation:
        'A stay order is recorded as active against this acquisition. This is a governed hard stop and sets the risk level regardless of every other measurement.',
    });
  }

  const riskLevel = stayOrder || finalScore >= 0.75 ? 'CRITICAL' : finalScore >= 0.5 ? 'HIGH' : finalScore >= 0.25 ? 'MEDIUM' : 'LOW';

  // Expected delay scales with the score and with how far the schedule has
  // already slipped, which is the measurement most directly about time.
  const slippageDays = (overdueDays ?? 0) + (isNumber(metrics.milestoneSlippageCount) ? metrics.milestoneSlippageCount * 7 : 0);
  const expectedDelayDays = Math.round(finalScore * 60 + Math.min(slippageDays, 120) * 0.35);

  const totalContribution = factors.reduce((sum, factor) => sum + factor.contribution, 0);
  for (const factor of factors) {
    factor.relativeContribution = totalContribution > 0 ? Number((factor.contribution / totalContribution).toFixed(4)) : 0;
  }
  factors.sort((left, right) => right.contribution - left.contribution);

  return {
    ruleScore: Number(finalScore.toFixed(5)),
    riskLevel,
    expectedDelayDays,
    topRiskFactors: factors.slice(0, 6),
    groups: Object.fromEntries([...byGroup.entries()].map(([group, value]) => [group, Number(value.toFixed(4))])),
    policyVersion: RULE_POLICY_VERSION,
  };
};
