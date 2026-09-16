import { z } from 'zod';

/** Mirrors the backend recommendation engine contract. */
export const prioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const recommendationStatusSchema = z.enum([
  'OPEN',
  'ACKNOWLEDGED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'DISMISSED',
  'EXPIRED',
]);

export const relatedRiskFactorSchema = z.object({
  factorCode: z.string(),
  label: z.string(),
  direction: z.enum(['INCREASES_RISK', 'REDUCES_RISK', 'NEUTRAL']),
  relativeContribution: z.number().nullable(),
  rank: z.number().nullable(),
  source: z.enum(['ML', 'RULE', 'ML_AND_RULE']),
});

export const recommendationSchema = z.object({
  recommendationId: z.string(),
  rank: z.number(),
  priority: prioritySchema,
  priorityBasis: z.enum(['RANKING_SCORE', 'POLICY_OVERRIDE']).default('RANKING_SCORE'),
  action: z.string(),
  reason: z.string(),
  relatedRiskFactor: relatedRiskFactorSchema.nullable(),
  responsibleDepartment: z.string(),
  suggestedDeadline: z.object({ days: z.number(), dueAt: z.string(), basis: z.string().optional() }),
  expectedImpact: z.string(),
  status: recommendationStatusSchema,
  rankingScore: z.number(),
  evidence: z.object({ code: z.string(), description: z.string(), source: z.string() }).optional(),
  capacityNote: z.string().nullable().default(null),
});

export const recommendationResultSchema = z.object({
  projectId: z.string(),
  generatedAt: z.string(),
  policyVersion: z.string(),
  recommendations: z.array(recommendationSchema),
});

export type Priority = z.infer<typeof prioritySchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;
