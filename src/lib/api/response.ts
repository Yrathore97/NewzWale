/** The /api/v1 response envelope.
 *
 *  Every v1 route answers in exactly one of two shapes, so a client can branch
 *  on the presence of `error` without knowing which endpoint it called:
 *
 *    success  { "data": <payload>, "meta"?: { ... } }
 *    failure  { "error": { "code": "...", "message": "..." } }
 *
 *  `data` and `error` are mutually exclusive by construction - there is no
 *  builder here that can emit both.
 *
 *  The legacy endpoints (/api/news, /api/factcheck, /api/ticker) deliberately
 *  keep their existing un-enveloped shapes. Changing them would break the
 *  current UI, and the whole point of versioning under /v1 is that the
 *  migration can be gradual. */

import { API_ERROR_STATUS, ApiError, type ApiErrorCode } from './errors';

export interface ApiMeta {
  /** Opaque pagination token. Absent (not null) when there is no further page,
   *  so `'cursor' in meta` is a reliable "has more" check. */
  cursor?: string;
  /** True when the payload was served from cache rather than recomputed. */
  cached?: boolean;
  /** Total matching records, where the query can know it cheaply. Omitted
   *  rather than guessed - a wrong total is worse than an absent one. */
  total?: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

export type ApiResponseBody<T> = ApiSuccess<T> | ApiFailure;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

/** Drops undefined entries so the envelope never serialises `"cursor": null`
 *  when what we mean is "this key does not apply". */
function compactMeta(meta?: ApiMeta): ApiMeta | undefined {
  if (!meta) return undefined;
  const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as ApiMeta) : undefined;
}

export function ok<T>(data: T, meta?: ApiMeta, init: ResponseInit = {}): Response {
  const body: ApiSuccess<T> = { data };
  const compact = compactMeta(meta);
  if (compact) body.meta = compact;

  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, ...init.headers },
  });
}

export function fail(
  code: ApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  const body: ApiFailure = { error: { code, message } };

  return new Response(JSON.stringify(body), {
    status: API_ERROR_STATUS[code],
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** Wraps a route handler so a thrown ApiError becomes a correct error envelope
 *  and anything else becomes a generic 500.
 *
 *  Unknown errors are logged but NEVER echoed to the client: an exception
 *  message can carry an upstream URL, a query string, or a key. The client
 *  gets a fixed string; the detail goes to the Worker log. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.headers);
    }
    console.error('Unhandled API error:', err);
    return fail('INTERNAL', 'Something went wrong handling that request.');
  }
}
