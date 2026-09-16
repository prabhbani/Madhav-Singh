/**
 * Token issuing and verification.
 *
 * This module establishes who the caller is. It never decides what they may do;
 * role, permission, and scope gates live in `authorize.ts`.
 *
 * Verification pins the algorithm, issuer, and audience. Without an algorithm
 * pin a library will verify whatever the token's own header asks for, which is
 * how algorithm-confusion attacks work: the attacker picks the algorithm, not
 * the server.
 */

import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import type { Role } from '@prisma/client';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

type TokenPayload = {
  sub: string;
  email: string;
  role: Role;
  districtCode?: string;
  stateCode?: string;
  department?: string;
};

const ALGORITHM: jwt.Algorithm = 'HS256';

export const signToken = (payload: TokenPayload): string =>
  jwt.sign(payload, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    // A unique id per token, so a future denylist has something to key on.
    jwtid: randomBytes(16).toString('hex'),
  });

export const authenticate: RequestHandler = (request, _response, next) => {
  const header = request.header('authorization');
  const token = header && /^Bearer\s+\S+$/i.test(header) ? header.replace(/^Bearer\s+/i, '') : undefined;
  if (!token) return next(new AppError(401, 'UNAUTHENTICATED', 'Bearer token is required'));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [ALGORITHM],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      clockTolerance: 5,
    }) as TokenPayload;

    // A token missing its identity claims is malformed, whatever its signature.
    if (!payload?.sub || !payload.email || !payload.role) {
      return next(new AppError(401, 'INVALID_TOKEN', 'Token is invalid or expired'));
    }

    request.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      districtCode: payload.districtCode,
      stateCode: payload.stateCode,
      department: payload.department,
    };
    next();
  } catch {
    // One message for every failure mode. Distinguishing "expired" from
    // "malformed" from "wrong signature" only helps someone probing the API.
    next(new AppError(401, 'INVALID_TOKEN', 'Token is invalid or expired'));
  }
};

// Role and permission gates live in `middlewares/authorize.ts`. This module only
// establishes who the caller is; it never decides what they may do.
