/**
 * Error responses.
 *
 * A client learns the code, a curated message, and its own request id. It never
 * learns a stack trace, a database message, an upstream failure, or the path it
 * asked for reflected back.
 *
 * Validation issues are the one case where detail is returned, because a caller
 * cannot fix a malformed request without knowing which field was wrong. Zod
 * issues name paths and expected types, not stored values.
 */

import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors/AppError.js';
import { logger } from '../config/logger.js';

export const notFoundHandler: RequestHandler = (_request, _response, next) =>
  // The requested path is deliberately not echoed: reflecting caller-controlled
  // text into a response body invites it to be rendered somewhere later.
  next(new AppError(404, 'NOT_FOUND', 'The requested route does not exist'));

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const normalized =
    error instanceof AppError
      ? error
      : error instanceof ZodError
        ? new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', error.issues)
        : new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');

  if (normalized.statusCode >= 500) {
    logger.error(
      { requestId: request.requestId, method: request.method, path: logger.sanitize(request.path, 200), code: normalized.code },
      error,
    );
  }

  response.status(normalized.statusCode).json({
    error: {
      code: normalized.code,
      message: normalized.message,
      // Details travel only for client-correctable failures. A 5xx carries none.
      ...(normalized.statusCode < 500 && normalized.details !== undefined ? { details: normalized.details } : {}),
    },
    requestId: request.requestId,
  });
};
