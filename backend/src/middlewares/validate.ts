import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

export const validate = (schema: ZodType): RequestHandler => (request, _response, next) => {
  const result = schema.safeParse({ body: request.body, params: request.params, query: request.query });
  if (!result.success) return next(result.error);
  const data = result.data as { body: unknown; params: Record<string, string>; query: Record<string, unknown> };
  request.body = data.body;
  request.params = data.params;
  request.query = data.query as never;
  next();
};