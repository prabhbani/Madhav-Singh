import type { RequestHandler } from 'express';
import { predictionService } from '../services/predictionService.js';

export const create: RequestHandler = async (request, response) =>
  response
    .status(201)
    .json(await predictionService.predict(request.body.projectId, request.body.horizonDays, request.body.asOfAt, request.log));

export const latest: RequestHandler = async (request, response) =>
  response.json(await predictionService.latest(String(request.params.id)));

export const history: RequestHandler = async (request, response) =>
  response.json(await predictionService.history(String(request.params.id)));
