import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { DEMO_PROJECTS, EXPECTED_DISTRIBUTION, TRAJECTORY_CURVES, type DemoProject, type RiskBand } from '../../prisma/demoDataset.js';
import { scoreCase } from '../../src/predictions/ruleEngine.js';
import { generateRecommendations } from '../../src/recommendations/engine.js';
import type { MilestoneContext } from '../../src/recommendations/types.js';

const AS_OF = new Date('2026-09-16T09:00:00.000Z');
const MS_PER_DAY = 86_400_000;

const currentMilestoneOf = (project: DemoProject): MilestoneContext | null => {
  const open = project.milestones
    .filter((milestone) => milestone.status !== 'COMPLETED' && milestone.status !== 'CANCELLED')
    .sort((left, right) => left.plannedIn - right.plannedIn)[0];
  if (!open) return null;
  return {
    name: open.name,
    status: open.status,
    plannedAt: new Date(AS_OF.getTime() + open.plannedIn * MS_PER_DAY),
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

const scored = DEMO_PROJECTS.map((project) => ({ project, result: scoreOf(project) }));

describe('demonstration dataset', () => {
  it('holds the number of cases the brief asked for', () => {
    assert.equal(DEMO_PROJECTS.length, 23);
    assert.ok(DEMO_PROJECTS.length >= 20 && DEMO_PROJECTS.length <= 30);
  });

  it('produces the intended risk distribution from the facts, not from a label', () => {
    const counts: Record<RiskBand, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
    for (const { result } of scored) counts[result.riskLevel] += 1;
    assert.deepEqual(counts, EXPECTED_DISTRIBUTION);
  });

  it('scores every case in the band its scenario describes', () => {
    const mismatches = scored
      .filter(({ project, result }) => project.expectedRisk !== result.riskLevel)
      .map(({ project, result }) => `${project.projectCode}: authored ${project.expectedRisk}, derived ${result.riskLevel}`);
    assert.deepEqual(mismatches, [], 'change the case facts, not the expected band');
  });

  it('gives every project a unique code and name', () => {
    const codes = DEMO_PROJECTS.map((project) => project.projectCode);
    const names = DEMO_PROJECTS.map((project) => project.name);
    assert.equal(new Set(codes).size, codes.length, 'a project code is repeated');
    assert.equal(new Set(names).size, names.length, 'a project name is repeated');
  });

  it('spreads across states, districts, departments, and project types', () => {
    const distinct = (values: string[]) => new Set(values).size;
    assert.ok(distinct(DEMO_PROJECTS.map((project) => project.state)) >= 8, 'too few states for a national demo');
    assert.ok(distinct(DEMO_PROJECTS.map((project) => project.district)) >= 15);
    assert.ok(distinct(DEMO_PROJECTS.map((project) => project.department)) >= 6);
    assert.ok(distinct(DEMO_PROJECTS.map((project) => project.projectType)) >= 8);
  });
});

describe('chart variation', () => {
  it('spans a wide range of scores rather than clustering', () => {
    const scores = scored.map(({ result }) => result.ruleScore);
    const lowest = Math.min(...scores);
    const highest = Math.max(...scores);
    assert.ok(lowest < 0.1, `the cleanest case scores ${lowest}, which is not clean enough to contrast`);
    assert.ok(highest > 0.85, `the worst case scores ${highest}, which is not severe enough to contrast`);
    assert.ok(highest - lowest > 0.8, 'the spread is too narrow for the charts to show variation');
  });

  it('separates the bands, so a risk filter visibly changes the table', () => {
    const byBand = (band: RiskBand) => scored.filter(({ result }) => result.riskLevel === band).map(({ result }) => result.ruleScore);
    const low = byBand('LOW');
    const medium = byBand('MEDIUM');
    const high = byBand('HIGH');
    const critical = byBand('CRITICAL');
    assert.ok(Math.max(...low) < Math.min(...medium));
    assert.ok(Math.max(...medium) < Math.min(...high));
    assert.ok(Math.max(...high) < Math.min(...critical));
  });

  it('varies expected delay alongside risk', () => {
    const delays = scored.map(({ result }) => result.expectedDelayDays);
    assert.ok(Math.max(...delays) - Math.min(...delays) > 60, 'expected delay barely moves across the dataset');
  });

  it('gives the district heatmap several distinct values', () => {
    const byDistrict = new Map<string, number[]>();
    for (const { project, result } of scored) {
      const key = `${project.state}|${project.district}`;
      byDistrict.set(key, [...(byDistrict.get(key) ?? []), result.ruleScore]);
    }
    const values = [...byDistrict.values()].map((scores) =>
      Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100),
    );
    assert.ok(values.length >= 15, 'too few districts for a heatmap');
    assert.ok(new Set(values).size >= 10, 'district values are too similar to colour differently');
    // The colour scale bands at 30, 50, and 70, so all four must be reachable.
    assert.ok(values.some((value) => value <= 30), 'no district lands in the lowest colour band');
    assert.ok(values.some((value) => value > 70), 'no district lands in the highest colour band');
  });

  it('moves the trend line over six months', () => {
    const monthly = Array.from({ length: 6 }, (_unused, index) => {
      const total = scored.reduce((sum, { project, result }) => {
        const multiplier = TRAJECTORY_CURVES[project.trajectory][index] ?? 1;
        return sum + Math.min(0.99, Math.max(0.01, result.ruleScore * multiplier));
      }, 0);
      return total / scored.length;
    });
    assert.equal(monthly.length, 6);
    assert.ok(Math.max(...monthly) - Math.min(...monthly) > 0.05, 'the trend line is flat');
    // The last multiplier is always one, so the final month is the mean of the
    // scores the engine derives today, after the same probability floor the
    // generator and the API apply.
    const today =
      scored.reduce((sum, { result }) => sum + Math.min(0.99, Math.max(0.01, result.ruleScore)), 0) / scored.length;
    assert.ok(Math.abs(monthly[5]! - today) < 1e-6, 'the series must end at the score the engine derives today');
  });

  it('covers every trajectory shape', () => {
    const shapes = new Set(DEMO_PROJECTS.map((project) => project.trajectory));
    for (const shape of ['IMPROVING', 'STABLE', 'WORSENING', 'SPIKING'] as const) {
      assert.ok(shapes.has(shape), `no project demonstrates a ${shape} trajectory`);
    }
  });
});

describe('explainability', () => {
  it('explains every project with at least one named factor', () => {
    for (const { project, result } of scored) {
      if (result.riskLevel === 'LOW' && result.ruleScore < 0.02) continue;
      assert.ok(result.topRiskFactors.length > 0, `${project.projectCode} has no explanation`);
    }
  });

  it('names a measurement and a threshold in every factor', () => {
    for (const { project, result } of scored) {
      for (const factor of result.topRiskFactors) {
        assert.ok(factor.factorCode.length > 0, `${project.projectCode}: factor has no code`);
        assert.ok(Number.isFinite(factor.measuredValue), `${project.projectCode}: factor has no measured value`);
        assert.ok(factor.explanation.length > 20, `${project.projectCode}: factor has no explanation`);
        assert.ok(factor.relativeContribution >= 0 && factor.relativeContribution <= 1);
      }
    }
  });

  it('makes no causal claim in any explanation', () => {
    const banned = /\b(caus(e|es|ed|ing)|guarantee|ensures?|will reduce|eliminates?)\b/i;
    for (const { result } of scored) {
      for (const factor of result.topRiskFactors) assert.doesNotMatch(factor.explanation, banned);
    }
  });

  it('explains the critical cases by a severe, named condition', () => {
    for (const { project, result } of scored) {
      if (result.riskLevel !== 'CRITICAL') continue;
      const codes = result.topRiskFactors.map((factor) => factor.factorCode);
      assert.ok(
        codes.some((code) => ['ACTIVE_STAY_ORDER', 'OWNERSHIP_UNRESOLVED', 'OPEN_LEGAL_CASE_COUNT', 'COMPENSATION_PENDING', 'MILESTONE_OVERDUE'].includes(code)),
        `${project.projectCode} is critical but names no severe condition: ${codes.join(', ')}`,
      );
    }
  });

  it('treats a stay order as the governing condition', () => {
    const stayOrderCases = scored.filter(({ project }) => project.metrics.stayOrderFlag === true);
    assert.ok(stayOrderCases.length > 0, 'the demo should include a hard-stop case');
    for (const { project, result } of stayOrderCases) {
      assert.equal(result.riskLevel, 'CRITICAL', `${project.projectCode} has a stay order but is not critical`);
      assert.equal(result.topRiskFactors[0]?.factorCode, 'ACTIVE_STAY_ORDER', 'the hard stop must lead the explanation');
    }
  });

  it('produces ranked, owned recommendations for every case that needs them', () => {
    for (const { project, result } of scored) {
      if (result.riskLevel === 'LOW') continue;
      const recommendations = generateRecommendations({
        asOfAt: AS_OF,
        project: {
          projectId: project.projectCode,
          department: project.department,
          state: project.state,
          district: project.district,
          status: project.status,
          targetDate: new Date(AS_OF.getTime() + project.targetIn * MS_PER_DAY),
          dataOrigin: 'SYNTHETIC_DEMO',
          metrics: project.metrics,
        },
        currentMilestone: currentMilestoneOf(project),
        prediction: {
          riskLevel: result.riskLevel,
          delayProbability: result.ruleScore,
          horizonDays: 90,
          predictionStatus: 'RULE_ONLY_FALLBACK',
          confidenceBand: 'LOW',
        },
        topRiskFactors: result.topRiskFactors.map((factor) => ({
          factorCode: factor.factorCode,
          relativeContribution: factor.relativeContribution,
          direction: 'INCREASES_RISK' as const,
          source: 'RULE' as const,
        })),
      });
      assert.ok(recommendations.recommendations.length > 0, `${project.projectCode} produced no recommendation`);
      for (const recommendation of recommendations.recommendations) {
        assert.ok(recommendation.responsibleDepartment.length > 0);
        assert.ok(recommendation.suggestedDeadline.days > 0);
        assert.match(recommendation.expectedImpact, /\b(may|could|is intended to|supports)\b/i);
      }
    }
  });
});

describe('scenario prose', () => {
  it('gives every project a scenario worth reading aloud', () => {
    for (const project of DEMO_PROJECTS) {
      assert.ok(project.scenario.length > 60, `${project.projectCode} has no real scenario`);
      assert.ok(project.scenario.trim().endsWith('.'), `${project.projectCode} scenario is not a sentence`);
    }
  });

  it('covers the four scenario shapes the brief named', () => {
    const shapes = {
      largeCleanProject: scored.some(
        ({ project, result }) => (project.metrics.affectedLandownerCount ?? 0) > 500 && result.riskLevel === 'LOW',
      ),
      documentsAndSlippage: scored.some(
        ({ project, result }) =>
          result.riskLevel === 'MEDIUM' && (project.metrics.missingDocumentCount ?? 0) > 5 && (project.metrics.milestoneSlippageCount ?? 0) > 0,
      ),
      disputedWithBacklogAndLegal: scored.some(
        ({ project, result }) =>
          result.riskLevel === 'HIGH' &&
          (project.metrics.unresolvedRecordCount ?? 0) > 20 &&
          (project.metrics.paymentProcessingDays ?? 0) > 60 &&
          (project.metrics.openLegalCaseCount ?? 0) > 0,
      ),
      severeWithCourtCase: scored.some(
        ({ project, result }) =>
          result.riskLevel === 'CRITICAL' &&
          (project.metrics.unresolvedRecordCount ?? 0) > 50 &&
          (project.metrics.unresolvedObjectionCount ?? 0) > 100 &&
          (project.metrics.openLegalCaseCount ?? 0) > 2,
      ),
    };
    for (const [shape, present] of Object.entries(shapes)) {
      assert.ok(present, `no project demonstrates the ${shape} scenario`);
    }
  });
});

describe('generated frontend fallback', () => {
  const generatedPath = new URL('../../../frontend/src/data.ts', import.meta.url);

  it('is marked generated, so nobody edits it by hand', () => {
    const source = readFileSync(generatedPath, 'utf8');
    assert.match(source, /GENERATED FILE\. DO NOT EDIT BY HAND\./);
    assert.match(source, /generateDemoFallback\.ts/);
  });

  it('matches what the generator would produce right now', () => {
    const before = readFileSync(generatedPath, 'utf8');
    execFileSync('npx', ['tsx', 'scripts/generateDemoFallback.ts'], {
      cwd: new URL('../../', import.meta.url).pathname,
      stdio: 'pipe',
    });
    const after = readFileSync(generatedPath, 'utf8');
    assert.equal(
      after,
      before,
      'the committed fallback is stale; run `npm --prefix backend run generate:demo-fallback`',
    );
  });

  it('carries every project, with the same distribution the engine derives', () => {
    const source = readFileSync(generatedPath, 'utf8');
    assert.equal((source.match(/"id":/g) ?? []).length, DEMO_PROJECTS.length);
    for (const band of Object.keys(EXPECTED_DISTRIBUTION) as RiskBand[]) {
      const occurrences = (source.match(new RegExp(`"risk": "${band}"`, 'g')) ?? []).length;
      assert.equal(occurrences, EXPECTED_DISTRIBUTION[band], `${band} count in the fallback does not match`);
    }
  });
});
