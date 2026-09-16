import type { RequestHandler } from 'express';
import { recommendationService, type GenerateOptions } from '../services/recommendationService.js';

/** Runs the engine against current evidence and stores the ranked actions. */
export const generate: RequestHandler = async (request, response) => {
  const body = request.body as GenerateOptions;
  const result = await recommendationService.generate(String(request.params.id), {
    horizonDays: body.horizonDays,
    asOfAt: body.asOfAt,
    persist: body.persist,
    snapshot: body.snapshot,
  });
  response.status(201).json(result);
};

/** Stored recommendations for a project, in rank order. */
export const list: RequestHandler = async (request, response) =>
  response.json(await recommendationService.list(String(request.params.id)));

/** Officer decision on a single recommendation. */
export const updateStatus: RequestHandler = async (request, response) =>
  response.json(await recommendationService.updateStatus(String(request.params.id), String(request.body.status)));

/** Active policy and catalogue versions, for audit screens. */
export const versions: RequestHandler = async (_request, response) => response.json(recommendationService.versions());
