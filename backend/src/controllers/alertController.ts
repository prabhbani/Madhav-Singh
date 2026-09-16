import type { RequestHandler } from 'express';
import { alertService, type EvaluateOptions } from '../services/alertService.js';
import { currentScope } from '../middlewares/authorize.js';

/** Runs every detector for one project and persists the engine's decisions. */
export const evaluate: RequestHandler = async (request, response) => {
  const body = request.body as EvaluateOptions;
  const result = await alertService.evaluate(String(request.params.id), {
    asOfAt: body.asOfAt,
    horizonDays: body.horizonDays,
    persist: body.persist,
    notify: body.notify,
    snapshot: body.snapshot,
  });
  response.status(201).json(result);
};

/** Sweeps every active project. Intended for the scheduled early warning run. */
export const evaluateAll: RequestHandler = async (request, response) => {
  const body = request.body as EvaluateOptions;
  response.status(201).json(await alertService.evaluateAll(currentScope(request), { notify: body.notify, persist: body.persist }));
};

export const list: RequestHandler = async (request, response) =>
  response.json(await alertService.list(currentScope(request), request.query as Record<string, unknown>));

/** Live alerts grouped by severity, with the counts a badge needs. */
export const notificationCentre: RequestHandler = async (request, response) => {
  const mine = request.query.mine === 'true';
  response.json(
    await alertService.notificationCentre(currentScope(request), {
      assignedToId: mine ? request.user?.id : undefined,
      district: typeof request.query.district === 'string' ? request.query.district : undefined,
    }),
  );
};

export const history: RequestHandler = async (request, response) =>
  response.json(await alertService.history(String(request.params.id)));

export const activity: RequestHandler = async (request, response) =>
  response.json(await alertService.recentActivity(currentScope(request), Number(request.query.limit ?? 100)));

export const acknowledge: RequestHandler = async (request, response) =>
  response.json(
    await alertService.acknowledge(String(request.params.id), request.user?.id, request.body?.note as string | undefined),
  );

export const updateStatus: RequestHandler = async (request, response) =>
  response.json(
    await alertService.updateStatus(
      String(request.params.id),
      String(request.body.status),
      request.user?.id,
      request.body?.note as string | undefined,
    ),
  );

export const versions: RequestHandler = async (_request, response) => response.json(alertService.versions());
