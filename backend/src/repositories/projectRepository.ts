import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

/**
 * Project reads always take a scope filter. It is a required argument rather
 * than an optional one so a new caller cannot forget it and silently read the
 * whole estate.
 */
type ListArgs = { skip: number; take: number; search?: string; status?: string; scopeWhere: Prisma.ProjectWhereInput };
type CountArgs = { search?: string; status?: string; scopeWhere: Prisma.ProjectWhereInput };

const buildWhere = (args: CountArgs): Prisma.ProjectWhereInput => ({
  AND: [
    args.scopeWhere,
    {
      ...(args.status ? { status: args.status as never } : {}),
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
  list: (args: ListArgs) =>
    prisma.project.findMany({
      skip: args.skip,
      take: args.take,
      where: buildWhere(args),
      orderBy: { updatedAt: 'desc' },
      include: { milestones: true },
    }),
  count: (args: CountArgs) => prisma.project.count({ where: buildWhere(args) }),
  get: (id: string) =>
    prisma.project.findUnique({
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
  create: (data: Record<string, unknown>) => prisma.project.create({ data: data as never }),
  update: (id: string, data: Record<string, unknown>) => prisma.project.update({ where: { id }, data: data as never }),
  delete: (id: string) => prisma.project.update({ where: { id }, data: { status: 'CANCELLED' } }),
  milestones: (id: string) => prisma.milestone.findMany({ where: { projectId: id }, orderBy: { plannedAt: 'asc' } }),
  createMilestone: (data: Record<string, unknown>) => prisma.milestone.create({ data: data as never }),
  updateMilestone: (id: string, data: Record<string, unknown>) => prisma.milestone.update({ where: { id }, data: data as never }),
  /** Scoped export dataset, used by the analytics export route. */
  exportRows: (scopeWhere: Prisma.ProjectWhereInput) =>
    prisma.project.findMany({
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
