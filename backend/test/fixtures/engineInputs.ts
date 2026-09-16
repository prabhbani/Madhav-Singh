/**
 * Builders that turn an edge-case fixture into engine input.
 *
 * Kept separate from the fixtures themselves so one awkward case record can be
 * fed to the recommendation engine and the alert engine without either suite
 * restating its shape.
 */

import type { RecommendationInput } from '../../src/recommendations/types.js';
import type { AlertEvaluationInput } from '../../src/alerts/types.js';
import { AS_OF, daysFrom, type EdgeCase } from './edgeCases.js';

export const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

const projectFor = (edge: EdgeCase) => ({
  projectId: PROJECT_ID,
  projectCode: 'NH-2026-014',
  name: 'Ring Road Phase II',
  state: 'Punjab',
  district: 'Ludhiana',
  department: 'Public Works Department',
  projectType: 'HIGHWAY',
  status: edge.context?.status ?? 'ACTIVE',
  targetDate: edge.context?.targetDate ?? null,
  dataOrigin: 'SYNTHETIC_DEMO',
  metrics: edge.metrics,
});

const milestoneFor = (edge: EdgeCase) => {
  const plannedAt = edge.context?.milestonePlannedAt;
  if (plannedAt === null || plannedAt === undefined) return null;
  return {
    milestoneId: 'm-1',
    name: 'Section 19 declaration',
    status: edge.context?.milestoneStatus ?? 'IN_PROGRESS',
    plannedAt,
    completedAt: edge.context?.completedAt ?? null,
    ownerDepartment: 'Land Acquisition Cell',
    stage: 'Declaration',
  };
};

export const recommendationInputFor = (
  edge: EdgeCase,
  overrides: Partial<RecommendationInput> = {},
): RecommendationInput => ({
  asOfAt: AS_OF,
  project: projectFor(edge),
  currentMilestone: milestoneFor(edge),
  prediction: {
    predictionId: 'p-1',
    riskLevel: 'HIGH',
    delayProbability: 0.68,
    expectedDelayDays: 41,
    horizonDays: 90,
    confidenceBand: 'MEDIUM',
    predictionStatus: 'OK',
    modelVersion: 'synthetic-delay-20260915T173246Z',
  },
  topRiskFactors: [
    { factorCode: 'unresolved_record_count', direction: 'INCREASES_RISK', relativeContribution: 0.31, source: 'ML' },
    { factorCode: 'missing_document_count', direction: 'INCREASES_RISK', relativeContribution: 0.19, source: 'ML' },
  ],
  historicalPatterns: { departmentDelayRate: 0.44, districtDelayRate: 0.39 },
  pendingTasks: [],
  departmentWorkload: [{ department: 'Land Records Department', workloadIndex: 0.42 }],
  existingRecommendations: [],
  ...overrides,
});

export const alertInputFor = (edge: EdgeCase, overrides: Partial<AlertEvaluationInput> = {}): AlertEvaluationInput => {
  const milestone = milestoneFor(edge);
  return {
    asOfAt: AS_OF,
    project: projectFor(edge),
    currentMilestone: milestone,
    upcomingMilestones: milestone ? [milestone] : [],
    prediction: {
      riskLevel: 'HIGH',
      delayProbability: 0.68,
      horizonDays: 90,
      confidenceBand: 'MEDIUM',
      predictionStatus: 'OK',
      modelVersion: 'synthetic-delay-20260915T173246Z',
    },
    predictionHistory: [],
    observationHistory: [],
    departmentWorkload: [{ department: 'Land Records Department', workloadIndex: 0.42 }],
    responsibleOfficers: [
      {
        department: 'Land Acquisition Cell',
        officerId: '22222222-2222-4222-8222-222222222222',
        officerName: 'A. Officer',
        matchBasis: 'Officer recorded for this department in this district.',
      },
    ],
    existingAlerts: [],
    ...overrides,
  };
};

/** A rising prediction series, for the trend detector. */
export const risingHistory = (values: number[]) =>
  values.map((delayProbability, index) => ({
    predictedAt: daysFrom(-10 * (values.length - index)),
    delayProbability,
  }));
