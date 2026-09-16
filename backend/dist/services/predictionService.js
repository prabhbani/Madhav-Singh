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
        .array(z.object({
        factorCode: z.string().max(120),
        label: z.string().max(200).optional(),
        direction: z.enum(['INCREASES_RISK', 'REDUCES_RISK', 'NEUTRAL']).optional(),
        relativeContribution: z.number().min(0).max(1).optional(),
        explanation: z.string().max(600).optional(),
    }))
        .max(50)
        .optional(),
})
    .strip();
/** Refuses a model-service URL that is not plain http or https. */
const modelServiceEndpoint = () => {
    if (!env.ML_SERVICE_URL)
        return null;
    let parsed;
    try {
        parsed = new URL(env.ML_SERVICE_URL);
    }
    catch {
        throw new Error('ML_SERVICE_URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`ML_SERVICE_URL must use http or https, not ${parsed.protocol}`);
    }
    return `${env.ML_SERVICE_URL.replace(/\/$/, '')}/predict`;
};
const callModelService = async (endpoint, payload, log) => {
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
        if (!response.ok)
            return null;
        const declaredLength = Number(response.headers.get('content-length') ?? '0');
        if (declaredLength > MAX_ML_RESPONSE_BYTES)
            return null;
        const body = await response.text();
        if (body.length > MAX_ML_RESPONSE_BYTES)
            return null;
        const parsed = mlResponseSchema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data : null;
    }
    catch (error) {
        // Network failure, timeout, redirect, or malformed body. The rule path is
        // the fallback, and the upstream detail never reaches the caller.
        log?.error({ err: error.name }, 'model service call failed');
        return null;
    }
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
};
export const predictionService = {
    async predict(projectId, horizonDays, asOfAt, log) {
        const project = await prisma.project.findUnique({ where: { id: projectId }, include: { milestones: true } });
        if (!project)
            throw new AppError(404, 'PROJECT_NOT_FOUND', 'Project was not found');
        const snapshot = {
            projectId,
            status: project.status,
            milestoneCount: project.milestones.length,
            overdueMilestones: project.milestones.filter((milestone) => milestone.status === 'OVERDUE').length,
            dataOrigin: project.dataOrigin,
        };
        const endpoint = modelServiceEndpoint();
        if (endpoint) {
            const result = await callModelService(endpoint, { projectId, horizonDays, asOfAt: asOfAt?.toISOString(), features: snapshot }, log);
            if (result) {
                return {
                    projectId,
                    delayProbability: result.delayProbability,
                    expectedDelayDays: result.expectedDelayDays ?? null,
                    riskLevel: result.riskLevel,
                    confidenceBand: result.confidenceBand ?? null,
                    predictionStatus: 'OK',
                    dataOrigin: project.dataOrigin,
                    modelVersion: result.modelVersion ?? null,
                    topRiskFactors: result.topRiskFactors ?? [],
                };
            }
        }
        const overdue = snapshot.overdueMilestones;
        const probability = Math.min(0.98, 0.18 + overdue * 0.16 + (project.priority === 'CRITICAL' ? 0.12 : 0));
        const riskLevel = probability >= 0.75 ? 'CRITICAL' : probability >= 0.5 ? 'HIGH' : probability >= 0.25 ? 'MEDIUM' : 'LOW';
        return {
            projectId,
            delayProbability: Number(probability.toFixed(5)),
            expectedDelayDays: Math.round(probability * 45),
            riskLevel,
            confidenceBand: 'LOW',
            predictionStatus: 'RULE_ONLY_FALLBACK',
            dataOrigin: project.dataOrigin,
            topRiskFactors: overdue
                ? [{ factorCode: 'OVERDUE_MILESTONE', direction: 'INCREASES_RISK', explanation: `${overdue} milestone(s) are overdue.` }]
                : [],
            recommendedActions: overdue ? ['Review overdue milestones with the owning department.'] : [],
        };
    },
    history: (projectId) => prisma.prediction.findMany({
        where: { projectId },
        orderBy: { predictedAt: 'desc' },
        take: 100,
        select: predictionPublicSelect,
    }),
    latest: (projectId) => prisma.prediction.findFirst({
        where: { projectId },
        orderBy: { predictedAt: 'desc' },
        select: predictionPublicSelect,
    }),
};
