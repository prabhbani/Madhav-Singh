/**
 * Recommendation engine type contract.
 *
 * Everything the engine emits must be derivable from one of the input blocks
 * below. The engine never invents an action for which no evidence was supplied.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Priority = RiskLevel;

/** Lifecycle of a recommendation once officials act on it. */
export type RecommendationStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'ASSIGNED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'DISMISSED'
  | 'EXPIRED';

/** Where a measured value physically came from. Used for traceability. */
export type EvidenceSource =
  | 'PROJECT_DATA'
  | 'MILESTONE'
  | 'PENDING_TASKS'
  | 'MODEL_FACTOR'
  | 'HISTORICAL_PATTERN'
  | 'DEPARTMENT_WORKLOAD';

/** Stable evidence codes. Each maps to dataset/feature columns, never free text. */
export type EvidenceCode =
  | 'OWNERSHIP_UNRESOLVED'
  | 'OPEN_OBJECTION_COUNT'
  | 'MISSING_DOCUMENT_COUNT'
  | 'INVALID_DOCUMENT_COUNT'
  | 'DOCUMENT_VERIFICATION_PENDING'
  | 'PENDING_APPROVAL_COUNT'
  | 'COMPENSATION_PENDING'
  | 'ACTIVE_STAY_ORDER'
  | 'OPEN_LEGAL_CASE_COUNT'
  | 'MILESTONE_OVERDUE'
  | 'MILESTONE_SLIPPAGE_COUNT'
  | 'STAGE_AGING'
  | 'BLOCKED_DEPENDENCY_COUNT'
  | 'DEPARTMENT_CAPACITY'
  | 'STALE_CASE_DATA';

// ---------------------------------------------------------------------------
// Input blocks
// ---------------------------------------------------------------------------

/** Measured case attributes. Names mirror the ML feature columns. */
export type ProjectMetrics = {
  parcelCount?: number;
  affectedLandownerCount?: number;
  unresolvedRecordCount?: number;
  disputedOwnershipFlag?: boolean;
  objectionCount?: number;
  unresolvedObjectionCount?: number;
  requiredDocumentCount?: number;
  missingDocumentCount?: number;
  invalidDocumentCount?: number;
  documentVerificationPendingCount?: number;
  pendingApprovalCount?: number;
  blockedDependencyCount?: number;
  pendingCompensationAmount?: number;
  compensationApprovalPendingFlag?: boolean;
  paymentProcessingDays?: number;
  openLegalCaseCount?: number;
  legalDisputeFlag?: boolean;
  stayOrderFlag?: boolean;
  daysInCurrentStage?: number;
  averageStageDurationDays?: number;
  overdueDays?: number;
  milestoneSlippageCount?: number;
  daysSinceLastUpdate?: number;
};

export type ProjectContext = {
  projectId: string;
  projectCode?: string;
  name?: string;
  state?: string;
  district?: string;
  /** Owning department of the project as a whole. */
  department: string;
  projectType?: string;
  priority?: Priority;
  status?: string;
  targetDate?: Date | string | null;
  dataOrigin?: string;
  metrics?: ProjectMetrics;
};

export type MilestoneContext = {
  milestoneId?: string;
  name: string;
  status?: string;
  plannedAt?: Date | string | null;
  completedAt?: Date | string | null;
  /** Department accountable for this milestone, when recorded. */
  ownerDepartment?: string | null;
  /** Supplied by the caller, or derived from plannedAt against asOfAt. */
  overdueDays?: number;
  stage?: string;
};

export type PredictionContext = {
  predictionId?: string;
  /** Governed combined risk score in [0,1]. Falls back to delayProbability. */
  riskScore?: number;
  riskLevel: RiskLevel;
  /** Calibrated P(significant delay within horizon), in [0,1]. */
  delayProbability: number;
  expectedDelayDays?: number | null;
  horizonDays?: number;
  confidenceBand?: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  predictionStatus?: 'OK' | 'STALE' | 'RULE_ONLY_FALLBACK' | 'DEGRADED';
  modelVersion?: string;
  policyVersion?: string;
  predictedAt?: Date | string;
};

export type RiskFactorContext = {
  factorCode: string;
  label?: string;
  direction?: 'INCREASES_RISK' | 'REDUCES_RISK' | 'NEUTRAL';
  /** abs(contribution) / sum(abs(contributions)), in [0,1]. */
  relativeContribution?: number;
  currentValue?: number | null;
  comparisonValue?: number | null;
  source?: 'ML' | 'RULE' | 'ML_AND_RULE';
  evidenceAt?: Date | string;
  explanation?: string;
};

/** Outcome rates observed for completed cases, per evidence code. */
export type EvidenceOutcomeRate = {
  delayRateWhenPresent: number;
  delayRateWhenAbsent: number;
  sampleSize: number;
};

export type HistoricalPatterns = {
  departmentDelayRate?: number;
  districtDelayRate?: number;
  projectTypeDelayRate?: number;
  averageStageDurationDays?: number;
  /** Keyed by EvidenceCode; the strongest form of historical support. */
  evidenceOutcomeRates?: Partial<Record<EvidenceCode, EvidenceOutcomeRate>>;
  /** Median days similar cases took to clear an evidence code, when known. */
  medianResolutionDays?: Partial<Record<EvidenceCode, number>>;
  observedAt?: Date | string;
};

export type PendingTask = {
  /** Should match an EvidenceCode where the task is a known bottleneck type. */
  taskCode: string;
  label?: string;
  /** Number of outstanding units, e.g. 23 unverified parcels. */
  count: number;
  unit?: string;
  ownerDepartment?: string | null;
  /** Age in days of the oldest outstanding unit. */
  oldestAgeDays?: number;
  dueAt?: Date | string | null;
};

export type DepartmentWorkload = {
  department: string;
  /** Normalized utilisation in [0,1]; >1 is clamped and reported as saturated. */
  workloadIndex: number;
  openItems?: number;
  activeProjects?: number;
  observedAt?: Date | string;
};

/** An existing stored recommendation, so officer-set status is not reset. */
export type ExistingRecommendation = {
  evidenceCode: string;
  status: RecommendationStatus;
  dueAt?: Date | string | null;
};

export type RecommendationInput = {
  asOfAt: Date | string;
  project: ProjectContext;
  currentMilestone?: MilestoneContext | null;
  prediction: PredictionContext;
  topRiskFactors?: RiskFactorContext[];
  historicalPatterns?: HistoricalPatterns | null;
  pendingTasks?: PendingTask[];
  departmentWorkload?: DepartmentWorkload[];
  existingRecommendations?: ExistingRecommendation[];
};

// ---------------------------------------------------------------------------
// Output blocks
// ---------------------------------------------------------------------------

export type EvidenceObservation = {
  code: EvidenceCode;
  label: string;
  measuredValue: number;
  unit: string;
  /** Baseline the measurement is compared against, when one exists. */
  comparisonValue?: number | null;
  /** Policy threshold at which the evidence becomes material. */
  threshold: number;
  /** Normalized materiality in [0,1] from the documented severity function. */
  severity: number;
  severityFunction: string;
  source: EvidenceSource;
  observedAt: string;
  /** Feature/column names the measurement was read from. */
  featureCodes: string[];
  description: string;
};

export type RelatedRiskFactor = {
  factorCode: string;
  label: string;
  direction: 'INCREASES_RISK' | 'REDUCES_RISK' | 'NEUTRAL';
  relativeContribution: number | null;
  rank: number | null;
  source: 'ML' | 'RULE' | 'ML_AND_RULE';
  evidenceAt: string | null;
};

export type ScoreBreakdown = {
  evidenceSeverity: number;
  modelLinkage: number;
  urgency: number;
  policyWeight: number;
  predictedRisk: number;
  historicalSupport: number;
  weights: Record<string, number>;
  /** Plain-language note for each component, for audit screens. */
  notes: string[];
};

export type SuggestedDeadline = {
  days: number;
  dueAt: string;
  baseSlaDays: number;
  basis: string;
};

export type Traceability = {
  evidenceCode: EvidenceCode;
  featureCodes: string[];
  inputSources: EvidenceSource[];
  modelVersion: string | null;
  predictionId: string | null;
  policyVersion: string;
  catalogVersion: string;
  dataOrigin: string | null;
  generatedAt: string;
};

export type RecommendedAction = {
  recommendationId: string;
  rank: number;
  priority: Priority;
  priorityBasis: 'RANKING_SCORE' | 'POLICY_OVERRIDE';
  appliedOverrides: string[];
  action: string;
  reason: string;
  relatedRiskFactor: RelatedRiskFactor | null;
  responsibleDepartment: string;
  departmentBasis: string;
  suggestedDeadline: SuggestedDeadline;
  expectedImpact: string;
  impactCategory: string;
  status: RecommendationStatus;
  statusBasis: string;
  rankingScore: number;
  scoreBreakdown: ScoreBreakdown;
  evidence: EvidenceObservation;
  capacityNote: string | null;
  limitations: string[];
};

export type SuppressedRecommendation = {
  evidenceCode: EvidenceCode;
  /** `PROJECT_CLOSED`: the case is completed or cancelled, so no action is due. */
  reason: 'NO_EVIDENCE' | 'BELOW_MATERIALITY_THRESHOLD' | 'BELOW_RANK_CUTOFF' | 'INPUT_UNAVAILABLE' | 'PROJECT_CLOSED';
  detail: string;
};

export type RecommendationDataQuality = {
  dataOrigin: string | null;
  predictionStatus: string;
  confidenceBand: string | null;
  missingInputBlocks: string[];
  warnings: string[];
};

export type RecommendationResult = {
  projectId: string;
  asOfAt: string;
  generatedAt: string;
  policyVersion: string;
  catalogVersion: string;
  currentMilestone: string | null;
  riskLevel: RiskLevel;
  delayProbability: number;
  recommendations: RecommendedAction[];
  suppressed: SuppressedRecommendation[];
  dataQuality: RecommendationDataQuality;
  summary: {
    evaluatedCodes: number;
    emitted: number;
    byPriority: Record<Priority, number>;
  };
  limitations: string[];
};
