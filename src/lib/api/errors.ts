/** The complete set of error codes /api/v1 may return.
 *
 *  Codes are part of the public API contract: a client (web, PWA, or a future
 *  native app) branches on `code`, never on `message`. Messages are for
 *  humans and may be reworded at any time; codes may not.
 *
 *  Each code maps to exactly one HTTP status so a route never has to pass
 *  both and risk them disagreeing. */
export const API_ERROR_STATUS = {
  /** Malformed body, wrong types, failed validation. */
  BAD_REQUEST: 400,
  /** Body was not valid JSON. Distinct from BAD_REQUEST so clients can tell a
   *  transport/serialisation bug from a validation failure. */
  INVALID_JSON: 400,
  /** Input was well-formed but outside an allowed bound (too short, too long). */
  INVALID_INPUT: 422,
  /** Route exists, HTTP method does not. Response carries an `Allow` header. */
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  /** Request body exceeded the route's declared limit. */
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  /** Unexpected server-side failure. Never carries internal detail. */
  INTERNAL: 500,
  /** A dependency (upstream API, model binding) is unavailable. Distinct from
   *  INTERNAL because it is transient and the client should retry. */
  UPSTREAM_UNAVAILABLE: 503,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

const CODES = Object.keys(API_ERROR_STATUS) as ApiErrorCode[];

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (CODES as string[]).includes(value);
}

/** Thrown inside a route handler and converted to an error envelope by
 *  `handle()`. Lets validation helpers deep in a call stack fail with a
 *  correct status without every caller re-checking a return value. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** Extra response headers, e.g. `Allow` on a 405 or `Retry-After` on a 429. */
  readonly headers: Record<string, string>;

  constructor(code: ApiErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.headers = headers;
  }

  get status(): number {
    return API_ERROR_STATUS[this.code];
  }
}
