/**
 * Generates the frontend's offline demonstration data.
 *
 * The dashboard reads `/analytics/dashboard`, which is computed from the
 * database. When the API is unreachable the interface still has to render
 * something, and that something must not be an independently typed set of
 * numbers: a hand-authored fallback drifts from the database and turns the demo
 * into a lie the first time a case fact changes.
 *
 * So the fallback is generated from the same dataset the seed writes, scored by
 * the same rule engine, and shaped by the same aggregation rules as the API
 * response. Regenerate it whenever `prisma/demoDataset.ts` changes:
 *
 *     npm run generate:demo-fallback
 *
 * A test fails if the committed file no longer matches what this script would
 * produce, so the two cannot silently diverge.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { DEMO_PROJECTS, TRAJECTORY_CURVES, type DemoProject } from '../prisma/demoDataset.js';
import { scoreCase } from '../src/predictions/ruleEngine.js';
import type { MilestoneContext } from '../src/recommendations/types.js';

const MS_PER_DAY = 86_400_000;
const TREND_MONTHS = 6;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A fixed reference date.
 *
 * The generated file is committed, so it must be reproducible: generating it
 * twice on different days has to produce the same bytes, or every regeneration
 * looks like a change.
 */
const REFERENCE_DATE = new Date('2026-09-16T09:00:00.000Z');

const at = (offsetDays: number): Date => new Date(REFERENCE_DATE.getTime() + offsetDays * MS_PER_DAY);

const currentMilestoneOf = (project: DemoProject): MilestoneContext | null => {
  const open = project.milestones
    .filter((milestone) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED')
    .sort((left, right) => left.plannedIn - right.plannedIn)[0];
  if (!open) return null;
  return {
    name: open.name,
    status: open.status,
    plannedAt: at(open.plannedIn),
    ownerDepartment: open.ownerDept ?? null,
    overdueDays: open.plannedIn < 0 ? -open.plannedIn : 0,
    stage: open.name,
  };
};

const bandFor = (score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =>
  score >= 0.75 ? 'CRITICAL' : score >= 0.5 ? 'HIGH' : score >= 0.25 ? 'MEDIUM' : 'LOW';

const progressOf = (project: DemoProject): number =>
  project.milestones.length === 0
    ? 0
    : Math.round((project.milestones.filter((milestone) => milestone.status === 'COMPLETED').length / project.milestones.length) * 100);

const stageOf = (project: DemoProject): string => {
  const open = currentMilestoneOf(project);
  if (open) return open.name;
  const last = project.milestones[project.milestones.length - 1];
  return last ? last.name : 'Not started';
};

const formatCrore = (amount: number | undefined): string =>
  amount === undefined || amount <= 0 ? 'None recorded' : `₹${(amount / 10_000_000).toFixed(1)} Cr pending`;

const formatDate = (date: Date): string =>
  `${String(date.getUTCDate()).padStart(2, '0')} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/** Mirrors the freshness wording the API produces from `updatedAt`. */
const freshness = (daysSinceLastUpdate: number | undefined): string => {
  const days = daysSinceLastUpdate ?? 0;
  if (days <= 0) return 'Just now';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
};

const scored = DEMO_PROJECTS.map((project) => ({
  project,
  result: scoreCase({
    metrics: project.metrics,
    milestone: currentMilestoneOf(project),
    asOfAt: REFERENCE_DATE,
    priority: project.priority,
  }),
}));

// --- Project rows -----------------------------------------------------------
const projects = scored.map(({ project, result }) => ({
  id: project.projectCode,
  name: project.name,
  district: project.district,
  department: project.department,
  state: project.state,
  stage: stageOf(project),
  progress: progressOf(project),
  probability: result.ruleScore,
  expectedDelay: result.expectedDelayDays,
  risk: result.riskLevel,
  factor: result.topRiskFactors[0]?.label ?? 'No material warning',
  updated: freshness(project.metrics.daysSinceLastUpdate),
  parcels: project.metrics.parcelCount ?? 0,
  owners: project.metrics.affectedLandownerCount ?? 0,
  objections: project.metrics.unresolvedObjectionCount ?? project.metrics.objectionCount ?? 0,
  compensation: formatCrore(project.metrics.pendingCompensationAmount),
  legal:
    project.metrics.stayOrderFlag === true
      ? 'Stay order in force'
      : (project.metrics.openLegalCaseCount ?? 0) > 0
        ? `${project.metrics.openLegalCaseCount} open matter${project.metrics.openLegalCaseCount === 1 ? '' : 's'}`
        : 'No active cases',
  targetDate: formatDate(at(project.targetIn)),
  area: `${project.milestones.length} stages`,
}));

// --- Six-month trend --------------------------------------------------------
// The same monthly buckets the API builds from stored prediction history, with
// each project's trajectory curve applied to the score the engine derived.
const trend = Array.from({ length: TREND_MONTHS }, (_unused, index) => {
  const monthsAgo = TREND_MONTHS - 1 - index;
  const date = new Date(Date.UTC(REFERENCE_DATE.getUTCFullYear(), REFERENCE_DATE.getUTCMonth() - monthsAgo, 1));
  let total = 0;
  let critical = 0;
  let high = 0;
  for (const { project, result } of scored) {
    const multiplier = TRAJECTORY_CURVES[project.trajectory][index] ?? 1;
    const probability = Math.min(0.99, Math.max(0.01, result.ruleScore * multiplier));
    total += probability;
    const band = bandFor(probability);
    if (band === 'CRITICAL') critical += 1;
    if (band === 'HIGH') high += 1;
  }
  return {
    month: MONTH_NAMES[date.getUTCMonth()]!,
    probability: Number((total / scored.length).toFixed(3)),
    critical,
    high,
  };
});

// --- District heatmap -------------------------------------------------------
const districtTotals = new Map<string, { name: string; state: string; total: number; count: number }>();
for (const { project, result } of scored) {
  const key = `${project.state}|${project.district}`;
  const entry = districtTotals.get(key) ?? { name: project.district, state: project.state, total: 0, count: 0 };
  entry.total += result.ruleScore;
  entry.count += 1;
  districtTotals.set(key, entry);
}
const districts = [...districtTotals.values()]
  .map((entry) => ({
    name: entry.name,
    state: entry.state,
    value: Math.round((entry.total / entry.count) * 100),
    projects: entry.count,
  }))
  .sort((left, right) => right.value - left.value || left.name.localeCompare(right.name))
  .slice(0, 12);

const distribution = projects.reduce<Record<string, number>>((counts, project) => {
  counts[project.risk] = (counts[project.risk] ?? 0) + 1;
  return counts;
}, {});

const header = `/**
 * GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Produced by \`backend/scripts/generateDemoFallback.ts\` from the demonstration
 * dataset in \`backend/prisma/demoDataset.ts\`, scored by the same rule engine the
 * API uses. Regenerate with:
 *
 *     npm --prefix backend run generate:demo-fallback
 *
 * This is the offline fallback only. When the API is reachable the dashboard
 * reads \`/analytics/dashboard\`, which is computed from the database. Nothing
 * here is an independent source of truth, which is why it is generated rather
 * than written: a hand-authored copy drifts from the database the first time a
 * case fact changes.
 *
 * Reference date: ${REFERENCE_DATE.toISOString()}
 * Derived risk distribution: ${Object.entries(distribution)
   .sort()
   .map(([band, count]) => `${band} ${count}`)
   .join(', ')}
 */

import type { DashboardData, Project, Risk } from './types/project';

export type { Project, Risk };

`;

const body = `export const projects: Project[] = ${JSON.stringify(projects, null, 2)};

export const trend: DashboardData['trend'] = ${JSON.stringify(trend, null, 2)};

export const districts: DashboardData['districts'] = ${JSON.stringify(districts, null, 2)};
`;

const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/src/data.ts');
writeFileSync(outputPath, header + body, 'utf8');

console.log(`Wrote ${projects.length} projects, ${trend.length} trend points, and ${districts.length} districts`);
console.log(`Distribution: ${JSON.stringify(distribution)}`);
console.log(`Output: ${outputPath}`);
