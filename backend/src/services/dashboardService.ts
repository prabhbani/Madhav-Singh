/**
 * Dashboard aggregation.
 *
 * Every figure the executive dashboard renders is computed here from stored
 * rows: the project table, the six-month trend, and the district heatmap. None
 * of it is authored, and none of it is held in the frontend. Changing a case
 * fact in the database changes the dashboard.
 *
 * Like every other read in this service, it is scoped: an officer sees the
 * projects their role and geography reach, and the aggregates are computed over
 * that same set rather than over everything and then filtered.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { nestedProjectScopeWhere, projectScopeWhere, type AccessScope } from '../authz/scope.js';
import { readMetricsFromSnapshot } from './caseSnapshot.js';

const MS_PER_DAY = 86_400_000;
const TREND_MONTHS = 6;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "12 min ago", "3 hrs ago", "Yesterday". */
const relativeTime = (from: Date, now: Date): string => {
  const minutes = Math.max(0, Math.round((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
};

const formatCrore = (amount: number | undefined, label: string): string =>
  amount === undefined || amount <= 0 ? 'None recorded' : `₹${(amount / 10_000_000).toFixed(1)} Cr ${label}`;

const formatDate = (date: Date): string =>
  `${String(date.getUTCDate()).padStart(2, '0')} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/** Progress is the share of milestones completed, not an authored percentage. */
const progressOf = (milestones: Array<{ status: string }>): number => {
  if (milestones.length === 0) return 0;
  const completed = milestones.filter((milestone) => milestone.status === 'COMPLETED').length;
  return Math.round((completed / milestones.length) * 100);
};

/** The stage is the earliest open milestone; a closed case reports its last. */
const stageOf = (milestones: Array<{ name: string; status: string; plannedAt: Date }>): string => {
  const open = milestones
    .filter((milestone) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED')
    .sort((left, right) => left.plannedAt.getTime() - right.plannedAt.getTime())[0];
  if (open) return open.name;
  const last = milestones[milestones.length - 1];
  return last ? last.name : 'Not started';
};

type ExplanationEnvelope = { topRiskFactors?: Array<{ label?: string; explanation?: string; factorCode?: string }> };

/** The leading factor from the stored explanation, so the table agrees with the drawer. */
const topFactorOf = (explanation: unknown): string => {
  const envelope = explanation as ExplanationEnvelope | null;
  const first = envelope?.topRiskFactors?.[0];
  if (!first) return 'No material warning';
  return first.label ?? first.factorCode ?? 'No material warning';
};

export const dashboardService = {
  /**
   * The whole dashboard payload in one read.
   *
   * One endpoint rather than several, because the table, the trend, and the
   * heatmap must describe the same set of projects. Fetching them separately
   * invites a dashboard whose parts disagree.
   */
  async overview(scope: AccessScope) {
    const now = new Date();
    const scopeWhere = projectScopeWhere(scope);

    const [projects, trendRows] = await Promise.all([
      prisma.project.findMany({
        where: scopeWhere,
        orderBy: { updatedAt: 'desc' },
        take: 500,
        include: {
          milestones: { orderBy: { plannedAt: 'asc' } },
          predictions: { orderBy: { predictedAt: 'desc' }, take: 1 },
        },
      }),
      prisma.prediction.findMany({
        where: {
          AND: [
            nestedProjectScopeWhere(scope) as Prisma.PredictionWhereInput,
            { predictedAt: { gte: new Date(now.getTime() - TREND_MONTHS * 31 * MS_PER_DAY) } },
          ],
        },
        orderBy: { predictedAt: 'asc' },
        take: 5_000,
        select: { predictedAt: true, riskLevel: true, delayProbability: true },
      }),
    ]);

    // --- Project rows --------------------------------------------------------
    const rows = projects.map((project) => {
      const prediction = project.predictions[0];
      const metrics = readMetricsFromSnapshot(prediction?.inputSnapshot);
      return {
        id: project.projectCode,
        name: project.name,
        district: project.district,
        department: project.department,
        state: project.state,
        stage: stageOf(project.milestones),
        progress: progressOf(project.milestones),
        probability: prediction ? Number(prediction.delayProbability) : 0,
        expectedDelay: prediction?.expectedDelayDays ? Math.round(Number(prediction.expectedDelayDays)) : 0,
        risk: (prediction?.riskLevel ?? 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
        factor: topFactorOf(prediction?.explanation),
        updated: relativeTime(project.updatedAt, now),
        parcels: metrics.parcelCount ?? 0,
        owners: metrics.affectedLandownerCount ?? 0,
        objections: metrics.unresolvedObjectionCount ?? metrics.objectionCount ?? 0,
        compensation: formatCrore(metrics.pendingCompensationAmount, 'pending'),
        legal:
          metrics.stayOrderFlag === true
            ? 'Stay order in force'
            : (metrics.openLegalCaseCount ?? 0) > 0
              ? `${metrics.openLegalCaseCount} open matter${metrics.openLegalCaseCount === 1 ? '' : 's'}`
              : 'No active cases',
        targetDate: formatDate(project.targetDate),
        area: `${project.milestones.length} stages`,
      };
    });

    // --- Six-month trend -----------------------------------------------------
    // Bucketed by calendar month from the stored prediction history, so the
    // chart is a record of what the system said over time.
    const buckets = new Map<string, { month: string; total: number; count: number; critical: number; high: number; order: number }>();
    for (let offset = TREND_MONTHS - 1; offset >= 0; offset -= 1) {
      const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      buckets.set(key, {
        month: MONTH_NAMES[date.getUTCMonth()]!,
        total: 0,
        count: 0,
        critical: 0,
        high: 0,
        order: date.getTime(),
      });
    }
    for (const prediction of trendRows) {
      const key = `${prediction.predictedAt.getUTCFullYear()}-${prediction.predictedAt.getUTCMonth()}`;
      const bucket = buckets.get(key);
      if (!bucket) continue;
      bucket.total += Number(prediction.delayProbability);
      bucket.count += 1;
      if (prediction.riskLevel === 'CRITICAL') bucket.critical += 1;
      if (prediction.riskLevel === 'HIGH') bucket.high += 1;
    }
    const trend = [...buckets.values()]
      .sort((left, right) => left.order - right.order)
      .map((bucket) => ({
        month: bucket.month,
        probability: bucket.count > 0 ? Number((bucket.total / bucket.count).toFixed(3)) : 0,
        critical: bucket.critical,
        high: bucket.high,
      }));

    // --- District heatmap ----------------------------------------------------
    // The value is the average delay probability across the district's projects,
    // as a percentage, which is what the colour scale reads.
    const districts = new Map<string, { name: string; state: string; total: number; count: number }>();
    for (const project of projects) {
      const prediction = project.predictions[0];
      if (!prediction) continue;
      const key = `${project.state}|${project.district}`;
      const entry = districts.get(key) ?? { name: project.district, state: project.state, total: 0, count: 0 };
      entry.total += Number(prediction.delayProbability);
      entry.count += 1;
      districts.set(key, entry);
    }

    return {
      projects: rows,
      trend,
      districts: [...districts.values()]
        .map((entry) => ({
          name: entry.name,
          state: entry.state,
          value: Math.round((entry.total / entry.count) * 100),
          projects: entry.count,
        }))
        .sort((left, right) => right.value - left.value)
        .slice(0, 12),
      generatedAt: now.toISOString(),
      scope: scope.level,
    };
  },
};
