/**
 * Shared derivations from the operational tables.
 *
 * The recommendation engine and the early warning system must see the same
 * numbers, so the conversion from stored rows to measured values lives here
 * rather than being written twice.
 *
 * These functions derive only what the schema can actually evidence. Where a
 * measurement is not recorded anywhere, they return undefined, and the engines
 * report the gap instead of assuming a value.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { WORKLOAD_DERIVATION } from '../recommendations/policy.js';
import type {
  DepartmentWorkload,
  HistoricalPatterns,
  MilestoneContext,
  PendingTask,
  ProjectMetrics,
  RiskFactorContext,
} from '../recommendations/types.js';

export const MS_PER_DAY = 86_400_000;

export const OPEN_ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS'] as const;
export const OPEN_RECOMMENDATION_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'ASSIGNED', 'IN_PROGRESS'] as const;

export type ProjectWithRelations = Prisma.ProjectGetPayload<{
  include: { milestones: true; documents: true; predictions: true; recommendations: true };
}>;

export const projectInclude = {
  milestones: true,
  documents: true,
  predictions: { orderBy: { predictedAt: 'desc' }, take: 40 },
  recommendations: true,
} satisfies Prisma.ProjectInclude;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const toNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Prisma.Decimal) return value.toNumber();
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
};

export const ageInDays = (from: Date | null | undefined, asOfAt: Date): number | undefined =>
  from ? Math.max(0, Math.floor((asOfAt.getTime() - from.getTime()) / MS_PER_DAY)) : undefined;

/** Metrics the simplified operational schema can evidence from its own rows. */
export const deriveMetrics = (project: ProjectWithRelations, asOfAt: Date): ProjectMetrics => {
  const documents = project.documents;
  const missing = documents.filter((document) => document.status === 'REQUIRED').length;
  const invalid = documents.filter((document) => document.status === 'REJECTED' || document.status === 'EXPIRED').length;
  const verificationPending = documents.filter(
    (document) => document.status === 'SUBMITTED' && document.verifiedAt === null,
  ).length;

  const openMilestones = project.milestones.filter(
    (milestone) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED',
  );
  const overdueMilestones = openMilestones.filter(
    (milestone) => milestone.status === 'OVERDUE' || milestone.plannedAt.getTime() < asOfAt.getTime(),
  );
  const current = openMilestones
    .slice()
    .sort((left, right) => left.plannedAt.getTime() - right.plannedAt.getTime())[0];

  const completed = project.milestones.filter((milestone) => milestone.completedAt !== null);
  const averageStageDurationDays =
    completed.length > 0
      ? Math.round(
          completed.reduce((total, milestone) => {
            const completedAt = milestone.completedAt as Date;
            return total + Math.max(0, (completedAt.getTime() - milestone.createdAt.getTime()) / MS_PER_DAY);
          }, 0) / completed.length,
        )
      : undefined;

  return {
    requiredDocumentCount: documents.length || undefined,
    missingDocumentCount: missing,
    invalidDocumentCount: invalid,
    documentVerificationPendingCount: verificationPending,
    milestoneSlippageCount: overdueMilestones.length,
    overdueDays: current ? ageInDays(current.plannedAt, asOfAt) : undefined,
    daysInCurrentStage: current ? ageInDays(current.createdAt, asOfAt) : undefined,
    averageStageDurationDays,
    daysSinceLastUpdate: ageInDays(project.updatedAt, asOfAt),
  };
};

/**
 * Measured values recorded inside a stored feature snapshot.
 *
 * Objection, compensation, and legal counts are not columns in the operational
 * schema. When an ML feature snapshot carried them at prediction time, this
 * reads them back so the detectors can use real historical values rather than
 * nothing. Both snake_case and camelCase keys are accepted.
 */
export const readMetricsFromSnapshot = (snapshot: unknown): ProjectMetrics => {
  if (!isRecord(snapshot)) return {};
  const source = isRecord(snapshot.features) ? { ...snapshot, ...snapshot.features } : snapshot;
  const read = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = toNumber(source[key]);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const flag = (...keys: string[]): boolean | undefined => {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === '1' || value === 'true') return true;
      if (value === 0 || value === '0' || value === 'false') return false;
    }
    return undefined;
  };
  const metrics: ProjectMetrics = {
    parcelCount: read('parcel_count', 'parcelCount'),
    affectedLandownerCount: read('affected_landowner_count', 'affectedLandownerCount'),
    unresolvedRecordCount: read('unresolved_record_count', 'unresolvedRecordCount'),
    objectionCount: read('objection_count', 'objectionCount'),
    unresolvedObjectionCount: read('unresolved_objection_count', 'unresolvedObjectionCount'),
    requiredDocumentCount: read('required_document_count', 'requiredDocumentCount'),
    missingDocumentCount: read('missing_document_count', 'missingDocumentCount'),
    invalidDocumentCount: read('invalid_document_count', 'invalidDocumentCount'),
    documentVerificationPendingCount: read('document_verification_pending_count', 'documentVerificationPendingCount'),
    pendingApprovalCount: read('pending_approval_count', 'pendingApprovalCount'),
    blockedDependencyCount: read('blocked_dependency_count', 'blockedDependencyCount'),
    pendingCompensationAmount: read('pending_compensation_amount', 'pendingCompensationAmount'),
    paymentProcessingDays: read('payment_processing_days', 'paymentProcessingDays'),
    openLegalCaseCount: read('open_legal_case_count', 'openLegalCaseCount'),
    daysInCurrentStage: read('days_in_current_stage', 'daysInCurrentStage'),
    averageStageDurationDays: read('average_stage_duration_days', 'averageStageDurationDays'),
    overdueDays: read('overdue_days', 'overdueDays'),
    milestoneSlippageCount: read('milestone_slippage_count', 'milestoneSlippageCount'),
    daysSinceLastUpdate: read('days_since_last_update', 'daysSinceLastUpdate'),
    disputedOwnershipFlag: flag('disputed_ownership_flag', 'disputedOwnershipFlag'),
    compensationApprovalPendingFlag: flag('compensation_approval_pending_flag', 'compensationApprovalPendingFlag'),
    legalDisputeFlag: flag('legal_dispute_flag', 'legalDisputeFlag'),
    stayOrderFlag: flag('stay_order_flag', 'stayOrderFlag'),
  };
  // Drop undefined keys so a snapshot never overwrites a derived value with a gap.
  return Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== undefined)) as ProjectMetrics;
};

/** The earliest milestone that is still open, treated as the current milestone. */
export const deriveCurrentMilestone = (project: ProjectWithRelations, asOfAt: Date): MilestoneContext | null => {
  const open = deriveOpenMilestones(project)[0];
  if (!open) return null;
  const plannedAt = open.plannedAt instanceof Date ? open.plannedAt : null;
  const overdue = plannedAt ? Math.floor((asOfAt.getTime() - plannedAt.getTime()) / MS_PER_DAY) : 0;
  return { ...open, overdueDays: overdue > 0 ? overdue : 0 };
};

/** Open milestones ordered soonest first, in the engines' milestone shape. */
export const deriveOpenMilestones = (project: ProjectWithRelations): MilestoneContext[] =>
  project.milestones
    .filter((milestone) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED')
    .sort((left, right) => left.plannedAt.getTime() - right.plannedAt.getTime())
    .map((milestone) => ({
      milestoneId: milestone.id,
      name: milestone.name,
      status: milestone.status,
      plannedAt: milestone.plannedAt,
      completedAt: milestone.completedAt,
      ownerDepartment: milestone.ownerDept,
      stage: milestone.name,
    }));

/** Pending-task queues the document table can evidence. */
export const derivePendingTasks = (project: ProjectWithRelations, asOfAt: Date): PendingTask[] => {
  const tasks: PendingTask[] = [];
  const push = (taskCode: string, label: string, rows: { submittedAt: Date }[]) => {
    if (rows.length === 0) return;
    const oldest = rows.reduce((min, row) => (row.submittedAt < min ? row.submittedAt : min), rows[0]!.submittedAt);
    tasks.push({
      taskCode,
      label,
      count: rows.length,
      unit: 'document',
      ownerDepartment: project.department,
      oldestAgeDays: ageInDays(oldest, asOfAt),
    });
  };
  const byStatus = (statuses: string[]) => project.documents.filter((document) => statuses.includes(document.status));
  push('MISSING_DOCUMENT_COUNT', 'Required documents not yet submitted', byStatus(['REQUIRED']));
  push('INVALID_DOCUMENT_COUNT', 'Rejected or expired documents', byStatus(['REJECTED', 'EXPIRED']));
  push(
    'DOCUMENT_VERIFICATION_PENDING',
    'Submitted documents awaiting verification',
    project.documents.filter((document) => document.status === 'SUBMITTED' && document.verifiedAt === null),
  );
  return tasks;
};

/**
 * Department workload as open items against an assumed per-project capacity.
 * The index is absolute, not relative to the busiest department, so a quiet
 * system does not report a saturated one.
 */
export const deriveDepartmentWorkload = async (asOfAt: Date): Promise<DepartmentWorkload[]> => {
  const [activeProjects, openAlerts, openRecommendations, overdueMilestones] = await Promise.all([
    prisma.project.groupBy({ by: ['department'], where: { status: 'ACTIVE' }, _count: { id: true } }),
    prisma.alert.findMany({
      where: { status: { in: [...OPEN_ALERT_STATUSES] } },
      select: { project: { select: { department: true } }, responsibleDepartment: true },
    }),
    prisma.recommendation.findMany({
      where: { status: { in: [...OPEN_RECOMMENDATION_STATUSES] } },
      select: { responsibleDepartment: true },
    }),
    prisma.milestone.findMany({
      where: { status: 'OVERDUE' },
      select: { ownerDept: true, project: { select: { department: true } } },
    }),
  ]);

  const openItems = new Map<string, number>();
  const add = (department: string | null | undefined) => {
    if (!department) return;
    openItems.set(department, (openItems.get(department) ?? 0) + 1);
  };
  for (const alert of openAlerts) add(alert.responsibleDepartment || alert.project.department);
  for (const recommendation of openRecommendations) add(recommendation.responsibleDepartment);
  for (const milestone of overdueMilestones) add(milestone.ownerDept ?? milestone.project.department);

  const capacityByDepartment = new Map<string, number>();
  for (const row of activeProjects) capacityByDepartment.set(row.department, row._count.id);
  for (const department of openItems.keys()) if (!capacityByDepartment.has(department)) capacityByDepartment.set(department, 0);

  const workload: DepartmentWorkload[] = [];
  for (const [department, activeCount] of capacityByDepartment) {
    const items = openItems.get(department) ?? 0;
    const capacity = Math.max(
      WORKLOAD_DERIVATION.baselineCapacityItems,
      activeCount * WORKLOAD_DERIVATION.openItemsPerActiveProjectCapacity,
    );
    workload.push({
      department,
      workloadIndex: Number((items / capacity).toFixed(3)),
      openItems: items,
      activeProjects: activeCount,
      observedAt: asOfAt,
    });
  }
  return workload;
};

/** Delay rates observed across recorded milestones, by department and district. */
export const deriveHistoricalPatterns = async (
  project: ProjectWithRelations,
  asOfAt: Date,
): Promise<HistoricalPatterns> => {
  const rate = async (where: Prisma.MilestoneWhereInput): Promise<number | undefined> => {
    const [total, overdue] = await Promise.all([
      prisma.milestone.count({ where }),
      prisma.milestone.count({ where: { ...where, status: 'OVERDUE' } }),
    ]);
    return total > 0 ? Number((overdue / total).toFixed(4)) : undefined;
  };
  const [departmentDelayRate, districtDelayRate, projectTypeDelayRate] = await Promise.all([
    rate({ project: { department: project.department } }),
    rate({ project: { district: project.district } }),
    rate({ project: { projectType: project.projectType } }),
  ]);
  return { departmentDelayRate, districtDelayRate, projectTypeDelayRate, observedAt: asOfAt };
};

/** Reads a stored explanation envelope without trusting its shape. */
export const readRiskFactors = (explanation: unknown): RiskFactorContext[] => {
  const source = isRecord(explanation) ? explanation.topRiskFactors : undefined;
  if (!Array.isArray(source)) return [];
  const factors: RiskFactorContext[] = [];
  for (const raw of source) {
    if (!isRecord(raw) || typeof raw.factorCode !== 'string') continue;
    factors.push({
      factorCode: raw.factorCode,
      label: typeof raw.label === 'string' ? raw.label : undefined,
      direction:
        raw.direction === 'INCREASES_RISK' || raw.direction === 'REDUCES_RISK' || raw.direction === 'NEUTRAL'
          ? raw.direction
          : undefined,
      relativeContribution: toNumber(raw.relativeContribution ?? raw.contribution),
      currentValue: toNumber(raw.currentValue) ?? null,
      comparisonValue: toNumber(raw.comparisonValue) ?? null,
      source: raw.source === 'ML' || raw.source === 'RULE' || raw.source === 'ML_AND_RULE' ? raw.source : undefined,
      evidenceAt: typeof raw.evidenceAt === 'string' ? raw.evidenceAt : undefined,
      explanation: typeof raw.explanation === 'string' ? raw.explanation : undefined,
    });
  }
  return factors;
};
