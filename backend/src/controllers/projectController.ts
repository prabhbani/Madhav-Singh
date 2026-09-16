import type { RequestHandler } from 'express';
import { projectService } from '../services/projectService.js';
import { currentScope } from '../middlewares/authorize.js';

export const list: RequestHandler = async (request, response) =>
  response.json(await projectService.list(currentScope(request), request.query as Record<string, unknown>));
export const get: RequestHandler = async (request, response) => response.json(await projectService.get(String(request.params.id)));
export const create: RequestHandler = async (request, response) => response.status(201).json(await projectService.create(request.body, request.user?.id));
export const update: RequestHandler = async (request, response) => response.json(await projectService.update(String(request.params.id), request.body));
export const remove: RequestHandler = async (request, response) => response.json(await projectService.remove(String(request.params.id)));
export const milestones: RequestHandler = async (request, response) => response.json(await projectService.milestones(String(request.params.id)));
export const createMilestone: RequestHandler = async (request, response) => response.status(201).json(await projectService.createMilestone(String(request.params.id), request.body));
export const updateMilestone: RequestHandler = async (request, response) => response.json(await projectService.updateMilestone(String(request.params.id), request.body));
