/**
 * Demonstration seed.
 *
 * Writes the twenty-three demonstration cases and then lets the real engines do
 * the rest. Nothing downstream is authored by hand:
 *
 *   - Risk comes from the rule engine scoring the recorded facts.
 *   - Recommendations come from the recommendation engine reading the stored
 *     case, ranked and explained as they would be in service.
 *   - Alerts come from the early warning detectors, with their own evidence.
 *   - Six months of prediction history is written per project so the trend chart
 *     has real rows to aggregate, ending at the score the engine derives today.
 *
 * The consequence is that every number on the dashboard can be traced to a row
 * in the database, and changing a case fact changes the dashboard.
 *
 * Run with: npm run prisma:seed:demo
 */

import { PrismaClient, type Prisma } from '@prisma/client';
import { DEMO_PROJECTS, TRAJECTORY_CURVES, type DemoProject } from './demoDataset.js';
import { scoreCase } from '../src/predictions/ruleEngine.js';
import type { MilestoneContext, ProjectMetrics } from '../src/recommendations/types.js';

const prisma = new PrismaClient();

const MS_PER_DAY = 86_400_000;
const AS_OF = new Date();
const RULE_MODEL_VERSION = 'rule-risk-policy-v1';

const at = (offsetDays: number): Date => new Date(AS_OF.getTime() + offsetDays * MS_PER_DAY);

/** camelCase to snake_case, so the snapshot matches the ML feature columns. */
const toSnakeCase = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const snapshotFor = (metrics: ProjectMetrics): Prisma.InputJsonValue =>
  Object.fromEntries(
    Object.entries(metrics)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [toSnakeCase(key), value as never]),
  );

/** The earliest open milestone, which is the one the engines treat as current. */
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

const scoreOf = (project: DemoProject) =>
  scoreCase({
    metrics: project.metrics,
    milestone: currentMilestoneOf(project),
    asOfAt: AS_OF,
    priority: project.priority,
  });

const bandFor = (score: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =>
  score >= 0.75 ? 'CRITICAL' : score >= 0.5 ? 'HIGH' : score >= 0.25 ? 'MEDIUM' : 'LOW';

/** Removes everything this seed creates, so it can be run repeatedly. */
const clearDemoData = async (): Promise<void> => {
  const codes = DEMO_PROJECTS.map((project) => project.projectCode);
  const projects = await prisma.project.findMany({ where: { projectCode: { in: codes } }, select: { id: true } });
  const ids = projects.map((project) => project.id);
  if (ids.length === 0) return;
  await prisma.alertEvent.deleteMany({ where: { alert: { projectId: { in: ids } } } });
  await prisma.alert.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.recommendation.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.prediction.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.document.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.milestone.deleteMany({ where: { projectId: { in: ids } } });
  await prisma.project.deleteMany({ where: { id: { in: ids } } });
};

const createProject = async (demo: DemoProject) => {
  const project = await prisma.project.create({
    data: {
      projectCode: demo.projectCode,
      name: demo.name,
      state: demo.state,
      district: demo.district,
      department: demo.department,
      projectType: demo.projectType,
      priority: demo.priority,
      status: demo.status,
      plannedStartDate: at(demo.startedIn),
      targetDate: at(demo.targetIn),
      dataOrigin: 'SYNTHETIC_DEMO',
    },
  });

  await prisma.milestone.createMany({
    data: demo.milestones.map((milestone) => ({
      projectId: project.id,
      name: milestone.name,
      status: milestone.status,
      plannedAt: at(milestone.plannedIn),
      completedAt: milestone.completedIn === undefined ? null : at(milestone.completedIn),
      ownerDept: milestone.ownerDept ?? null,
    })),
  });

  // Document rows are expanded from the counts, so the derived document metrics
  // in `caseSnapshot` agree with the authored ones.
  const documents: Prisma.DocumentCreateManyInput[] = [];
  for (const group of demo.documents) {
    for (let index = 0; index < group.count; index += 1) {
      documents.push({
        projectId: project.id,
        documentType: group.documentType,
        documentReference: `${demo.projectCode}/${group.documentType}/${String(index + 1).padStart(3, '0')}`,
        status: group.status,
        submittedAt: at(-Math.round(20 + index * 3)),
        verifiedAt: group.status === 'VERIFIED' ? at(-Math.round(10 + index * 2)) : null,
      });
    }
  }
  if (documents.length > 0) await prisma.document.createMany({ data: documents });

  return project;
};

/**
 * Six monthly predictions per project.
 *
 * The series is the derived score scaled by the project's trajectory curve,
 * whose final entry is always one. The last point is therefore the score the
 * engine produces today, not an independently invented figure.
 */
const createPredictionHistory = async (projectId: string, demo: DemoProject) => {
  const scored = scoreOf(demo);
  const curve = TRAJECTORY_CURVES[demo.trajectory];
  const snapshot = snapshotFor(demo.metrics);

  for (const [index, multiplier] of curve.entries()) {
    const monthsAgo = curve.length - 1 - index;
    const probability = Math.min(0.99, Math.max(0.01, scored.ruleScore * multiplier));
    const isCurrent = monthsAgo === 0;

    await prisma.prediction.create({
      data: {
        projectId,
        modelVersion: RULE_MODEL_VERSION,
        predictedAt: at(-monthsAgo * 30),
        horizonDays: 90,
        delayProbability: Number(probability.toFixed(5)),
        expectedDelayDays: Math.round(scored.expectedDelayDays * multiplier),
        riskLevel: bandFor(probability),
        confidenceBand: 'LOW',
        // The full feature snapshot is stored only on the current prediction,
        // which is the one the recommendation and alert engines read back.
        inputSnapshot: isCurrent ? snapshot : { as_of_months_ago: monthsAgo },
        explanation: isCurrent
          ? {
              method: 'RULE_NOISY_OR',
              policyVersion: scored.policyVersion,
              ruleScore: scored.ruleScore,
              groups: scored.groups,
              topRiskFactors: scored.topRiskFactors,
              limitations: [
                'This is a rule score, not a calibrated probability.',
                'It is a predictive association, not a causal finding.',
                'Underlying data is marked SYNTHETIC_DEMO and must not support an official decision.',
              ],
            }
          : {},
      },
    });
  }
  return scored;
};

const main = async (): Promise<void> => {
  console.log('Clearing any previous demonstration data...');
  await clearDemoData();

  const summary: Array<{ code: string; expected: string; derived: string; score: number }> = [];

  for (const demo of DEMO_PROJECTS) {
    const project = await createProject(demo);
    const scored = await createPredictionHistory(project.id, demo);
    summary.push({ code: demo.projectCode, expected: demo.expectedRisk, derived: scored.riskLevel, score: scored.ruleScore });
  }
  console.log(`Created ${summary.length} projects with milestones, documents, and six months of predictions.`);

  // The engines are imported after the rows exist, because they read the
  // database rather than the dataset. This is the same path a live evaluation
  // takes, so the demo shows real output rather than a rehearsal of it.
  const { recommendationService } = await import('../src/services/recommendationService.js');
  const { alertService } = await import('../src/services/alertService.js');

  let recommendationCount = 0;
  let alertCount = 0;
  for (const demo of DEMO_PROJECTS) {
    const project = await prisma.project.findUnique({ where: { projectCode: demo.projectCode }, select: { id: true } });
    if (!project) continue;
    const recommendations = await recommendationService.generate(project.id, { persist: true });
    recommendationCount += recommendations.recommendations.length;
    // Notifications are suppressed: a seed should not page anyone.
    const alerts = await alertService.evaluate(project.id, { persist: true, notify: false });
    alertCount += alerts.alerts.length;
  }

  const mismatches = summary.filter((row) => row.expected !== row.derived);
  console.log(`Generated ${recommendationCount} recommendations and ${alertCount} alerts from the stored cases.`);
  console.log('\nDerived risk distribution:');
  for (const band of ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const) {
    const rows = summary.filter((row) => row.derived === band);
    const scores = rows.map((row) => row.score);
    const range = scores.length > 0 ? `${Math.min(...scores).toFixed(2)} to ${Math.max(...scores).toFixed(2)}` : 'none';
    console.log(`  ${band.padEnd(9)} ${String(rows.length).padStart(2)} projects, rule score ${range}`);
  }

  if (mismatches.length > 0) {
    console.error('\nThe engine disagreed with the authored scenario for:');
    for (const row of mismatches) console.error(`  ${row.code}: expected ${row.expected}, derived ${row.derived} (${row.score})`);
    throw new Error('demonstration dataset does not produce its intended distribution');
  }
  console.log('\nEvery project scored the band its facts describe.');
};

try {
  await main();
} finally {
  await prisma.$disconnect();
}
