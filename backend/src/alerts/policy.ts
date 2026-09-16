/**
 * Versioned early warning policy.
 *
 * Thresholds, severity ladders, cooldowns, and the notification budget all live
 * here. Changing when officers get paged is a reviewable configuration change
 * with a version stamped onto every alert it produces.
 */

import type { AlertSeverity, AlertType } from './types.js';

export const ALERT_POLICY_VERSION = 'early-warning-policy-v1';
export const DETECTOR_VERSION = 'early-warning-detectors-v1';

export const SEVERITY_ORDER: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 };

export const SEVERITIES: readonly AlertSeverity[] = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'];

/**
 * A severity ladder. `direction` says which way is worse:
 * `ASCENDING` fires when the measured value is at or above a rung,
 * `DESCENDING` fires when it is at or below one.
 */
export type SeverityLadder = {
  direction: 'ASCENDING' | 'DESCENDING';
  INFO: number;
  WARNING: number;
  HIGH: number;
  CRITICAL: number;
};

/**
 * Cooldown before the same alert may notify again, in hours.
 *
 * A severity escalation always breaks the cooldown: suppressing a CRITICAL
 * because a WARNING paged an hour earlier is exactly the failure mode that
 * makes an early warning system unsafe rather than merely noisy.
 */
export const COOLDOWN_HOURS: Record<AlertSeverity, number> = {
  INFO: 168,
  WARNING: 72,
  HIGH: 24,
  CRITICAL: 6,
};

export const NOTIFICATION_POLICY = {
  /** Alerts below this severity populate the centre but do not push. */
  minSeverityToNotify: 'WARNING' as AlertSeverity,
  /** Maximum pushes per project per run, before exemptions. */
  maxNotificationsPerProjectPerRun: 3,
  /** Severities that bypass the per-run budget entirely. */
  budgetExemptSeverities: ['HIGH', 'CRITICAL'] as readonly AlertSeverity[],
  /**
   * A dismissal holds for the condition the officer judged. It is not re-raised
   * on a timer, but a severity escalation does re-raise it: a dismissed WARNING
   * that becomes CRITICAL is a different decision from the one they made.
   */
  reRaiseDismissedOnEscalation: true,
} as const;

/**
 * Model-derived detectors are capped at WARNING when the prediction is stale,
 * rule-only, or low confidence. A degraded model must not page an officer at
 * CRITICAL on the strength of its own degraded output.
 */
export const MODEL_DERIVED_DETECTORS: readonly AlertType[] = [
  'RISK_TREND_INCREASING',
  'HIGH_DELAY_PROBABILITY',
  'CRITICAL_RISK_LEVEL',
  'RISK_SCORE_JUMP',
];

export const DEGRADED_PREDICTION_SEVERITY_CAP: AlertSeverity = 'WARNING';

/** Per-detector configuration. Every number an alert depends on is here. */
export type DetectorPolicy = {
  ladder: SeverityLadder;
  /** Minimum absolute change in the measured value recorded as a material move. */
  materialDelta: number;
  /** Window and sample requirements for detectors that read history. */
  window?: { days: number; minPoints: number; minRisingShare?: number };
};

export const DETECTOR_POLICY: Record<AlertType, DetectorPolicy> = {
  // Days remaining until the milestone plan date. Fewer days is worse.
  MILESTONE_DEADLINE_APPROACHING: {
    ladder: { direction: 'DESCENDING', INFO: 14, WARNING: 7, HIGH: 3, CRITICAL: 1 },
    materialDelta: 1,
  },
  // Days past the milestone plan date. More days is worse.
  MILESTONE_OVERDUE: {
    ladder: { direction: 'ASCENDING', INFO: 1, WARNING: 7, HIGH: 21, CRITICAL: 45 },
    materialDelta: 3,
  },
  // Sustained rise in delay probability across a window of past predictions.
  RISK_TREND_INCREASING: {
    ladder: { direction: 'ASCENDING', INFO: 0.05, WARNING: 0.1, HIGH: 0.18, CRITICAL: 0.28 },
    materialDelta: 0.03,
    window: { days: 45, minPoints: 3, minRisingShare: 0.6 },
  },
  // Calibrated probability of significant delay within the horizon.
  HIGH_DELAY_PROBABILITY: {
    ladder: { direction: 'ASCENDING', INFO: 0.5, WARNING: 0.6, HIGH: 0.75, CRITICAL: 0.85 },
    materialDelta: 0.05,
  },
  // Fires only on a governed CRITICAL risk classification.
  CRITICAL_RISK_LEVEL: {
    ladder: { direction: 'ASCENDING', INFO: 1, WARNING: 1, HIGH: 1, CRITICAL: 1 },
    materialDelta: 1,
  },
  // Single-step rise against the immediately preceding prediction.
  RISK_SCORE_JUMP: {
    ladder: { direction: 'ASCENDING', INFO: 0.05, WARNING: 0.08, HIGH: 0.12, CRITICAL: 0.2 },
    materialDelta: 0.03,
    window: { days: 21, minPoints: 2 },
  },
  // Days compensation has been in processing.
  COMPENSATION_BACKLOG: {
    ladder: { direction: 'ASCENDING', INFO: 30, WARNING: 45, HIGH: 75, CRITICAL: 120 },
    materialDelta: 7,
  },
  // Net increase in unresolved objections across the observation window.
  OBJECTIONS_INCREASING: {
    ladder: { direction: 'ASCENDING', INFO: 1, WARNING: 3, HIGH: 6, CRITICAL: 12 },
    materialDelta: 1,
    window: { days: 60, minPoints: 2 },
  },
  // Open legal cases. A confirmed stay order overrides this ladder.
  LEGAL_ISSUE: {
    ladder: { direction: 'ASCENDING', INFO: 1, WARNING: 2, HIGH: 4, CRITICAL: 7 },
    materialDelta: 1,
  },
  // Submitted documents awaiting verification.
  DOCUMENT_VERIFICATION_BACKLOG: {
    ladder: { direction: 'ASCENDING', INFO: 3, WARNING: 8, HIGH: 15, CRITICAL: 25 },
    materialDelta: 3,
  },
  // Normalized department workload index.
  DEPARTMENT_WORKLOAD_OVERLOAD: {
    ladder: { direction: 'ASCENDING', INFO: 0.75, WARNING: 0.85, HIGH: 0.95, CRITICAL: 1.1 },
    materialDelta: 0.05,
  },
};

/**
 * Maps a measured value onto the ladder.
 *
 * Returns null when the value has not reached the INFO rung, which means there
 * is no condition to report rather than a low-severity one.
 */
export const severityFromLadder = (value: number, ladder: SeverityLadder): AlertSeverity | null => {
  if (!Number.isFinite(value)) return null;
  const meets = (rung: number): boolean => (ladder.direction === 'ASCENDING' ? value >= rung : value <= rung);
  if (meets(ladder.CRITICAL)) return 'CRITICAL';
  if (meets(ladder.HIGH)) return 'HIGH';
  if (meets(ladder.WARNING)) return 'WARNING';
  if (meets(ladder.INFO)) return 'INFO';
  return null;
};

/** The ladder rung a severity corresponds to, used in the trigger expression. */
export const ladderThreshold = (ladder: SeverityLadder, severity: AlertSeverity): number => ladder[severity];

export const higherSeverity = (left: AlertSeverity, right: AlertSeverity): AlertSeverity =>
  SEVERITY_ORDER[left] >= SEVERITY_ORDER[right] ? left : right;

export const lowerSeverity = (left: AlertSeverity, right: AlertSeverity): AlertSeverity =>
  SEVERITY_ORDER[left] <= SEVERITY_ORDER[right] ? left : right;
