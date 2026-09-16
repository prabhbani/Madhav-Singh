/**
 * Edge-case fixtures.
 *
 * Each scenario is a realistic case record that has broken something, or could.
 * They are shared by the recommendation, alert, and feature-engineering suites so
 * one awkward shape is exercised by every engine that has to survive it.
 *
 * Values are plausible for Indian land acquisition: parcel and landowner counts,
 * compensation in rupees, and the stage names used by the acquisition workflow.
 */

import type { ProjectMetrics } from '../../src/recommendations/types.js';

export const AS_OF = new Date('2026-09-16T09:00:00.000Z');

export const daysFrom = (offset: number): Date => new Date(AS_OF.getTime() + offset * 86_400_000);

export type EdgeCase = {
  /** Short name used in test output. */
  name: string;
  /** What about this shape has broken software before. */
  hazard: string;
  metrics: ProjectMetrics;
  /** Extra context some engines need, applied by the caller. */
  context?: {
    status?: string;
    targetDate?: Date | null;
    plannedStartDate?: Date | null;
    milestonePlannedAt?: Date | null;
    milestoneStatus?: string;
    completedAt?: Date | null;
  };
};

/**
 * A corridor acquisition with nothing unusual about it. Used as the control:
 * if an assertion fails here, the problem is not the edge case.
 */
export const NOMINAL: EdgeCase = {
  name: 'nominal corridor acquisition',
  hazard: 'none; this is the control case',
  metrics: {
    parcelCount: 184,
    affectedLandownerCount: 267,
    unresolvedRecordCount: 23,
    objectionCount: 18,
    unresolvedObjectionCount: 14,
    requiredDocumentCount: 16,
    missingDocumentCount: 4,
    invalidDocumentCount: 1,
    documentVerificationPendingCount: 6,
    pendingApprovalCount: 3,
    pendingCompensationAmount: 184_000_000,
    paymentProcessingDays: 62,
    openLegalCaseCount: 2,
    daysInCurrentStage: 74,
    averageStageDurationDays: 40,
    overdueDays: 26,
    milestoneSlippageCount: 2,
    daysSinceLastUpdate: 4,
  },
  context: { status: 'ACTIVE', targetDate: daysFrom(60), milestonePlannedAt: daysFrom(-26) },
};

/**
 * A government-land transfer: the corridor crosses only public land, so there is
 * no one to compensate. Every per-owner rate and average is a division by zero.
 */
export const ZERO_LANDOWNERS: EdgeCase = {
  name: 'zero landowners',
  hazard: 'per-owner averages divide by zero; "no objections" must not read as "no data"',
  metrics: {
    parcelCount: 12,
    affectedLandownerCount: 0,
    unresolvedRecordCount: 0,
    objectionCount: 0,
    unresolvedObjectionCount: 0,
    requiredDocumentCount: 6,
    missingDocumentCount: 0,
    documentVerificationPendingCount: 0,
    pendingApprovalCount: 1,
    daysInCurrentStage: 12,
    averageStageDurationDays: 30,
    milestoneSlippageCount: 0,
    daysSinceLastUpdate: 2,
  },
  context: { status: 'ACTIVE', targetDate: daysFrom(200), milestonePlannedAt: daysFrom(40) },
};

/**
 * Compensation was never assessed for this case. The absence of a figure must
 * not be read as a figure of zero, which would silently clear the backlog check.
 */
export const MISSING_COMPENSATION: EdgeCase = {
  name: 'missing compensation data',
  hazard: 'an absent amount must not be treated as zero, nor as an ageing backlog',
  metrics: {
    parcelCount: 91,
    affectedLandownerCount: 126,
    unresolvedRecordCount: 8,
    unresolvedObjectionCount: 3,
    requiredDocumentCount: 14,
    missingDocumentCount: 2,
    documentVerificationPendingCount: 4,
    daysInCurrentStage: 31,
    averageStageDurationDays: 35,
    milestoneSlippageCount: 1,
    daysSinceLastUpdate: 6,
    // pendingCompensationAmount, paymentProcessingDays, and the approval flag are
    // all absent, which is what "never assessed" looks like in the record.
  },
  context: { status: 'ACTIVE', targetDate: daysFrom(90), milestonePlannedAt: daysFrom(20) },
};

/**
 * A newly notified acquisition. Nothing has happened yet, so there is no
 * prediction history, no observation history, and no completed comparable cases.
 */
export const NO_HISTORY: EdgeCase = {
  name: 'no historical data',
  hazard: 'trend and increase detectors have nothing to compare against',
  metrics: {
    parcelCount: 44,
    affectedLandownerCount: 51,
    unresolvedRecordCount: 44,
    unresolvedObjectionCount: 0,
    requiredDocumentCount: 12,
    missingDocumentCount: 12,
    documentVerificationPendingCount: 0,
    daysInCurrentStage: 3,
    milestoneSlippageCount: 0,
    daysSinceLastUpdate: 0,
  },
  context: { status: 'ACTIVE', targetDate: daysFrom(365), milestonePlannedAt: daysFrom(120) },
};

/**
 * A multi-district expressway. Counts are two to three orders of magnitude above
 * the usual, which is where unbounded severity ramps and integer assumptions
 * tend to fail.
 */
export const EXTREMELY_LARGE: EdgeCase = {
  name: 'extremely large project',
  hazard: 'counts far past every threshold; severity must saturate rather than overflow or rank absurdly',
  metrics: {
    parcelCount: 48_500,
    affectedLandownerCount: 96_700,
    unresolvedRecordCount: 12_400,
    objectionCount: 8_900,
    unresolvedObjectionCount: 7_350,
    requiredDocumentCount: 62_000,
    missingDocumentCount: 19_800,
    invalidDocumentCount: 2_100,
    documentVerificationPendingCount: 14_600,
    pendingApprovalCount: 340,
    blockedDependencyCount: 87,
    pendingCompensationAmount: 92_400_000_000,
    paymentProcessingDays: 890,
    openLegalCaseCount: 213,
    daysInCurrentStage: 1_460,
    averageStageDurationDays: 120,
    overdueDays: 1_100,
    milestoneSlippageCount: 47,
    daysSinceLastUpdate: 210,
  },
  context: { status: 'ACTIVE', targetDate: daysFrom(-400), milestonePlannedAt: daysFrom(-1_100) },
};

/** The case file is empty: every required document is outstanding. */
export const MISSING_DOCUMENTS: EdgeCase = {
  name: 'missing documents',
  hazard: 'completeness ratio is zero; the gap must be reported without dividing by a missing total',
  metrics: {
    parcelCount: 27,
    affectedLandownerCount: 34,
    requiredDocumentCount: 18,
    missingDocumentCount: 18,
    invalidDocumentCount: 0,
    documentVerificationPendingCount: 0,
    unresolvedObjectionCount: 0,
    daysInCurrentStage: 9,
    averageStageDurationDays: 25,
    milestoneSlippageCount: 0,
    daysSinceLastUpdate: 1,
  },
  context: { status: 'ACTIVE', targetDate: daysFrom(150), milestonePlannedAt: daysFrom(30) },
};

/**
 * Possession was taken and the case is closed. Stale counters left on a finished
 * record must not raise fresh work for an officer.
 */
export const ALREADY_COMPLETED: EdgeCase = {
  name: 'project already completed',
  hazard: 'a closed case must not generate new actions or alerts from leftover counters',
  metrics: {
    parcelCount: 62,
    affectedLandownerCount: 78,
    unresolvedRecordCount: 0,
    unresolvedObjectionCount: 0,
    requiredDocumentCount: 16,
    missingDocumentCount: 0,
    documentVerificationPendingCount: 0,
    pendingCompensationAmount: 0,
    paymentProcessingDays: 0,
    openLegalCaseCount: 0,
    daysInCurrentStage: 0,
    milestoneSlippageCount: 3,
    daysSinceLastUpdate: 45,
  },
  context: {
    status: 'COMPLETED',
    targetDate: daysFrom(-30),
    milestoneStatus: 'COMPLETED',
    completedAt: daysFrom(-31),
    milestonePlannedAt: daysFrom(-40),
  },
};

/**
 * A data-entry error: the target date precedes the start date, and the milestone
 * is planned after the project is due to finish.
 */
export const CONFLICTING_DATES: EdgeCase = {
  name: 'conflicting dates',
  hazard: 'target before start, milestone after target; date arithmetic can go negative',
  metrics: {
    parcelCount: 116,
    affectedLandownerCount: 159,
    unresolvedRecordCount: 11,
    unresolvedObjectionCount: 6,
    requiredDocumentCount: 20,
    missingDocumentCount: 3,
    documentVerificationPendingCount: 5,
    daysInCurrentStage: 88,
    averageStageDurationDays: 45,
    milestoneSlippageCount: 4,
    daysSinceLastUpdate: 12,
  },
  context: {
    status: 'ACTIVE',
    plannedStartDate: daysFrom(120),
    targetDate: daysFrom(-90),
    milestonePlannedAt: daysFrom(200),
  },
};

/**
 * A partially migrated record. Optional fields are explicitly null rather than
 * absent, which is a different shape and a common source of crashes.
 */
export const NULL_VALUES: EdgeCase = {
  name: 'null values',
  hazard: 'explicit nulls rather than absent keys; arithmetic on null yields zero, not an error',
  metrics: {
    parcelCount: 55,
    affectedLandownerCount: undefined,
    unresolvedRecordCount: undefined,
    objectionCount: undefined,
    unresolvedObjectionCount: undefined,
    requiredDocumentCount: undefined,
    missingDocumentCount: undefined,
    pendingCompensationAmount: undefined,
    paymentProcessingDays: undefined,
    openLegalCaseCount: undefined,
    daysInCurrentStage: undefined,
    averageStageDurationDays: undefined,
    overdueDays: undefined,
    milestoneSlippageCount: undefined,
    daysSinceLastUpdate: undefined,
  },
  context: { status: 'ACTIVE', targetDate: null, milestonePlannedAt: null },
};

/**
 * The same case imported twice. The engines must produce one action and one
 * alert per condition, not two.
 */
export const DUPLICATE_RECORDS: EdgeCase = {
  name: 'duplicate records',
  hazard: 'a repeated import must not double-count evidence or raise a second alert',
  metrics: { ...NOMINAL.metrics },
  context: { ...NOMINAL.context },
};

export const EDGE_CASES: readonly EdgeCase[] = [
  NOMINAL,
  ZERO_LANDOWNERS,
  MISSING_COMPENSATION,
  NO_HISTORY,
  EXTREMELY_LARGE,
  MISSING_DOCUMENTS,
  ALREADY_COMPLETED,
  CONFLICTING_DATES,
  NULL_VALUES,
  DUPLICATE_RECORDS,
];

/** A metrics object whose every value is a hostile number. */
export const HOSTILE_NUMBERS: ProjectMetrics = {
  parcelCount: Number.NaN,
  affectedLandownerCount: Number.POSITIVE_INFINITY,
  unresolvedRecordCount: Number.NEGATIVE_INFINITY,
  unresolvedObjectionCount: Number.MAX_SAFE_INTEGER,
  missingDocumentCount: -1,
  paymentProcessingDays: Number.NaN,
  daysInCurrentStage: Number.POSITIVE_INFINITY,
  averageStageDurationDays: 0,
  overdueDays: -50,
  milestoneSlippageCount: Number.NaN,
};
