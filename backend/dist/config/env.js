import 'dotenv/config';
import { z } from 'zod';
const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    JWT_SECRET: z.string().min(32),
    JWT_EXPIRES_IN: z.string().default('15m'),
    CORS_ORIGIN: z.string().default('http://localhost:3000'),
    ML_SERVICE_URL: z.string().url().optional().or(z.literal('')),
    ML_SERVICE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    /**
     * Express trust-proxy setting. It decides whether `x-forwarded-for` is
     * believed, which in turn decides whether the audited IP is trustworthy.
     * Defaults to `loopback`: nothing upstream is trusted until it is configured.
     */
    TRUST_PROXY: z.string().default('loopback'),
    /** Requests per minute for ordinary routes, per address. */
    RATE_LIMIT_GENERAL: z.coerce.number().int().positive().default(120),
    /** Login attempts per fifteen minutes, per address. Successes do not count. */
    RATE_LIMIT_AUTH: z.coerce.number().int().positive().default(10),
    /** Engine, detector, and generation calls per minute, per address. */
    RATE_LIMIT_EXPENSIVE: z.coerce.number().int().positive().default(10),
    /** Bulk exports per hour, per address. */
    RATE_LIMIT_EXPORT: z.coerce.number().int().positive().default(5),
    /** Consecutive failed logins before an account is locked. */
    LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    /** Minutes an account stays locked after reaching the failure limit. */
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
    /** Serve the OpenAPI explorer. Off in production unless deliberately enabled. */
    ENABLE_API_DOCS: z.enum(['true', 'false']).default('false'),
    JWT_ISSUER: z.string().default('land-acquisition-api'),
    JWT_AUDIENCE: z.string().default('land-acquisition-clients'),
});
export const env = schema.parse(process.env);
