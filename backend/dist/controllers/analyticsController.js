import { analyticsService } from '../services/analyticsService.js';
import { currentScope } from '../middlewares/authorize.js';
import { projectService } from '../services/projectService.js';
export const overview = async (request, response) => response.json(await analyticsService.overview(currentScope(request)));
export const departments = async (request, response) => response.json(await analyticsService.departments(currentScope(request)));
export const districts = async (request, response) => response.json(await analyticsService.districts(currentScope(request)));
export const timeline = async (request, response) => response.json(await analyticsService.timeline(currentScope(request)));
export const riskOverview = async (request, response) => response.json(await analyticsService.riskOverview(currentScope(request)));
export const highRisk = async (request, response) => response.json(await analyticsService.highRisk(currentScope(request)));
export const riskTrends = async (request, response) => response.json(await analyticsService.riskTrends(currentScope(request)));
/**
 * Scoped dataset export. Separated from the read routes because bulk extraction
 * is a distinct privilege and is audited with the caller's IP address.
 */
export const exportDataset = async (request, response) => {
    const scope = currentScope(request);
    const rows = await projectService.exportDataset(scope);
    response.json({ generatedAt: new Date().toISOString(), scope: scope.level, rowCount: rows.length, rows });
};
