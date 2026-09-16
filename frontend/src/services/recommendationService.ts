import { apiGet } from '../api/client';
import { recommendationResultSchema, type Recommendation, type RecommendationResult } from '../types/recommendation';
import type { Project } from '../types/project';

/**
 * Demo recommendations, built from the same project fields the drawer displays.
 *
 * This is a fallback for when the API is unreachable. It reads the counts shown
 * on screen rather than inventing advice, and it uses the same hedged wording
 * rules as the backend engine. Ranking mirrors the engine's ordering: priority
 * first, then score.
 */
const demoRecommendations = (project: Project): Recommendation[] => {
  const scale = project.probability;
  const draft: Array<Omit<Recommendation, 'rank' | 'recommendationId'> & { score: number }> = [];

  const priorityFor = (score: number): Recommendation['priority'] =>
    score >= 0.72 ? 'CRITICAL' : score >= 0.52 ? 'HIGH' : score >= 0.32 ? 'MEDIUM' : 'LOW';

  const add = (
    score: number,
    code: string,
    action: string,
    reason: string,
    department: string,
    days: number,
    impact: string,
    evidence: string,
  ) => {
    draft.push({
      priority: priorityFor(score),
      priorityBasis: 'RANKING_SCORE',
      action,
      reason,
      relatedRiskFactor: {
        factorCode: code,
        label: evidence,
        direction: 'INCREASES_RISK',
        relativeContribution: null,
        rank: null,
        source: 'RULE',
      },
      responsibleDepartment: department,
      suggestedDeadline: { days, dueAt: new Date(Date.now() + days * 86_400_000).toISOString() },
      expectedImpact: impact,
      status: 'OPEN',
      rankingScore: Number(score.toFixed(4)),
      evidence: { code, description: evidence, source: 'PROJECT_DATA' },
      capacityNote: null,
      score,
    });
  };

  if (project.objections > 0) {
    add(
      Math.min(1, 0.32 + project.objections / 25 + scale * 0.2),
      'OPEN_OBJECTION_COUNT',
      `Schedule hearings for the ${project.objections} unresolved objections and assign a reviewing officer to each.`,
      `${project.objections} landowner objections remain unresolved and open objection volume is associated with elevated predicted delay risk for this project.`,
      'Land Acquisition Cell',
      21,
      'May reduce the unresolved stakeholder workload and could help mitigate escalation into legal disputes.',
      `${project.objections} unresolved objections`,
    );
  }
  if (/ownership|title/i.test(project.factor) || /verification/i.test(project.stage)) {
    add(
      Math.min(1, 0.4 + scale * 0.35),
      'OWNERSHIP_UNRESOLVED',
      `Complete ownership verification for the unresolved parcels in this acquisition.`,
      `Ownership verification is currently incomplete across ${project.parcels} recorded parcels and is associated with elevated predicted delay risk for this project.`,
      'Land Records Department',
      14,
      'May reduce the administrative bottleneck in title verification and could help mitigate downstream compensation delays.',
      project.factor,
    );
  }
  if (/pending/i.test(project.compensation)) {
    add(
      Math.min(1, 0.34 + scale * 0.3),
      'COMPENSATION_PENDING',
      'Escalate compensation cases in processing beyond the departmental window to the payment review.',
      `Compensation of ${project.compensation} remains open, and a prolonged payment queue is associated with elevated predicted delay risk for this project.`,
      'Finance and Compensation Department',
      15,
      'May reduce the financial dependency holding the case open and could help mitigate delay in reaching possession.',
      project.compensation,
    );
  }
  if (!/no (active cases|stay order)/i.test(project.legal)) {
    add(
      Math.min(1, 0.45 + scale * 0.3),
      'OPEN_LEGAL_CASE_COUNT',
      `Assign legal representation and a hearing calendar for the matters recorded as open (${project.legal}).`,
      `${project.legal} are recorded against this acquisition, and open legal exposure is associated with elevated predicted delay risk for this project.`,
      'Legal Department',
      10,
      'May give the litigation a tracked hearing calendar and could help mitigate procedural delay.',
      project.legal,
    );
  }
  if (/missing document/i.test(project.factor)) {
    add(
      Math.min(1, 0.3 + scale * 0.3),
      'MISSING_DOCUMENT_COUNT',
      'Complete the document checklist for the missing required documents and record each submission.',
      `${project.factor} are outstanding on the case file, and an incomplete document set is associated with elevated predicted delay risk for this project.`,
      'Revenue Department',
      10,
      'May close the readiness gap in the case file and could help mitigate rework at the next verification stage.',
      project.factor,
    );
  }
  if (/slippage|overdue/i.test(project.factor)) {
    add(
      Math.min(1, 0.38 + scale * 0.32),
      'MILESTONE_SLIPPAGE_COUNT',
      'Hold a corrective project review covering the repeatedly missed milestones and record a revised, resourced schedule.',
      `${project.factor} has been recorded on this project, and repeated slippage is associated with elevated predicted delay risk for this project.`,
      project.department,
      14,
      'May surface the recurring schedule constraint at project level and could help mitigate continued drift.',
      project.factor,
    );
  }

  const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  return draft
    .sort((left, right) => order[right.priority] - order[left.priority] || right.score - left.score)
    .map(({ score: _score, ...recommendation }, index) => ({
      ...recommendation,
      rank: index + 1,
      recommendationId: `demo_${project.id}_${recommendation.relatedRiskFactor?.factorCode ?? index}`,
    }));
};

export async function getRecommendations(project: Project): Promise<{ items: Recommendation[]; live: boolean }> {
  try {
    const result: RecommendationResult = await apiGet(`/projects/${project.id}/recommendations`, recommendationResultSchema);
    return { items: result.recommendations, live: true };
  } catch {
    return { items: demoRecommendations(project), live: false };
  }
}
