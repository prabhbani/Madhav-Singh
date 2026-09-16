/**
 * Early warning system type contract.
 *
 * A detector may only fire on a measured value present in one of the input
 * blocks below. The engine that consumes these types decides whether a detected
 * condition becomes a new alert, updates an existing one, or is suppressed.
 */

import type {
  DepartmentWorkload,
  MilestoneContext,
  PredictionContext,
  ProjectContext,
  ProjectMetrics,
} from '../recommendations/types.js';

export type { DepartmentWorkload, MilestoneContext, PredictionContext, ProjectContext, ProjectMetrics };

export type AlertSeverity = 'INFO' | 'WARNING' | 'HIGH' | 'CRITICAL';

export type AlertStatus = 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED' | 'DISMISSED';

/** The eleven conditions the system watches for. */
export type AlertType =
  | 'MILESTONE_DEADLINE_APPROACHING'
  | 'MILESTONE_OVERDUE'
  | 'RISK_TREND_INCREASING'
  | 'HIGH_DELAY_PROBABILITY'
  | 'CRITICAL_RISK_LEVEL'
  | 'RISK_SCORE_JUMP'
  | 'COMPENSATION_BACKLOG'
  | 'OBJECTIONS_INCREASING'
  | 'LEGAL_ISSUE'
  | 'DOCUMENT_VERIFICATION_BACKLOG'
  | 'DEPARTMENT_WORKLOAD_OVERLOAD';

export type AlertEvidenceSource =
  | 'PROJECT_DATA'
  | 'MILESTONE'
  | 'PREDICTION'
  | 'PREDICTION_HISTORY'
  | 'OBSERVATION_HISTORY'
  | 'DEPARTMENT_WORKLOAD';

// ---------------------------------------------------------------------------
// Input blocks
// ---------------------------------------------------------------------------

/** One past prediction, used by the trend and jump detectors. */
export type PredictionHistoryPoint = {
  predictedAt: Date | string;
  delayProbability: number;
  riskScore?: number;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  predictionId?: string;
};

/** A past measurement of the case, used by the "increasing" detectors. */
export type ObservationHistoryPoint = {
  observedAt: Date | string;
  metrics: ProjectMetrics;
};

/** Officer accountable for a department, resolved from the user directory. */
export type OfficerAssignment = {
  department: string;
  officerId: string;
  officerName: string;
  role?: string;
  districtCode?: string | null;
  stateCode?: string | null;
  /** How this officer was matched; surfaced on the alert for accountability. */
  matchBasis?: string;
};

/** An alert already stored for this project, keyed by detector type. */
export type ExistingAlert = {
  alertId?: string;
  alertType: AlertType | string;
  severity: AlertSeverity;
  status: AlertStatus;
  /** Quantized condition state from the run that last changed this alert. */
  conditionHash: string;
  occurrenceCount?: number;
  firstTriggeredAt?: Date | string;
  lastObservedAt?: Date | string;
  cooldownUntil?: Date | string | null;
  lastNotifiedAt?: Date | string | null;
  acknowledgedAt?: Date | string | null;
  assignedToId?: string | null;
};

export type AlertEvaluationInput = {
  asOfAt: Date | string;
  project: ProjectContext;
  /** The earliest open milestone, treated as the current one. */
  currentMilestone?: MilestoneContext | null;
  /** Open milestones, so a deadline ahead of the current one is still seen. */
  upcomingMilestones?: MilestoneContext[];
  prediction: PredictionContext;
  /** Ordered oldest to newest; the engine sorts defensively regardless. */
  predictionHistory?: PredictionHistoryPoint[];
  observationHistory?: ObservationHistoryPoint[];
  departmentWorkload?: DepartmentWorkload[];
  responsibleOfficers?: OfficerAssignment[];
  existingAlerts?: ExistingAlert[];
};

// ---------------------------------------------------------------------------
// Output blocks
// ---------------------------------------------------------------------------

export type AlertEvidence = {
  measuredValue: number;
  unit: string;
  threshold: number;
  comparisonValue?: number | null;
  source: AlertEvidenceSource;
  featureCodes: string[];
  observedAt: string;
  /** Extra measured values the detector used, for audit. */
  context?: Record<string, number | string | boolean | null>;
};

export type AlertResponsibility = {
  department: string;
  basis: string;
  officerId: string | null;
  officerName: string | null;
};

export type AlertAcknowledgement = {
  status: AlertStatus;
  acknowledgedAt: string | null;
  /** Times the condition has been observed since the alert was first raised. */
  occurrenceCount: number;
  firstTriggeredAt: string;
  lastObservedAt: string;
};

/** What the engine decided to do with a detected or previously stored alert. */
export type AlertDecisionAction =
  | 'CREATED'
  | 'ESCALATED'
  | 'DE_ESCALATED'
  | 'UNCHANGED'
  | 'REOPENED'
  | 'RESOLVED';

export type AlertSuppressionReason =
  | 'NO_CONDITION'
  | 'UNCHANGED_CONDITION'
  | 'COOLDOWN'
  | 'DISMISSED_BY_OFFICER'
  | 'NOTIFICATION_BUDGET'
  /** A stronger alert in the same correlation group already covers this signal. */
  | 'CORRELATED_ALERT'
  /** The case is completed or cancelled, so no warning is due. */
  | 'PROJECT_CLOSED'
  | 'INPUT_UNAVAILABLE';

export type DetectedAlert = {
  alertType: AlertType;
  label: string;
  category: string;
  project: { projectId: string; projectCode: string | null; name: string | null };
  severity: AlertSeverity;
  severityBasis: 'THRESHOLD_LADDER' | 'POLICY_OVERRIDE';
  appliedOverrides: string[];
  /** The condition expression that fired, with measured value and threshold. */
  trigger: string;
  triggeredAt: string;
  description: string;
  recommendedAction: string;
  responsible: AlertResponsibility;
  acknowledgement: AlertAcknowledgement;
  evidence: AlertEvidence;
  /** Quantized condition state; an unchanged hash means an unchanged condition. */
  conditionHash: string;
  decision: AlertDecisionAction;
  decisionReason: string;
  /** Whether this run should push a notification for this alert. */
  notify: boolean;
  notifyBasis: string;
  cooldownUntil: string | null;
  previousSeverity: AlertSeverity | null;
  limitations: string[];
};

export type SuppressedAlert = {
  alertType: AlertType;
  reason: AlertSuppressionReason;
  detail: string;
  severity: AlertSeverity | null;
};

export type ResolvedAlert = {
  alertType: AlertType;
  previousSeverity: AlertSeverity;
  reason: string;
};

export type AlertDataQuality = {
  dataOrigin: string | null;
  predictionStatus: string;
  confidenceBand: string | null;
  missingInputBlocks: string[];
  warnings: string[];
};

export type AlertEvaluationResult = {
  projectId: string;
  asOfAt: string;
  generatedAt: string;
  policyVersion: string;
  detectorVersion: string;
  /** Live alerts after this evaluation, most severe first. */
  alerts: DetectedAlert[];
  /** The subset this run should push, after cooldown and budget controls. */
  notifications: DetectedAlert[];
  resolved: ResolvedAlert[];
  suppressed: SuppressedAlert[];
  dataQuality: AlertDataQuality;
  summary: {
    evaluatedDetectors: number;
    created: number;
    escalated: number;
    deEscalated: number;
    unchanged: number;
    reopened: number;
    resolved: number;
    suppressed: number;
    notified: number;
    bySeverity: Record<AlertSeverity, number>;
  };
};
