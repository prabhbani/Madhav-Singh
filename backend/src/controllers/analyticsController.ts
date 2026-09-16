import type { RequestHandler } from 'express';
import { analyticsService } from '../services/analyticsService.js';
import { currentScope } from '../middlewares/authorize.js';
import { projectService } from '../services/projectService.js';
import { dashboardService } from '../services/dashboardService.js';

/** Table, trend, and heatmap in one scoped read, all derived from stored rows. */
export const dashboard: RequestHandler = async (request, response) =>
  response.json(await dashboardService.overview(currentScope(request)));

export const overview: RequestHandler = async (request, response) => response.json(await analyticsService.overview(currentScope(request)));
export const departments: RequestHandler = async (request, response) => response.json(await analyticsService.departments(currentScope(request)));
export const districts: RequestHandler = async (request, response) => response.json(await analyticsService.districts(currentScope(request)));
export const timeline: RequestHandler = async (request, response) => response.json(await analyticsService.timeline(currentScope(request)));
export const riskOverview: RequestHandler = async (request, response) => response.json(await analyticsService.riskOverview(currentScope(request)));
export const highRisk: RequestHandler = async (request, response) => response.json(await analyticsService.highRisk(currentScope(request)));
export const riskTrends: RequestHandler = async (request, response) => response.json(await analyticsService.riskTrends(currentScope(request)));

/**
 * Scoped dataset export. Separated from the read routes because bulk extraction
 * is a distinct privilege and is audited with the caller's IP address.
 */
export const exportDataset: RequestHandler = async (request, response) => {
  const scope = currentScope(request);
  const rows = await projectService.exportDataset(scope);
  response.json({ generatedAt: new Date().toISOString(), scope: scope.level, rowCount: rows.length, rows });
};
