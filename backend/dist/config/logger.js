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
const sanitize = (value, max = 300) => value.replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), ' ').slice(0, max);
const describeError = (error) => {
    if (!(error instanceof Error))
        return { errorType: 'unknown' };
    const described = {
        errorType: sanitize(error.name, 80),
        errorMessage: sanitize(error.message, 300),
    };
    if (env.NODE_ENV !== 'production' && error.stack)
        described.stack = sanitize(error.stack, 2_000);
    return described;
};
const emit = (level, fields) => {
    const line = JSON.stringify({ level, time: new Date().toISOString(), ...fields });
    if (level === 'error')
        console.error(line);
    else if (level === 'warn')
        console.warn(line);
    else
        console.info(line);
};
export const logger = {
    info: (fields) => emit('info', fields),
    warn: (fields) => emit('warn', fields),
    error: (fields, error) => emit('error', { ...fields, ...(error === undefined ? {} : describeError(error)) }),
    sanitize,
};
/** The per-request logger attached to `request.log`. */
export const requestLogger = (requestId) => ({
    error: (details, message) => logger.error({ requestId, message: sanitize(message, 200), ...(typeof details === 'object' && details !== null ? { detail: sanitize(JSON.stringify(details), 300) } : {}) }),
});
