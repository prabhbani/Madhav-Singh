/**
 * Cross-origin allow-list parsing.
 *
 * Kept free of environment and framework imports so the rules can be tested on
 * their own. A misconfiguration here fails at boot rather than at runtime,
 * because a permissive CORS policy is silent until someone exploits it.
 */
export const parseAllowedOrigins = (raw) => {
    const origins = raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
    if (origins.length === 0)
        throw new Error('CORS_ORIGIN must list at least one origin');
    // A wildcard with credentials is rejected by browsers anyway, and configuring
    // it signals an intent this API should never satisfy.
    if (origins.includes('*')) {
        throw new Error('CORS_ORIGIN must not be "*": this API sends credentials and requires an explicit allow-list');
    }
    for (const origin of origins) {
        let parsed;
        try {
            parsed = new URL(origin);
        }
        catch {
            throw new Error(`CORS_ORIGIN contains an invalid origin: ${origin}`);
        }
        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
        if (parsed.protocol !== 'https:' && !isLocal) {
            throw new Error(`CORS_ORIGIN must use https outside local development: ${origin}`);
        }
        if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error(`CORS_ORIGIN must be a bare origin without a path: ${origin}`);
        }
    }
    return origins;
};
