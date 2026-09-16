/**
 * Audit payload redaction.
 *
 * Kept free of database and framework imports so it can be reasoned about, and
 * tested, on its own. Nothing that passes through here should ever be able to
 * carry a credential into the audit table.
 */

/** Keys whose values never reach an audit row, at any nesting depth. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'newpassword',
  'currentpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'secret',
  'apikey',
  'api_key',
  'jwt',
  'otp',
  'sessionid',
]);

/** Serialized payloads are capped so one large body cannot bloat the table. */
export const MAX_PAYLOAD_BYTES = 16_384;
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 100;

type DecimalLike = { toNumber: () => number };

const isDecimalLike = (value: object): value is DecimalLike =>
  'toNumber' in value && typeof (value as DecimalLike).toNumber === 'function';

const redactValue = (value: unknown, depth: number): unknown => {
  if (value === null || value === undefined) return null;
  if (depth >= MAX_DEPTH) return '[truncated: max depth]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => redactValue(entry, depth + 1));
  if (typeof value === 'object') {
    if (isDecimalLike(value)) return value.toNumber();
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[redacted]' : redactValue(nested, depth + 1);
    }
    return output;
  }
  return value;
};

/** Redacts secrets and caps the payload size. Returns undefined for no value. */
export const redact = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  const cleaned = redactValue(value, 0);
  const serialized = JSON.stringify(cleaned);
  if (serialized !== undefined && serialized.length > MAX_PAYLOAD_BYTES) {
    return { truncated: true, bytes: serialized.length, preview: serialized.slice(0, 1_000) };
  }
  return cleaned;
};

/** Normalizes an address for the audit column, dropping the IPv4-mapped prefix. */
export const normalizeIp = (address: string | null | undefined): string | null =>
  address ? address.replace(/^::ffff:/, '').slice(0, 45) : null;
