/**
 * Recommendation service.
 *
 * Reads the operational database, assembles the engine input, runs the pure
 * engine, and persists the result. The service performs no ranking of its own;
 * it only supplies measured values and records what the engine returned.
 *
 * Every derivation from stored rows lives in `caseSnapshot.ts`, shared with the
 * early warning system so both read the same numbers.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/AppError.js';
import { predictionService } from './predictionService.js';
import { generateRecommendations } from '../recommendations/engine.js';
import { CATALOG_VERSION, POLICY_VERSION } from '../recommendations/policy.js';
import {
  OPEN_RECOMMENDATION_STATUSES,
  deriveCurrentMilestone,
  deriveDepartmentWorkload,
  deriveHistoricalPatterns,
  deriveMetrics,
  derivePendingTasks,
  projectInclude,
  readMetricsFromSnapshot,
  readRiskFactors,
  toNumber,
  type ProjectWithRelations,
} from './caseSnapshot.js';
import type {
  DepartmentWorkload,
  ExistingRecommendation,
  HistoricalPatterns,
  PendingTask,
  PredictionContext,
  ProjectMetrics,
  RecommendationInput,
  RecommendationResult,
  RecommendationStatus,
  RecommendedAction,
  RiskFactorContext,
  RiskLevel,
} from '../recommendations/types.js';

const VALID_STATUSES: readonly RecommendationStatus[] = [
  'OPEN',
  'ACKNOWLEDGED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'DISMISSED',
  'EXPIRED',
];

const buildPredictionContext = async (
  project: ProjectWithRelations,
  horizonDays: number,
  asOfAt: Date,
): Promise<{ prediction: PredictionContext; topRiskFactors: RiskFactorContext[] }> => {
  const stored = project.predictions[0];
  if (stored) {
    return {
      prediction: {
        predictionId: stored.id,
        riskLevel: stored.riskLevel as RiskLevel,
        delayProbability: stored.delayProbability.toNumber(),
        expectedDelayDays: stored.expectedDelayDays ? stored.expectedDelayDays.toNumber() : null,
        horizonDays: stored.horizonDays,
        confidenceBand: (stored.confidenceBand as PredictionContext['confidenceBand']) ?? null,
        predictionStatus: 'OK',
        modelVersion: stored.modelVersion,
        predictedAt: stored.predictedAt,
      },
      topRiskFactors: readRiskFactors(stored.explanation),
    };
  }

  // No stored prediction: fall back to the live prediction path, which itself
  // degrades to rule-only output when the model service is unavailable.
  const live = (await predictionService.predict(project.id, horizonDays, asOfAt)) as Record<string, unknown>;
  const probability = toNumber(live.delayProbability) ?? 0;
  return {
    prediction: {
      riskLevel: (typeof live.riskLevel === 'string' ? live.riskLevel : 'LOW') as RiskLevel,
      delayProbability: probability,
      expectedDelayDays: toNumber(live.expectedDelayDays) ?? null,
      horizonDays,
      confidenceBand: typeof live.confidenceBand === 'string' ? (live.confidenceBand as PredictionContext['confidenceBand']) : 'LOW',
      predictionStatus:
        live.predictionStatus === 'RULE_ONLY_FALLBACK' || live.predictionStatus === 'STALE' || live.predictionStatus === 'DEGRADED'
          ? live.predictionStatus
          : 'OK',
      modelVersion: typeof live.modelVersion === 'string' ? live.modelVersion : undefined,
      predictedAt: asOfAt,
    },
    topRiskFactors: readRiskFactors(live),
  };
};

// ---------------------------------------------------------------------------
// Input assembly and persistence
// ---------------------------------------------------------------------------

export type GenerateOptions = {
  horizonDays?: number;
  asOfAt?: Date;
  persist?: boolean;
  /**
   * Caller-supplied measurements, used when a richer feature snapshot exists
   * outside the operational tables. Supplied values take precedence over the
   * values derived here, and the engine records the source either way.
   */
  snapshot?: {
    metrics?: ProjectMetrics;
    pendingTasks?: PendingTask[];
    departmentWorkload?: DepartmentWorkload[];
    historicalPatterns?: HistoricalPatterns;
    topRiskFactors?: RiskFactorContext[];
  };
};

export const buildRecommendationInput = async (
  projectId: string,
  options: GenerateOptions = {},
): Promise<RecommendationInput> => {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: projectInclude });
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');

  const asOfAt = options.asOfAt ?? new Date();
  const horizonDays = options.horizonDays ?? 90;
  const supplied = options.snapshot ?? {};

  const [{ prediction, topRiskFactors }, departmentWorkload, historicalPatterns] = await Promise.all([
    buildPredictionContext(project, horizonDays, asOfAt),
    supplied.departmentWorkload ? Promise.resolve(supplied.departmentWorkload) : deriveDepartmentWorkload(asOfAt),
    supplied.historicalPatterns
      ? Promise.resolve(supplied.historicalPatterns)
      : deriveHistoricalPatterns(project, asOfAt),
  ]);

  const existingRecommendations: ExistingRecommendation[] = project.recommendations.map((row) => ({
    evidenceCode: row.evidenceCode,
    status: row.status as RecommendationStatus,
    dueAt: row.dueAt,
  }));

  return {
    asOfAt,
    project: {
      projectId: project.id,
      projectCode: project.projectCode,
      name: project.name,
      state: project.state,
      district: project.district,
      department: project.department,
      projectType: project.projectType,
      priority: project.priority as RecommendationInput['project']['priority'],
      status: project.status,
      targetDate: project.targetDate,
      dataOrigin: project.dataOrigin,
      metrics: {
        ...deriveMetrics(project, asOfAt),
        ...readMetricsFromSnapshot(project.predictions[0]?.inputSnapshot),
        ...(supplied.metrics ?? {}),
      },
    },
    currentMilestone: deriveCurrentMilestone(project, asOfAt),
    prediction: { ...prediction, horizonDays, policyVersion: POLICY_VERSION },
    topRiskFactors: supplied.topRiskFactors ?? topRiskFactors,
    historicalPatterns,
    pendingTasks: supplied.pendingTasks ?? derivePendingTasks(project, asOfAt),
    departmentWorkload,
    existingRecommendations,
  };
};

const persistRecommendation = async (
  projectId: string,
  recommendation: RecommendedAction,
  result: RecommendationResult,
  modelVersion: string | null,
  predictionId: string | null,
) => {
  const data = {
    type: recommendation.impactCategory,
    title: recommendation.action.slice(0, 240),
    rationale: recommendation.reason,
    priority: recommendation.priority,
    status: recommendation.status,
    dueAt: new Date(recommendation.suggestedDeadline.dueAt),
    rank: recommendation.rank,
    rankingScore: new Prisma.Decimal(recommendation.rankingScore),
    priorityBasis: recommendation.priorityBasis,
    responsibleDepartment: recommendation.responsibleDepartment,
    expectedImpact: recommendation.expectedImpact,
    relatedFactorCode: recommendation.relatedRiskFactor?.factorCode ?? null,
    source: recommendation.relatedRiskFactor?.source === 'RULE' ? 'RULE' : 'ML_ASSISTED',
    policyVersion: result.policyVersion,
    catalogVersion: result.catalogVersion,
    modelVersion,
    predictionId,
    detail: {
      recommendationId: recommendation.recommendationId,
      evidence: recommendation.evidence,
      scoreBreakdown: recommendation.scoreBreakdown,
      relatedRiskFactor: recommendation.relatedRiskFactor,
      suggestedDeadline: recommendation.suggestedDeadline,
      departmentBasis: recommendation.departmentBasis,
      statusBasis: recommendation.statusBasis,
      appliedOverrides: recommendation.appliedOverrides,
      capacityNote: recommendation.capacityNote,
      limitations: recommendation.limitations,
      generatedAt: result.generatedAt,
      asOfAt: result.asOfAt,
    } as Prisma.InputJsonValue,
  };

  return prisma.recommendation.upsert({
    where: { projectId_evidenceCode: { projectId, evidenceCode: recommendation.evidence.code } },
    // A stored status set by an official is never overwritten by a regeneration.
    update: { ...data, status: undefined },
    create: { ...data, projectId, evidenceCode: recommendation.evidence.code },
  });
};

export const recommendationService = {
  /** Runs the engine for a project and, by default, stores the ranked actions. */
  async generate(projectId: string, options: GenerateOptions = {}): Promise<RecommendationResult> {
    const input = await buildRecommendationInput(projectId, options);
    const result = generateRecommendations(input);

    if (options.persist !== false) {
      const modelVersion = input.prediction.modelVersion ?? null;
      const predictionId = input.prediction.predictionId ?? null;
      for (const recommendation of result.recommendations) {
        await persistRecommendation(projectId, recommendation, result, modelVersion, predictionId);
      }
      // Evidence that is no longer present should not stay on an officer's queue.
      const emittedCodes = result.recommendations.map((recommendation) => recommendation.evidence.code);
      await prisma.recommendation.updateMany({
        where: {
          projectId,
          status: { in: [...OPEN_RECOMMENDATION_STATUSES] },
          ...(emittedCodes.length > 0 ? { evidenceCode: { notIn: emittedCodes } } : {}),
        },
        data: { status: 'EXPIRED' },
      });
    }

    return result;
  },

  /** Stored recommendations for a project, highest priority first. */
  list: (projectId: string) =>
    prisma.recommendation.findMany({
      where: { projectId },
      orderBy: [{ rank: 'asc' }, { createdAt: 'desc' }],
    }),

  async updateStatus(id: string, status: string) {
    if (!VALID_STATUSES.includes(status as RecommendationStatus)) {
      throw new AppError(400, 'INVALID_STATUS', `Status must be one of ${VALID_STATUSES.join(', ')}`);
    }
    const existing = await prisma.recommendation.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'RECOMMENDATION_NOT_FOUND', 'Recommendation was not found');
    return prisma.recommendation.update({ where: { id }, data: { status } });
  },

  versions: () => ({ policyVersion: POLICY_VERSION, catalogVersion: CATALOG_VERSION }),
};
