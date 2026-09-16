import { prisma } from '../config/prisma.js';
const buildWhere = (args) => ({
    AND: [
        args.scopeWhere,
        {
            ...(args.status ? { status: args.status } : {}),
            ...(args.search
                ? {
                    OR: [
                        { name: { contains: args.search, mode: 'insensitive' } },
                        { projectCode: { contains: args.search, mode: 'insensitive' } },
                    ],
                }
                : {}),
        },
    ],
});
export const projectRepository = {
    list: (args) => prisma.project.findMany({
        skip: args.skip,
        take: args.take,
        where: buildWhere(args),
        orderBy: { updatedAt: 'desc' },
        include: { milestones: true },
    }),
    count: (args) => prisma.project.count({ where: buildWhere(args) }),
    get: (id) => prisma.project.findUnique({
        where: { id },
        include: {
            milestones: { orderBy: { plannedAt: 'asc' } },
            // The stored feature vector (`inputSnapshot`) is deliberately excluded:
            // it is the model's exact input and is kept for audit, not for clients.
            predictions: {
                orderBy: { predictedAt: 'desc' },
                take: 1,
                select: {
                    id: true, modelVersion: true, predictedAt: true, horizonDays: true,
                    delayProbability: true, expectedDelayDays: true, riskLevel: true,
                    confidenceBand: true, explanation: true,
                },
            },
            alerts: { orderBy: { triggeredAt: 'desc' }, take: 10 },
        },
    }),
    create: (data) => prisma.project.create({ data: data }),
    update: (id, data) => prisma.project.update({ where: { id }, data: data }),
    delete: (id) => prisma.project.update({ where: { id }, data: { status: 'CANCELLED' } }),
    milestones: (id) => prisma.milestone.findMany({ where: { projectId: id }, orderBy: { plannedAt: 'asc' } }),
    createMilestone: (data) => prisma.milestone.create({ data: data }),
    updateMilestone: (id, data) => prisma.milestone.update({ where: { id }, data: data }),
    /** Scoped export dataset, used by the analytics export route. */
    exportRows: (scopeWhere) => prisma.project.findMany({
        where: scopeWhere,
        orderBy: { updatedAt: 'desc' },
        take: 5000,
        select: {
            id: true, projectCode: true, name: true, state: true, district: true, department: true,
            projectType: true, priority: true, status: true, plannedStartDate: true, targetDate: true,
            dataOrigin: true, updatedAt: true,
            predictions: { orderBy: { predictedAt: 'desc' }, take: 1, select: { riskLevel: true, delayProbability: true, predictedAt: true } },
        },
    }),
};
