/**
 * Versioned recommendation policy.
 *
 * Every number the engine uses to rank, prioritize, or schedule an action lives
 * here. Nothing is hardcoded inside the scoring logic, so a policy change is a
 * reviewable configuration change with a version that is stamped onto every
 * emitted recommendation.
 */
export const POLICY_VERSION = 'recommendation-policy-v1';
export const CATALOG_VERSION = 'recommendation-catalog-v1';
/**
 * Ranking component weights. They sum to 1 so the ranking score stays in [0,1]
 * and remains comparable across projects.
 */
export const RANKING_WEIGHTS = {
    /** How far the measured value exceeds its materiality threshold. */
    evidenceSeverity: 0.3,
    /** Relative contribution of the model factors linked to this evidence. */
    modelLinkage: 0.22,
    /** Deadline pressure from overdue days, task age, and the project target. */
    urgency: 0.18,
    /** Policy-approved base importance of the evidence code. */
    policyWeight: 0.15,
    /** Calibrated delay probability for the project. */
    predictedRisk: 0.09,
    /** Observed outcome lift for this evidence in completed cases. */
    historicalSupport: 0.06,
};
/** Priority bands applied to the ranking score, before documented overrides. */
export const PRIORITY_BANDS = [
    { min: 0.72, priority: 'CRITICAL' },
    { min: 0.52, priority: 'HIGH' },
    { min: 0.32, priority: 'MEDIUM' },
    { min: 0, priority: 'LOW' },
];
/** Deadline shortening factor per priority band. */
export const DEADLINE_URGENCY_FACTOR = {
    CRITICAL: 0.4,
    HIGH: 0.65,
    MEDIUM: 1,
    LOW: 1.25,
};
export const ENGINE_LIMITS = {
    /** Evidence below this normalized severity is recorded but not emitted. */
    materialitySeverity: 0.12,
    /** Maximum actions returned; the remainder is reported as suppressed. */
    maxRecommendations: 8,
    /** Model factors above this rank count as "top" for the override rule. */
    topFactorRankForOverride: 3,
    minDeadlineDays: 2,
    maxDeadlineDays: 90,
    /** Workload index above which a capacity note and action are raised. */
    workloadEscalationThreshold: 0.85,
    /** Each unit of workload index adds this share to the suggested deadline. */
    workloadDeadlineCoefficient: 0.5,
    /** Default planning horizon used when the prediction omits one. */
    defaultHorizonDays: 90,
    /** Minimum completed cases before an outcome rate is used for ranking. */
    minHistoricalSampleSize: 30,
};
export const CODE_POLICY = {
    ACTIVE_STAY_ORDER: { weight: 1, slaDays: 3, threshold: 1, hardStop: true },
    OPEN_LEGAL_CASE_COUNT: { weight: 0.82, slaDays: 10, threshold: 3 },
    OWNERSHIP_UNRESOLVED: { weight: 0.9, slaDays: 14, threshold: 15 },
    COMPENSATION_PENDING: { weight: 0.85, slaDays: 15, threshold: 45 },
    PENDING_APPROVAL_COUNT: { weight: 0.8, slaDays: 7, threshold: 4 },
    MILESTONE_OVERDUE: { weight: 0.86, slaDays: 7, threshold: 21 },
    OPEN_OBJECTION_COUNT: { weight: 0.78, slaDays: 21, threshold: 12 },
    MISSING_DOCUMENT_COUNT: { weight: 0.75, slaDays: 10, threshold: 5 },
    BLOCKED_DEPENDENCY_COUNT: { weight: 0.72, slaDays: 12, threshold: 3 },
    MILESTONE_SLIPPAGE_COUNT: { weight: 0.7, slaDays: 14, threshold: 3 },
    STAGE_AGING: { weight: 0.68, slaDays: 14, threshold: 1 },
    INVALID_DOCUMENT_COUNT: { weight: 0.62, slaDays: 12, threshold: 3 },
    DOCUMENT_VERIFICATION_PENDING: { weight: 0.55, slaDays: 14, threshold: 8 },
    DEPARTMENT_CAPACITY: { weight: 0.6, slaDays: 21, threshold: 0.85 },
    STALE_CASE_DATA: { weight: 0.45, slaDays: 5, threshold: 30 },
};
// ---------------------------------------------------------------------------
// Severity functions
// ---------------------------------------------------------------------------
export const clamp = (value, min = 0, max = 1) => Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
/** Linear ramp of a count against its policy threshold. */
export const ratioSeverity = (value, threshold) => threshold <= 0 ? (value > 0 ? 1 : 0) : clamp(value / threshold);
/**
 * Logistic ramp for ageing measures. Returns 0.5 at the tolerance point and
 * approaches 1 as the measured value exceeds it by several scale units.
 */
export const sigmoidSeverity = (value, tolerance, scale) => {
    const safeScale = scale > 0 ? scale : 1;
    return clamp(1 / (1 + Math.exp(-((value - tolerance) / safeScale))));
};
/** Ramp of an actual duration against a historical baseline duration. */
export const baselineRatioSeverity = (value, baseline) => baseline <= 0 ? 0 : clamp(value / baseline - 1);
/** Binary condition, used only for governed flags such as a stay order. */
export const flagSeverity = (flag) => (flag ? 1 : 0);
/**
 * Constants for deriving engine inputs from the operational database.
 *
 * These describe how stored rows are turned into a workload measurement. They
 * are separate from the ranking policy above so a reviewer can change how
 * capacity is measured without touching how actions are ranked.
 */
export const WORKLOAD_DERIVATION = {
    /** Open items one active project is assumed to absorb before saturation. */
    openItemsPerActiveProjectCapacity: 6,
    /** Capacity assumed for a department that owns no active project. */
    baselineCapacityItems: 6,
};
