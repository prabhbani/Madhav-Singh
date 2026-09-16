import { prisma } from '../config/prisma.js';
import { nestedProjectScopeWhere, projectScopeWhere } from '../authz/scope.js';
/**
 * Analytics aggregates.
 *
 * Every query takes the caller's scope. An aggregate built from out-of-scope
 * rows leaks information just as surely as returning the rows themselves, so the
 * filter is applied before the count, not after.
 */
export const analyticsService = {
    async overview(scope) {
        const where = projectScopeWhere(scope);
        const milestoneWhere = nestedProjectScopeWhere(scope);
        const [projects, active, milestones, overdue] = await Promise.all([
            prisma.project.count({ where }),
            prisma.project.count({ where: { AND: [where, { status: 'ACTIVE' }] } }),
            prisma.milestone.count({ where: milestoneWhere }),
            prisma.milestone.count({ where: { AND: [milestoneWhere, { status: 'OVERDUE' }] } }),
        ]);
        return { dataOrigin: 'DATABASE_RECORDS', scope: scope.level, projects, activeProjects: active, milestones, overdueMilestones: overdue };
    },
    departments: (scope) => prisma.project.groupBy({ by: ['department', 'status'], where: projectScopeWhere(scope), _count: { id: true } }),
    districts: (scope) => prisma.project.groupBy({ by: ['state', 'district', 'status'], where: projectScopeWhere(scope), _count: { id: true } }),
    timeline: (scope) => prisma.milestone.groupBy({
        by: ['status'],
        where: nestedProjectScopeWhere(scope),
        _count: { id: true },
    }),
    riskOverview: (scope) => prisma.prediction.groupBy({
        by: ['riskLevel'],
        where: nestedProjectScopeWhere(scope),
        _count: { id: true },
    }),
    highRisk: (scope) => prisma.prediction.findMany({
        where: { AND: [nestedProjectScopeWhere(scope), { riskLevel: { in: ['HIGH', 'CRITICAL'] } }] },
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
    async riskTrends(scope) {
        const predictions = await prisma.prediction.findMany({
            where: nestedProjectScopeWhere(scope),
            orderBy: { predictedAt: 'asc' },
            take: 1000,
            select: { predictedAt: true, riskLevel: true },
        });
        return predictions.reduce((trend, prediction) => {
            const day = prediction.predictedAt.toISOString().slice(0, 10);
            trend[day] ??= { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
            const bucket = trend[day];
            if (bucket)
                bucket[prediction.riskLevel] = (bucket[prediction.riskLevel] ?? 0) + 1;
            return trend;
        }, {});
    },
};
