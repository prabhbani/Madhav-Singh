/**
 * Early warning detectors.
 *
 * Each detector reads named measurements from the evaluation input and returns a
 * condition, or null when the condition is not present. A detector never decides
 * whether an officer is notified; that is the engine's job.
 */

import { DETECTOR_POLICY, ladderThreshold, severityFromLadder } from './policy.js';
import type {
  AlertEvidenceSource,
  AlertSeverity,
  AlertType,
  DepartmentWorkload,
  MilestoneContext,
  ObservationHistoryPoint,
  OfficerAssignment,
  PredictionContext,
  PredictionHistoryPoint,
  ProjectContext,
  ProjectMetrics,
} from './types.js';

const MS_PER_DAY = 86_400_000;

export type DetectionContext = {
  asOfAt: Date;
  project: ProjectContext;
  metrics: ProjectMetrics;
  currentMilestone: MilestoneContext | null;
  /** Open milestones with a resolvable plan date, ordered soonest first. */
  upcomingMilestones: Array<MilestoneContext & { plannedDate: Date }>;
  prediction: PredictionContext;
  /** Sorted oldest to newest, dates already normalized. */
  predictionHistory: Array<PredictionHistoryPoint & { at: Date; value: number }>;
  observationHistory: Array<ObservationHistoryPoint & { at: Date }>;
  workloadByDepartment: Map<string, DepartmentWorkload>;
  officersByDepartment: Map<string, OfficerAssignment>;
};

export type DetectedCondition = {
  measuredValue: number;
  unit: string;
  threshold: number;
  comparisonValue?: number | null;
  severity: AlertSeverity;
  /** Human-readable condition expression, including the threshold it crossed. */
  triggerExpression: string;
  /**
   * Quantized condition state. Two runs with the same bucket describe the same
   * unchanged condition and must not raise a second alert.
   */
  stateBucket: string;
  source: AlertEvidenceSource;
  featureCodes?: string[];
  observedAt?: Date;
  /** Set when a governed rule decided the severity instead of the ladder. */
  override?: string;
  context?: Record<string, number | string | boolean | null>;
};

export type DepartmentAssignment = { name: string; basis: string };

export type Detector = {
  type: AlertType;
  label: string;
  category: string;
  featureCodes: string[];
  /** Detectors in the same group describe one signal; only the strongest pages. */
  correlationGroup?: string;
  /** Precedence inside the correlation group; higher wins a severity tie. */
  correlationPrecedence?: number;
  detect: (context: DetectionContext) => DetectedCondition | null;
  department: (context: DetectionContext, condition: DetectedCondition) => DepartmentAssignment;
  description: (condition: DetectedCondition, context: DetectionContext) => string;
  recommendedAction: (condition: DetectedCondition, context: DetectionContext) => string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const daysBetween = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / MS_PER_DAY;

/** Builds a condition from a ladder, or null when the value is below INFO. */
const fromLadder = (
  type: AlertType,
  value: number,
  parts: {
    unit: string;
    expression: (severity: AlertSeverity, threshold: number) => string;
    bucket: (severity: AlertSeverity) => string;
    source: AlertEvidenceSource;
    comparisonValue?: number | null;
    featureCodes?: string[];
    observedAt?: Date;
    context?: Record<string, number | string | boolean | null>;
  },
): DetectedCondition | null => {
  const ladder = DETECTOR_POLICY[type].ladder;
  const severity = severityFromLadder(value, ladder);
  if (!severity) return null;
  const threshold = ladderThreshold(ladder, severity);
  return {
    measuredValue: value,
    unit: parts.unit,
    threshold,
    comparisonValue: parts.comparisonValue ?? null,
    severity,
    triggerExpression: parts.expression(severity, threshold),
    stateBucket: parts.bucket(severity),
    source: parts.source,
    featureCodes: parts.featureCodes,
    observedAt: parts.observedAt,
    context: parts.context,
  };
};

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

const projectDepartment = (context: DetectionContext): DepartmentAssignment => ({
  name: context.project.department,
  basis: 'Owning department of the project.',
});

const milestoneOwner = (context: DetectionContext): DepartmentAssignment => {
  const owner = context.currentMilestone?.ownerDepartment;
  return owner
    ? { name: owner, basis: 'Recorded owner department of the milestone.' }
    : projectDepartment(context);
};

/** The most loaded department among those supplied. */
const mostLoadedDepartment = (context: DetectionContext): DepartmentWorkload | null => {
  let top: DepartmentWorkload | null = null;
  for (const workload of context.workloadByDepartment.values()) {
    if (!isNumber(workload.workloadIndex)) continue;
    if (!top || workload.workloadIndex > top.workloadIndex) top = workload;
  }
  return top;
};

/** The earliest observation in the window that recorded the requested metric. */
const earliestObservation = (
  context: DetectionContext,
  windowDays: number,
  read: (metrics: ProjectMetrics) => number | undefined,
): { at: Date; value: number } | null => {
  const cutoff = new Date(context.asOfAt.getTime() - windowDays * MS_PER_DAY);
  for (const point of context.observationHistory) {
    if (point.at < cutoff) continue;
    const value = read(point.metrics);
    if (isNumber(value)) return { at: point.at, value };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export const DETECTORS: readonly Detector[] = [
  {
    type: 'MILESTONE_DEADLINE_APPROACHING',
    label: 'Milestone deadline approaching',
    category: 'SCHEDULE',
    featureCodes: ['milestone.planned_at'],
    detect: (context) => {
      // The soonest open milestone that has not already passed its plan date.
      const next = context.upcomingMilestones.find((milestone) => milestone.plannedDate >= context.asOfAt);
      if (!next) return null;
      const daysRemaining = Math.floor(daysBetween(context.asOfAt, next.plannedDate));
      return fromLadder('MILESTONE_DEADLINE_APPROACHING', daysRemaining, {
        unit: 'day',
        source: 'MILESTONE',
        comparisonValue: null,
        expression: (severity, threshold) =>
          `days_to_milestone_deadline = ${daysRemaining} <= ${threshold} (${severity} rung, milestone "${next.name}")`,
        bucket: (severity) => `${severity}:${next.milestoneId ?? next.name}`,
        observedAt: context.asOfAt,
        context: { milestone: next.name, plannedAt: next.plannedDate.toISOString(), ownerDepartment: next.ownerDepartment ?? null },
      });
    },
    department: (context) => {
      const next = context.upcomingMilestones.find((milestone) => milestone.plannedDate >= context.asOfAt);
      return next?.ownerDepartment
        ? { name: next.ownerDepartment, basis: 'Recorded owner department of the approaching milestone.' }
        : projectDepartment(context);
    },
    description: (condition) =>
      `Milestone "${condition.context?.milestone}" is due in ${condition.measuredValue} day(s), within the ${condition.threshold}-day warning window.`,
    recommendedAction: (condition) =>
      `Confirm with the owning department that milestone "${condition.context?.milestone}" is on track, and record a revised date now if it is not.`,
  },
  {
    type: 'MILESTONE_OVERDUE',
    label: 'Milestone overdue',
    category: 'SCHEDULE',
    featureCodes: ['overdue_days', 'milestone.planned_at'],
    detect: (context) => {
      const milestone = context.currentMilestone;
      const derived = milestone && isNumber(milestone.overdueDays) ? milestone.overdueDays : null;
      const overdue = derived ?? (isNumber(context.metrics.overdueDays) ? context.metrics.overdueDays : null);
      if (overdue === null || overdue <= 0) return null;
      return fromLadder('MILESTONE_OVERDUE', overdue, {
        unit: 'day',
        source: milestone ? 'MILESTONE' : 'PROJECT_DATA',
        expression: (severity, threshold) =>
          `milestone_overdue_days = ${overdue} >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}:${milestone?.milestoneId ?? 'project'}`,
        observedAt: context.asOfAt,
        context: { milestone: milestone?.name ?? null },
      });
    },
    department: milestoneOwner,
    description: (condition, context) =>
      `Milestone "${context.currentMilestone?.name ?? 'current milestone'}" is ${condition.measuredValue} day(s) past its planned date.`,
    recommendedAction: (_condition, context) =>
      `Assign an accountable officer to milestone "${context.currentMilestone?.name ?? 'the overdue milestone'}" and agree a revised completion date.`,
  },
  {
    type: 'RISK_TREND_INCREASING',
    label: 'Risk rising across recent predictions',
    category: 'RISK',
    featureCodes: ['delay_probability'],
    correlationGroup: 'RISK_MOVEMENT',
    correlationPrecedence: 1,
    detect: (context) => {
      const window = DETECTOR_POLICY.RISK_TREND_INCREASING.window;
      if (!window) return null;
      const cutoff = new Date(context.asOfAt.getTime() - window.days * MS_PER_DAY);
      const series = context.predictionHistory.filter((point) => point.at >= cutoff);
      if (series.length < window.minPoints) return null;
      const first = series[0]!;
      const last = series[series.length - 1]!;
      const delta = last.value - first.value;
      if (delta <= 0) return null;
      let rising = 0;
      for (let index = 1; index < series.length; index += 1) {
        if (series[index]!.value > series[index - 1]!.value) rising += 1;
      }
      const risingShare = rising / (series.length - 1);
      // A single spike inside an otherwise flat series is the jump detector's
      // signal, not a trend. Requiring most steps to rise keeps them distinct.
      if (risingShare < (window.minRisingShare ?? 0)) return null;
      return fromLadder('RISK_TREND_INCREASING', round(delta), {
        unit: 'probability',
        source: 'PREDICTION_HISTORY',
        comparisonValue: round(first.value),
        expression: (severity, threshold) =>
          `delay_probability rose ${round(delta)} across ${series.length} predictions in ${window.days} days >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}`,
        observedAt: last.at,
        context: {
          windowDays: window.days,
          points: series.length,
          risingShare: round(risingShare, 2),
          from: round(first.value),
          to: round(last.value),
        },
      });
    },
    department: projectDepartment,
    description: (condition) =>
      `Predicted delay probability rose from ${condition.context?.from} to ${condition.context?.to} across ${condition.context?.points} predictions in the last ${condition.context?.windowDays} days.`,
    recommendedAction: () =>
      'Review what changed on the case during this window and confirm whether the open bottlenecks are being worked.',
  },
  {
    type: 'HIGH_DELAY_PROBABILITY',
    label: 'High predicted delay probability',
    category: 'RISK',
    featureCodes: ['delay_probability'],
    correlationGroup: 'RISK_LEVEL',
    correlationPrecedence: 1,
    detect: (context) => {
      const probability = context.prediction.delayProbability;
      if (!isNumber(probability)) return null;
      return fromLadder('HIGH_DELAY_PROBABILITY', round(probability), {
        unit: 'probability',
        source: 'PREDICTION',
        expression: (severity, threshold) =>
          `delay_probability = ${round(probability)} >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}`,
        observedAt: context.asOfAt,
        context: {
          horizonDays: context.prediction.horizonDays ?? null,
          expectedDelayDays: context.prediction.expectedDelayDays ?? null,
        },
      });
    },
    department: projectDepartment,
    description: (condition, context) =>
      `Calibrated delay probability is ${condition.measuredValue} over a ${context.prediction.horizonDays ?? 90}-day horizon, at or above the ${condition.threshold} threshold.`,
    recommendedAction: () =>
      'Review the ranked recommendations for this project and confirm an owner for the highest-priority open action.',
  },
  {
    type: 'CRITICAL_RISK_LEVEL',
    label: 'Critical risk classification',
    category: 'RISK',
    featureCodes: ['risk_level'],
    correlationGroup: 'RISK_LEVEL',
    correlationPrecedence: 2,
    detect: (context) => {
      if (context.prediction.riskLevel !== 'CRITICAL') return null;
      return {
        measuredValue: 1,
        unit: 'classification',
        threshold: 1,
        severity: 'CRITICAL',
        triggerExpression: 'risk_level = CRITICAL (governed classification)',
        stateBucket: 'CRITICAL',
        source: 'PREDICTION',
        observedAt: context.asOfAt,
        context: {
          delayProbability: context.prediction.delayProbability,
          confidenceBand: context.prediction.confidenceBand ?? null,
        },
      };
    },
    department: projectDepartment,
    description: (condition) =>
      `The project is classified CRITICAL risk, with a calibrated delay probability of ${condition.context?.delayProbability}.`,
    recommendedAction: () =>
      'Escalate to the district review and confirm an owner and date for every open critical action on this project.',
  },
  {
    type: 'RISK_SCORE_JUMP',
    label: 'Sudden risk score increase',
    category: 'RISK',
    featureCodes: ['delay_probability'],
    correlationGroup: 'RISK_MOVEMENT',
    correlationPrecedence: 2,
    detect: (context) => {
      const window = DETECTOR_POLICY.RISK_SCORE_JUMP.window;
      if (!window) return null;
      const cutoff = new Date(context.asOfAt.getTime() - window.days * MS_PER_DAY);
      const series = context.predictionHistory.filter((point) => point.at >= cutoff);
      if (series.length < window.minPoints) return null;
      const last = series[series.length - 1]!;
      const previous = series[series.length - 2]!;
      const delta = last.value - previous.value;
      if (delta <= 0) return null;
      const stepDays = Math.max(1, Math.round(daysBetween(previous.at, last.at)));
      return fromLadder('RISK_SCORE_JUMP', round(delta), {
        unit: 'probability',
        source: 'PREDICTION_HISTORY',
        comparisonValue: round(previous.value),
        expression: (severity, threshold) =>
          `delay_probability rose ${round(delta)} in one step over ${stepDays} day(s) >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}`,
        observedAt: last.at,
        context: { from: round(previous.value), to: round(last.value), stepDays },
      });
    },
    department: projectDepartment,
    description: (condition) =>
      `Predicted delay probability moved from ${condition.context?.from} to ${condition.context?.to} in a single step over ${condition.context?.stepDays} day(s).`,
    recommendedAction: () =>
      'Check which case values changed since the previous prediction, and confirm the new figures are recorded correctly.',
  },
  {
    type: 'COMPENSATION_BACKLOG',
    label: 'Compensation backlog',
    category: 'FINANCE',
    featureCodes: ['payment_processing_days', 'pending_compensation_amount', 'compensation_approval_pending_flag'],
    detect: (context) => {
      const days = context.metrics.paymentProcessingDays;
      if (isNumber(days)) {
        return fromLadder('COMPENSATION_BACKLOG', days, {
          unit: 'day',
          source: 'PROJECT_DATA',
          comparisonValue: context.metrics.pendingCompensationAmount ?? null,
          expression: (severity, threshold) =>
            `payment_processing_days = ${days} >= ${threshold} (${severity} rung)`,
          bucket: (severity) => `${severity}`,
          observedAt: context.asOfAt,
          context: { pendingAmount: context.metrics.pendingCompensationAmount ?? null },
        });
      }
      // Approval is open but no ageing was recorded. A governed WARNING is
      // raised and labelled, rather than guessing an age from nothing.
      const amount = context.metrics.pendingCompensationAmount;
      if (context.metrics.compensationApprovalPendingFlag !== true || !isNumber(amount) || amount <= 0) return null;
      return {
        measuredValue: amount,
        unit: 'currency unit',
        threshold: 0,
        severity: 'WARNING',
        triggerExpression: `compensation_approval_pending_flag = true with pending_compensation_amount = ${amount}; no payment ageing recorded`,
        stateBucket: 'WARNING:no-ageing',
        source: 'PROJECT_DATA',
        featureCodes: ['compensation_approval_pending_flag', 'pending_compensation_amount'],
        observedAt: context.asOfAt,
        override: 'NO_AGEING_DATA: severity set by policy because payment_processing_days was not recorded.',
        context: { pendingAmount: amount },
      };
    },
    department: () => ({
      name: 'Finance and Compensation Department',
      basis: 'Statutory owner of compensation assessment and disbursement.',
    }),
    description: (condition) =>
      condition.unit === 'day'
        ? `Compensation has been in processing for ${condition.measuredValue} day(s), at or beyond the ${condition.threshold}-day threshold.`
        : `Compensation approval is open for ${condition.measuredValue} with no payment ageing recorded.`,
    recommendedAction: (condition) =>
      condition.unit === 'day'
        ? 'Escalate the ageing compensation cases to the departmental payment review and confirm a disbursement date.'
        : 'Record the payment processing start date and route the pending approval to the sanctioning officer.',
  },
  {
    type: 'OBJECTIONS_INCREASING',
    label: 'Unresolved objections increasing',
    category: 'STAKEHOLDER',
    featureCodes: ['unresolved_objection_count'],
    detect: (context) => {
      const window = DETECTOR_POLICY.OBJECTIONS_INCREASING.window;
      if (!window) return null;
      const current = context.metrics.unresolvedObjectionCount ?? context.metrics.objectionCount;
      if (!isNumber(current)) return null;
      const baseline = earliestObservation(
        context,
        window.days,
        (metrics) => metrics.unresolvedObjectionCount ?? metrics.objectionCount,
      );
      if (!baseline) return null;
      const increase = current - baseline.value;
      if (increase <= 0) return null;
      return fromLadder('OBJECTIONS_INCREASING', increase, {
        unit: 'objection',
        source: 'OBSERVATION_HISTORY',
        comparisonValue: baseline.value,
        expression: (severity, threshold) =>
          `unresolved_objection_count rose by ${increase} (${baseline.value} to ${current}) in ${window.days} days >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}`,
        observedAt: context.asOfAt,
        context: { from: baseline.value, to: current, windowDays: window.days, since: baseline.at.toISOString() },
      });
    },
    department: () => ({
      name: 'Land Acquisition Cell',
      basis: 'Owner of objection hearings and stakeholder resolution.',
    }),
    description: (condition) =>
      `Unresolved landowner objections rose from ${condition.context?.from} to ${condition.context?.to} over the last ${condition.context?.windowDays} days.`,
    recommendedAction: () =>
      'Schedule hearings for the newly recorded objections and assign a reviewing officer to each.',
  },
  {
    type: 'LEGAL_ISSUE',
    label: 'Legal issue recorded against the acquisition',
    category: 'LEGAL',
    featureCodes: ['stay_order_flag', 'open_legal_case_count', 'legal_dispute_flag'],
    detect: (context) => {
      if (context.metrics.stayOrderFlag === true) {
        return {
          measuredValue: 1,
          unit: 'order',
          threshold: 1,
          severity: 'CRITICAL',
          triggerExpression: 'stay_order_flag = true (governed hard-stop condition)',
          stateBucket: 'CRITICAL:stay-order',
          source: 'PROJECT_DATA',
          featureCodes: ['stay_order_flag'],
          observedAt: context.asOfAt,
          override: 'STAY_ORDER_HARD_STOP: a confirmed stay order is classified CRITICAL regardless of case counts.',
          context: { openLegalCases: context.metrics.openLegalCaseCount ?? null },
        };
      }
      const count = context.metrics.openLegalCaseCount;
      if (isNumber(count) && count > 0) {
        return fromLadder('LEGAL_ISSUE', count, {
          unit: 'case',
          source: 'PROJECT_DATA',
          expression: (severity, threshold) =>
            `open_legal_case_count = ${count} >= ${threshold} (${severity} rung)`,
          bucket: (severity) => `${severity}:cases`,
          observedAt: context.asOfAt,
        });
      }
      if (context.metrics.legalDisputeFlag !== true) return null;
      return {
        measuredValue: 1,
        unit: 'dispute',
        threshold: 1,
        severity: 'WARNING',
        triggerExpression: 'legal_dispute_flag = true with no open_legal_case_count recorded',
        stateBucket: 'WARNING:flag-only',
        source: 'PROJECT_DATA',
        featureCodes: ['legal_dispute_flag'],
        observedAt: context.asOfAt,
        override: 'DISPUTE_FLAG_ONLY: severity set by policy because no case count was recorded.',
      };
    },
    department: () => ({ name: 'Legal Department', basis: 'Statutory owner of litigation and stay-order matters.' }),
    description: (condition) =>
      condition.stateBucket.includes('stay-order')
        ? 'A stay order is recorded as active against this acquisition.'
        : condition.unit === 'case'
          ? `${condition.measuredValue} legal case(s) are open against this acquisition.`
          : 'A legal dispute is flagged against this acquisition with no case count recorded.',
    recommendedAction: (condition) =>
      condition.stateBucket.includes('stay-order')
        ? 'Refer the stay order to the legal department and hold any acquisition step the order restrains.'
        : 'Assign legal representation and record a hearing calendar for the open matters.',
  },
  {
    type: 'DOCUMENT_VERIFICATION_BACKLOG',
    label: 'Document verification backlog',
    category: 'READINESS',
    featureCodes: ['document_verification_pending_count'],
    detect: (context) => {
      const pending = context.metrics.documentVerificationPendingCount;
      if (!isNumber(pending) || pending <= 0) return null;
      return fromLadder('DOCUMENT_VERIFICATION_BACKLOG', pending, {
        unit: 'document',
        source: 'PROJECT_DATA',
        comparisonValue: context.metrics.requiredDocumentCount ?? null,
        expression: (severity, threshold) =>
          `document_verification_pending_count = ${pending} >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}`,
        observedAt: context.asOfAt,
      });
    },
    department: () => ({ name: 'Revenue Department', basis: 'Owner of document verification.' }),
    description: (condition) =>
      `${condition.measuredValue} submitted document(s) are awaiting verification, at or above the ${condition.threshold}-document threshold.`,
    recommendedAction: () => 'Clear the verification backlog and record the outcome for each submitted document.',
  },
  {
    type: 'DEPARTMENT_WORKLOAD_OVERLOAD',
    label: 'Department workload overloaded',
    category: 'CAPACITY',
    featureCodes: ['department_workload_index'],
    detect: (context) => {
      const top = mostLoadedDepartment(context);
      if (!top) return null;
      const index = round(top.workloadIndex);
      return fromLadder('DEPARTMENT_WORKLOAD_OVERLOAD', index, {
        unit: 'workload index',
        source: 'DEPARTMENT_WORKLOAD',
        expression: (severity, threshold) =>
          `department_workload_index for ${top.department} = ${index} >= ${threshold} (${severity} rung)`,
        bucket: (severity) => `${severity}:${top.department}`,
        observedAt: context.asOfAt,
        context: {
          department: top.department,
          openItems: top.openItems ?? null,
          activeProjects: top.activeProjects ?? null,
        },
      });
    },
    department: (context) => {
      const top = mostLoadedDepartment(context);
      return top
        ? { name: top.department, basis: 'Department reporting the highest recorded workload index.' }
        : projectDepartment(context);
    },
    description: (condition) =>
      `${condition.context?.department} is carrying a workload index of ${condition.measuredValue} across ${condition.context?.openItems ?? 'an unrecorded number of'} open items.`,
    recommendedAction: () =>
      'Rebalance the case load or add reviewing officers, and confirm which pending items are reassigned.',
  },
];

export const DETECTOR_BY_TYPE: ReadonlyMap<AlertType, Detector> = new Map(
  DETECTORS.map((detector) => [detector.type, detector]),
);
