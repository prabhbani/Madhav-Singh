/**
 * Structured logging.
 *
 * Log lines are assembled from named fields rather than by spreading arbitrary
 * objects, because spreading is how case data, tokens, and request bodies end up
 * in a log aggregator that has a wider audience than the database.
 *
 * Two rules hold everywhere:
 *   - No request bodies, no response bodies, no query values.
 *   - Errors contribute a name and a message, and a stack only outside
 *     production, where it would otherwise reach a shared log sink.
 */

import { env } from './env.js';

/** Strips control characters so a log line cannot be forged or split. */
const sanitize = (value: string, max = 300): string =>
  value.replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), ' ').slice(0, max);

const describeError = (error: unknown): Record<string, string> => {
  if (!(error instanceof Error)) return { errorType: 'unknown' };
  const described: Record<string, string> = {
    errorType: sanitize(error.name, 80),
    errorMessage: sanitize(error.message, 300),
  };
  if (env.NODE_ENV !== 'production' && error.stack) described.stack = sanitize(error.stack, 2_000);
  return described;
};

const emit = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>): void => {
  const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
};

export const logger = {
  info: (fields: Record<string, unknown>) => emit('info', fields),
  warn: (fields: Record<string, unknown>) => emit('warn', fields),
  error: (fields: Record<string, unknown>, error?: unknown) =>
    emit('error', { ...fields, ...(error === undefined ? {} : describeError(error)) }),
  sanitize,
};

/** The per-request logger attached to `request.log`. */
export const requestLogger = (requestId: string) => ({
  error: (details: unknown, message: string) =>
    logger.error(
      { requestId, message: sanitize(message, 200), ...(typeof details === 'object' && details !== null ? { detail: sanitize(JSON.stringify(details), 300) } : {}) },
    ),
});
