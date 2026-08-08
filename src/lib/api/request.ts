/** Request-side helpers for /api/v1: method checks, bounded body reads, and
 *  primitive validators.
 *
 *  These exist so no route hand-rolls its own limits. The current
 *  /api/factcheck reads `await request.json()` with no size bound at all
 *  (NEWZWALE_SECURITY_AUDIT.md S-07); `readJson` below is the replacement that
 *  every v1 route uses.
 *
 *  Validators return the narrowed value or throw ApiError. Throwing rather
 *  than returning a result type keeps route bodies flat and means a missed
 *  check fails loudly instead of silently passing `undefined` downstream. */

import { ApiError } from './errors';

/** Default cap for a JSON request body. Generous for a claim or a URL, small
 *  enough that parsing cannot be used as a memory-exhaustion vector. */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** 405 unless the method matches. The Allow header is required by RFC 9110 on
 *  a 405 response and is what lets a client discover the right verb. */
export function assertMethod(request: Request, ...allowed: string[]): void {
  const method = request.method.toUpperCase();
  const permitted = allowed.map((m) => m.toUpperCase());

  // HEAD is served by the GET handler in every runtime we target, so a route
  // that allows GET implicitly allows HEAD.
  if (permitted.includes('GET')) permitted.push('HEAD');

  if (!permitted.includes(method)) {
    throw new ApiError('METHOD_NOT_ALLOWED', `${request.method} is not supported on this endpoint.`, {
      allow: permitted.join(', '),
    });
  }
}

/** Reads and parses a JSON body, refusing anything over `maxBytes`.
 *
 *  content-length is checked first because it lets us reject before reading a
 *  byte. It is only a hint though - it can be absent (chunked encoding) or
 *  simply wrong - so the decoded text is measured again afterwards. Checking
 *  only the header would leave the bound trivially bypassable. */
export async function readJson(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', `Request body must be under ${maxBytes} bytes.`);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new ApiError('BAD_REQUEST', 'Could not read the request body.');
  }

  // byteLength, not .length: a Devanagari or Tamil claim is multi-byte per
  // character, and the limit is expressed in bytes.
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', `Request body must be under ${maxBytes} bytes.`);
  }

  if (raw.trim() === '') {
    throw new ApiError('INVALID_JSON', 'Request body is empty; expected JSON.');
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // The parser's own message can quote body content back at the caller.
    throw new ApiError('INVALID_JSON', 'Request body is not valid JSON.');
  }
}

export interface StringFieldOptions {
  min?: number;
  max?: number;
  /** When false, a missing/empty value returns '' instead of throwing. */
  required?: boolean;
}

/** Reads a trimmed string field off an already-parsed body. */
export function requireString(
  body: unknown,
  field: string,
  { min = 1, max = Number.MAX_SAFE_INTEGER, required = true }: StringFieldOptions = {},
): string {
  const source = (body ?? {}) as Record<string, unknown>;
  const value = source[field];

  if (value === undefined || value === null || value === '') {
    if (!required) return '';
    throw new ApiError('BAD_REQUEST', `Missing required field "${field}".`);
  }
  if (typeof value !== 'string') {
    throw new ApiError('BAD_REQUEST', `Field "${field}" must be a string.`);
  }

  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new ApiError('INVALID_INPUT', `Field "${field}" must be at least ${min} characters.`);
  }
  if (trimmed.length > max) {
    throw new ApiError('INVALID_INPUT', `Field "${field}" must be at most ${max} characters.`);
  }
  return trimmed;
}

/** Narrows a query-string value to a member of an allowlist.
 *
 *  Returns `fallback` for anything unrecognised rather than throwing, matching
 *  the existing behaviour of isValidCategory/isValidLanguage in
 *  src/lib/news/*: a bad `?category=` should serve the default feed, not a
 *  400. The allowlist remains the security boundary either way - an
 *  unrecognised value never reaches an upstream API. */
export function enumParam<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Bounded positive integer query param, e.g. ?limit=20. */
export function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** Opaque pagination cursor. Bounded so it cannot be used to stuff an
 *  unbounded string into a cache key - the same reasoning as the existing
 *  `page` handling in src/pages/api/news.ts. */
export function cursorParam(value: string | null, maxLength = 256): string | undefined {
  if (!value) return undefined;
  return value.slice(0, maxLength);
}
