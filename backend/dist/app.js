import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { applySecurity, requireJsonBody } from './middlewares/security.js';
import { requestContext } from './middlewares/requestContext.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import routes from './routes/index.js';
import { openapi } from './config/openapi.js';
import { env } from './config/env.js';
import { logger, requestLogger } from './config/logger.js';
export const app = express();
// Audited IP addresses and rate-limit buckets are only meaningful when the proxy
// chain is declared, so this is configuration rather than a default-on guess.
app.set('trust proxy', env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY);
app.set('etag', false);
app.use(requestContext);
app.use((request, response, next) => {
    const startedAt = Date.now();
    request.log = requestLogger(request.requestId);
    response.on('finish', () => {
        // Path only, never the query string: search terms and identifiers in a
        // query are case data, and a log sink usually has a wider audience.
        logger.info({
            requestId: request.requestId,
            method: request.method,
            path: logger.sanitize(request.path, 200),
            status: response.statusCode,
            durationMs: Date.now() - startedAt,
        });
    });
    next();
});
applySecurity(app);
app.use(express.json({ limit: '1mb', strict: true }));
app.use(requireJsonBody);
app.get('/health', (_request, response) => response.json({ status: 'ok', service: 'land-acquisition-api' }));
// The explorer documents the whole attack surface, so it is off unless a
// deployment opts in, and never available in production.
if (env.ENABLE_API_DOCS === 'true' && env.NODE_ENV !== 'production') {
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
}
else {
    logger.info({ message: 'API explorer disabled', enableApiDocs: env.ENABLE_API_DOCS, nodeEnv: env.NODE_ENV });
}
app.use('/api/v1', routes);
app.use(notFoundHandler);
app.use(errorHandler);
