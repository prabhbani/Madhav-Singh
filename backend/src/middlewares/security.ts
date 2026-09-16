/**
 * Transport and edge security.
 *
 * Covers the controls that apply before a request reaches a route: response
 * headers, cross-origin policy, request size, and rate limiting.
 *
 * The API authenticates with a Bearer token in the Authorization header and
 * never with a cookie. That is a deliberate choice: a browser does not attach an
 * Authorization header to a cross-site request on its own, so classic CSRF does
 * not apply. If cookie authentication is ever introduced, `SameSite=Strict`,
 * `HttpOnly`, `Secure`, and an anti-CSRF token all become mandatory.
 */

import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { type Options } from 'express-rate-limit';
import type { Express, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { parseAllowedOrigins } from '../config/cors.js';

const shared: Partial<Options> = {
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // The limiter keys on `request.ip`, which honours the configured TRUST_PROXY
  // setting, so a spoofed forwarded header cannot reset someone else's bucket.
  handler: (_request, _response, next) => {
    next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please retry later.'));
  },
};

/** Baseline limit for ordinary reads and writes. */
export const generalLimiter = rateLimit({ ...shared, windowMs: 60_000, limit: env.RATE_LIMIT_GENERAL });

/**
 * Authentication. Deliberately strict: credential stuffing is a volume attack,
 * and a legitimate person does not need many attempts per quarter hour.
 */
export const authLimiter = rateLimit({
  ...shared,
  windowMs: 15 * 60_000,
  limit: env.RATE_LIMIT_AUTH,
  skipSuccessfulRequests: true,
});

/**
 * Endpoints that run detectors, engines, or bulk extraction. These cost far more
 * than a read, so they get their own much smaller bucket.
 */
export const expensiveLimiter = rateLimit({ ...shared, windowMs: 60_000, limit: env.RATE_LIMIT_EXPENSIVE });

/** Bulk export is rarer still, and is the most useful endpoint to an exfiltrator. */
export const exportLimiter = rateLimit({ ...shared, windowMs: 60 * 60_000, limit: env.RATE_LIMIT_EXPORT });

export const applySecurity = (app: Express): void => {
  app.disable('x-powered-by');

  app.use(
    helmet({
      // This is a JSON API. It serves no markup and no scripts, so the strictest
      // possible policy is also the correct one.
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          objectSrc: ["'none'"],
          sandbox: [],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      // Six months, subdomains included. Only meaningful over https, which the
      // deployment terminates upstream.
      strictTransportSecurity: { maxAge: 15_552_000, includeSubDomains: true },
      xFrameOptions: { action: 'deny' },
      xContentTypeOptions: true,
      xDnsPrefetchControl: { allow: false },
    }),
  );

  app.use(
    cors({
      origin: parseAllowedOrigins(env.CORS_ORIGIN),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );

  app.use(generalLimiter);
};

/**
 * Rejects a body whose content type is not JSON, so a form post cannot be used
 * to reach a JSON endpoint from a cross-site context.
 */
export const requireJsonBody: RequestHandler = (request, _response, next) => {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'DELETE' || method === 'OPTIONS') return next();
  if (!request.get('content-length') && !request.get('transfer-encoding')) return next();
  if (request.is('application/json')) return next();
  next(new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests with a body must use application/json'));
};
