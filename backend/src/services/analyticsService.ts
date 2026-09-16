import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { nestedProjectScopeWhere, projectScopeWhere, type AccessScope } from '../authz/scope.js';

/**
 * Analytics aggregates.
 *
 * Every query takes the caller's scope. An aggregate built from out-of-scope
 * rows leaks information just as surely as returning the rows themselves, so the
 * filter is applied before the count, not after.
 */
export const analyticsService = {
  async overview(scope: AccessScope) {
    const where = projectScopeWhere(scope);
    const milestoneWhere = nestedProjectScopeWhere(scope) as Prisma.MilestoneWhereInput;
    const [projects, active, milestones, overdue] = await Promise.all([
      prisma.project.count({ where }),
      prisma.project.count({ where: { AND: [where, { status: 'ACTIVE' }] } }),
      prisma.milestone.count({ where: milestoneWhere }),
      prisma.milestone.count({ where: { AND: [milestoneWhere, { status: 'OVERDUE' }] } }),
    ]);
    return { dataOrigin: 'DATABASE_RECORDS', scope: scope.level, projects, activeProjects: active, milestones, overdueMilestones: overdue };
  },

  departments: (scope: AccessScope) =>
    prisma.project.groupBy({ by: ['department', 'status'], where: projectScopeWhere(scope), _count: { id: true } }),

  districts: (scope: AccessScope) =>
    prisma.project.groupBy({ by: ['state', 'district', 'status'], where: projectScopeWhere(scope), _count: { id: true } }),

  timeline: (scope: AccessScope) =>
    prisma.milestone.groupBy({
      by: ['status'],
      where: nestedProjectScopeWhere(scope) as Prisma.MilestoneWhereInput,
      _count: { id: true },
    }),

  riskOverview: (scope: AccessScope) =>
    prisma.prediction.groupBy({
      by: ['riskLevel'],
      where: nestedProjectScopeWhere(scope) as Prisma.PredictionWhereInput,
      _count: { id: true },
    }),

  highRisk: (scope: AccessScope) =>
    prisma.prediction.findMany({
      where: { AND: [nestedProjectScopeWhere(scope) as Prisma.PredictionWhereInput, { riskLevel: { in: ['HIGH', 'CRITICAL'] } }] },
      orderBy: { predictedAt: 'desc' },
      take: 100,
      // Named fields rather than the whole row, so the model's input vector and
      // any future column are not published by default.
      select: {
        id: true, predictedAt: true, horizonDays: true, delayProbability: true,
        expectedDelayDays: true, riskLevel: true, confidenceBand: true, modelVersion: true,
        project: {
          select: {
            id: true, projectCode: true, name: true, state: true, district: true,
            department: true, status: true, priority: true, targetDate: true,
          },
        },
      },
    }),

  async riskTrends(scope: AccessScope) {
    const predictions = await prisma.prediction.findMany({
      where: nestedProjectScopeWhere(scope) as Prisma.PredictionWhereInput,
      orderBy: { predictedAt: 'asc' },
      take: 1000,
      select: { predictedAt: true, riskLevel: true },
    });
    return predictions.reduce<Record<string, Record<string, number>>>((trend, prediction) => {
      const day = prediction.predictedAt.toISOString().slice(0, 10);
      trend[day] ??= { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
      const bucket = trend[day];
      if (bucket) bucket[prediction.riskLevel] = (bucket[prediction.riskLevel] ?? 0) + 1;
      return trend;
    }, {});
  },
};
