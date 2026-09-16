import { z } from 'zod';

/**
 * API client.
 *
 * Requests carry a Bearer token in the Authorization header and never a cookie.
 * `credentials: 'omit'` states that explicitly: a browser will not attach an
 * Authorization header to a cross-site request by itself, so the app is not
 * exposed to classic CSRF, and nothing here should quietly reintroduce ambient
 * credentials.
 *
 * The token is read from `localStorage`, which is reachable by any script that
 * achieves execution on this origin. The mitigations are the content security
 * policy injected at build, React's default escaping, and a short token
 * lifetime. SECURITY.md records this tradeoff and what replacing it requires.
 */

const apiBase = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '');

const authHeaders = (): Record<string, string> => {
  try {
    const token = localStorage.getItem('authToken');
    return token ? { authorization: `Bearer ${token}` } : {};
  } catch {
    // Storage is unavailable in a private window; the request goes unauthenticated.
    return {};
  }
};

/** One message for every failure, so a status code is not surfaced to a person. */
class ApiError extends Error {
  constructor(public readonly status: number) {
    super('The request could not be completed');
    this.name = 'ApiError';
  }
}

export async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  if (!apiBase) throw new Error('API unavailable: using synthetic demo data');
  const response = await fetch(`${apiBase}/api/v1${path}`, {
    headers: authHeaders(),
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new ApiError(response.status);
  return schema.parse(await response.json());
}

export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!apiBase) throw new Error('API unavailable: using synthetic demo data');
  const response = await fetch(`${apiBase}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders() },
    credentials: 'omit',
    redirect: 'error',
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new ApiError(response.status);
  return schema.parse(await response.json());
}
