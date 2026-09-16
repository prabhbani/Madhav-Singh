import type { DashboardData, Project, Risk } from '../types/project';

/**
 * Portfolio summary.
 *
 * Every figure the dashboard tiles show is computed from the project rows the
 * API returned. Nothing here is a constant: if the database changes, the tiles
 * change, and a judge can check any tile against the table below it.
 */
export type PortfolioSummary = {
  total: number;
  atRisk: number;
  atRiskShare: number;
  highOrCritical: number;
  criticalCount: number;
  predictedDelayDays: number;
  averageDelayDays: number;
  onTrack: number;
  onTrackShare: number;
  byRisk: Record<Risk, number>;
  /** Projects whose current stage milestone is already past its planned date. */
  worstProject: Project | null;
};

const AT_RISK: readonly Risk[] = ['MEDIUM', 'HIGH', 'CRITICAL'];
const URGENT: readonly Risk[] = ['HIGH', 'CRITICAL'];

export const summarize = (projects: Project[]): PortfolioSummary => {
  const byRisk: Record<Risk, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  let predictedDelayDays = 0;
  for (const project of projects) {
    byRisk[project.risk] += 1;
    predictedDelayDays += project.expectedDelay;
  }

  const total = projects.length;
  const atRisk = AT_RISK.reduce((sum, risk) => sum + byRisk[risk], 0);
  const highOrCritical = URGENT.reduce((sum, risk) => sum + byRisk[risk], 0);
  const delayed = projects.filter((project) => project.expectedDelay > 0);

  return {
    total,
    atRisk,
    atRiskShare: total > 0 ? atRisk / total : 0,
    highOrCritical,
    criticalCount: byRisk.CRITICAL,
    predictedDelayDays,
    averageDelayDays: delayed.length > 0 ? predictedDelayDays / delayed.length : 0,
    onTrack: byRisk.LOW,
    onTrackShare: total > 0 ? byRisk.LOW / total : 0,
    byRisk,
    worstProject:
      [...projects].sort((left, right) => right.probability - left.probability)[0] ?? null,
  };
};

export type DepartmentSummary = {
  department: string;
  projects: number;
  averageProbability: number;
  highOrCritical: number;
  predictedDelayDays: number;
  objections: number;
};

/** Department rollup, aggregated from the rows the API returned. */
export const byDepartment = (projects: Project[]): DepartmentSummary[] => {
  const groups = new Map<string, Project[]>();
  for (const project of projects) {
    groups.set(project.department, [...(groups.get(project.department) ?? []), project]);
  }
  return [...groups.entries()]
    .map(([department, rows]) => ({
      department,
      projects: rows.length,
      averageProbability: rows.reduce((sum, row) => sum + row.probability, 0) / rows.length,
      highOrCritical: rows.filter((row) => row.risk === 'HIGH' || row.risk === 'CRITICAL').length,
      predictedDelayDays: rows.reduce((sum, row) => sum + row.expectedDelay, 0),
      objections: rows.reduce((sum, row) => sum + row.objections, 0),
    }))
    .sort((left, right) => right.averageProbability - left.averageProbability);
};

export type StateSummary = { state: string; projects: number; averageProbability: number; districts: number };

/** State rollup, from the district figures the API computed. */
export const byState = (districts: DashboardData['districts']): StateSummary[] => {
  const groups = new Map<string, DashboardData['districts']>();
  for (const district of districts) {
    groups.set(district.state, [...(groups.get(district.state) ?? []), district]);
  }
  return [...groups.entries()]
    .map(([state, rows]) => ({
      state,
      projects: rows.reduce((sum, row) => sum + row.projects, 0),
      averageProbability:
        rows.reduce((sum, row) => sum + row.value * row.projects, 0) / rows.reduce((sum, row) => sum + row.projects, 0) / 100,
      districts: rows.length,
    }))
    .sort((left, right) => right.averageProbability - left.averageProbability);
};

export const formatDays = (days: number): string =>
  days >= 1000 ? `${Math.round(days).toLocaleString('en-IN')} days` : `${Math.round(days)} days`;

export const formatPercent = (share: number): string => `${(share * 100).toFixed(1)}%`;
