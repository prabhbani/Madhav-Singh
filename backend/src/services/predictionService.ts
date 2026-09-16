/**
 * Prediction service.
 *
 * Two security properties matter here beyond the usual.
 *
 * **The model service is an untrusted upstream.** Its URL is operator
 * configuration rather than user input, so this is not a classic SSRF sink, but
 * a compromised or misconfigured model host must not be able to steer the API.
 * The call therefore pins the scheme, refuses redirects, bounds the response
 * size and time, and validates the response shape before any of it reaches a
 * client. A failure degrades to the rule-only path rather than surfacing an
 * upstream error.
 *
 * **Model internals stay internal.** The stored feature snapshot is the exact
 * input vector the model scored. It is kept for reproducibility and audit, and
 * it is never returned over the API. Officers get the explanation, not the
 * vector.
 */

import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { scoreCase } from '../predictions/ruleEngine.js';
import { deriveCurrentMilestone, deriveMetrics, readMetricsFromSnapshot } from './caseSnapshot.js';

/** Largest model-service response accepted, before parsing. */
const MAX_ML_RESPONSE_BYTES = 256 * 1024;

/**
 * The model service response contract. Anything outside it is discarded rather
 * than relayed, so an upstream cannot inject fields into an API response.
 */
const mlResponseSchema = z
  .object({
    delayProbability: z.number().min(0).max(1),
    expectedDelayDays: z.number().min(0).max(36_500).nullable().optional(),
    riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    confidenceBand: z.enum(['LOW', 'MEDIUM', 'HIGH']).nullable().optional(),
    modelVersion: z.string().max(120).optional(),
    topRiskFactors: z
      .array(
        z.object({
          factorCode: z.string().max(120),
          label: z.string().max(200).optional(),
          direction: z.enum(['INCREASES_RISK', 'REDUCES_RISK', 'NEUTRAL']).optional(),
          relativeContribution: z.number().min(0).max(1).optional(),
          explanation: z.string().max(600).optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .strip();

/** Refuses a model-service URL that is not plain http or https. */
const modelServiceEndpoint = (): string | null => {
  if (!env.ML_SERVICE_URL) return null;
  let parsed: URL;
  try {
    parsed = new URL(env.ML_SERVICE_URL);
  } catch {
    throw new Error('ML_SERVICE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`ML_SERVICE_URL must use http or https, not ${parsed.protocol}`);
  }
  return `${env.ML_SERVICE_URL.replace(/\/$/, '')}/predict`;
};

type MlResult = z.infer<typeof mlResponseSchema>;

const callModelService = async (
  endpoint: string,
  payload: unknown,
  log?: { error: (details: unknown, message: string) => void },
): Promise<MlResult | null> => {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      // A redirect from the model host could point anywhere, including an
      // internal metadata endpoint. There is no legitimate reason to follow one.
      redirect: 'error',
      signal: AbortSignal.timeout(env.ML_SERVICE_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_ML_RESPONSE_BYTES) return null;
    const body = await response.text();
    if (body.length > MAX_ML_RESPONSE_BYTES) return null;

    const parsed = mlResponseSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    // Network failure, timeout, redirect, or malformed body. The rule path is
    // the fallback, and the upstream detail never reaches the caller.
    log?.error({ err: (error as Error).name }, 'model service call failed');
    return null;
  }
};

/** camelCase to the snake_case column names the model was trained on. */
const toSnakeCase = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * The feature payload sent to the model service.
 *
 * This has to speak the model's own column names. An earlier version sent five
 * fields of operational metadata (`status`, `milestoneCount`, and so on), none
 * of which is a training column, so every request arrived with the entire
 * feature vector missing and the model scored a fully imputed row. The service
 * now refuses a payload that thin, but the real fix is to send the facts.
 *
 * Booleans become 0 and 1 because that is how the flags were encoded in
 * training. Features this schema cannot evidence are simply absent, and the
 * service reports the completeness back rather than assuming a value.
 */
const buildFeaturePayload = (
  project: { state: string; district: string; department: string; projectType: string; priority: string },
  metrics: Record<string, unknown>,
): Record<string, string | number> => {
  const payload: Record<string, string | number> = {
    state: project.state,
    district: project.district,
    department: project.department,
    project_type: project.projectType,
    project_priority: project.priority,
  };
  for (const [key, value] of Object.entries(metrics)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'boolean') payload[toSnakeCase(key)] = value ? 1 : 0;
    else if (typeof value === 'number' && Number.isFinite(value)) payload[toSnakeCase(key)] = value;
    else if (typeof value === 'string') payload[toSnakeCase(key)] = value;
  }
  return payload;
};

/** Fields safe to return for a stored prediction. The feature vector is not one. */
const predictionPublicSelect = {
  id: true,
  projectId: true,
  modelVersion: true,
  predictedAt: true,
  horizonDays: true,
  delayProbability: true,
  expectedDelayDays: true,
  riskLevel: true,
  confidenceBand: true,
  explanation: true,
  createdAt: true,
} as const;

export const predictionService = {
  async predict(
    projectId: string,
    horizonDays: number,
    asOfAt?: Date,
    log?: { error: (details: unknown, message: string) => void },
  ) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { milestones: true, documents: true, predictions: { orderBy: { predictedAt: 'desc' }, take: 1 }, recommendations: true },
    });
    if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');

    const asOf = asOfAt ?? new Date();
    // The same measured facts the rule layer reads, so both layers score the
    // same snapshot rather than two different views of the case.
    const metrics = {
      ...deriveMetrics(project, asOf),
      ...readMetricsFromSnapshot(project.predictions[0]?.inputSnapshot),
    };
    const features = buildFeaturePayload(project, metrics);

    const endpoint = modelServiceEndpoint();
    if (endpoint) {
      const result = await callModelService(
        endpoint,
        { projectId, horizonDays, asOfAt: asOf.toISOString(), features },
        log,
      );
      if (result) {
        return {
          projectId,
          delayProbability: result.delayProbability,
          expectedDelayDays: result.expectedDelayDays ?? null,
          riskLevel: result.riskLevel,
          confidenceBand: result.confidenceBand ?? null,
          predictionStatus: 'OK' as const,
          dataOrigin: project.dataOrigin,
          modelVersion: result.modelVersion ?? null,
          topRiskFactors: result.topRiskFactors ?? [],
        };
      }
    }

    // The rule layer scores the very same snapshot, and names the measurement
    // behind every contribution. It is a rule score, not a calibrated
    // probability, and the response says so.
    const scored = scoreCase({
      metrics,
      milestone: deriveCurrentMilestone(project, asOf),
      asOfAt: asOf,
      priority: project.priority,
    });

    return {
      projectId,
      delayProbability: scored.ruleScore,
      expectedDelayDays: scored.expectedDelayDays,
      riskLevel: scored.riskLevel,
      confidenceBand: 'LOW' as const,
      predictionStatus: 'RULE_ONLY_FALLBACK' as const,
      dataOrigin: project.dataOrigin,
      modelVersion: null,
      policyVersion: scored.policyVersion,
      topRiskFactors: scored.topRiskFactors,
    };
  },

  /** Scores a case directly from measured facts, without a database read. */
  scoreFromMetrics: scoreCase,

  history: (projectId: string) =>
    prisma.prediction.findMany({
      where: { projectId },
      orderBy: { predictedAt: 'desc' },
      take: 100,
      select: predictionPublicSelect,
    }),

  latest: (projectId: string) =>
    prisma.prediction.findFirst({
      where: { projectId },
      orderBy: { predictedAt: 'desc' },
      select: predictionPublicSelect,
    }),
};
