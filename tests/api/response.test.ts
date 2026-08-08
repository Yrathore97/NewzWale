import { describe, it, expect, vi, afterEach } from 'vitest';
import { ok, fail, handle } from '../../src/lib/api/response';
import { ApiError, API_ERROR_STATUS, isApiErrorCode } from '../../src/lib/api/errors';

async function body(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

describe('ok — success envelope', () => {
  it('wraps the payload under data', async () => {
    const res = ok({ articles: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await body(res)).toEqual({ data: { articles: [] } });
  });

  it('omits meta entirely when none is supplied', async () => {
    expect(await body(ok('x'))).not.toHaveProperty('meta');
  });

  // A serialised "cursor": null reads as "there is a cursor and it is empty".
  // Absence is what actually means "no further page", so the key must not
  // appear at all.
  it('drops undefined meta fields rather than serialising null', async () => {
    const parsed = await body(ok([1], { cursor: undefined, cached: true }));
    expect(parsed.meta).toEqual({ cached: true });
    expect('cursor' in parsed.meta).toBe(false);
  });

  it('omits meta when every field was undefined', async () => {
    expect(await body(ok([1], { cursor: undefined }))).not.toHaveProperty('meta');
  });

  it('keeps false and 0, which are meaningful values not absences', async () => {
    const parsed = await body(ok([], { cached: false, total: 0 }));
    expect(parsed.meta).toEqual({ cached: false, total: 0 });
  });

  it('never emits an error key alongside data', async () => {
    expect(await body(ok({ ok: true }))).not.toHaveProperty('error');
  });
});

describe('fail — error envelope', () => {
  it('wraps code and message under error', async () => {
    const res = fail('NOT_FOUND', 'No such fact check.');
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({
      error: { code: 'NOT_FOUND', message: 'No such fact check.' },
    });
  });

  it('never emits a data key alongside error', async () => {
    expect(await body(fail('INTERNAL', 'boom'))).not.toHaveProperty('data');
  });

  it('derives status from the code so the two cannot disagree', () => {
    expect(fail('RATE_LIMITED', 'slow down').status).toBe(429);
    expect(fail('PAYLOAD_TOO_LARGE', 'too big').status).toBe(413);
    expect(fail('INVALID_INPUT', 'bad').status).toBe(422);
    expect(fail('UPSTREAM_UNAVAILABLE', 'down').status).toBe(503);
  });

  it('passes extra headers through', () => {
    expect(fail('METHOD_NOT_ALLOWED', 'nope', { allow: 'GET' }).headers.get('allow')).toBe('GET');
  });
});

describe('error codes', () => {
  it('every code maps to a valid HTTP status', () => {
    for (const [code, status] of Object.entries(API_ERROR_STATUS)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(600);
    }
  });

  it('recognises only declared codes', () => {
    expect(isApiErrorCode('RATE_LIMITED')).toBe(true);
    expect(isApiErrorCode('TEAPOT')).toBe(false);
    expect(isApiErrorCode(undefined)).toBe(false);
  });
});

describe('handle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes a successful response through untouched', async () => {
    const res = await handle(async () => ok('fine'));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ data: 'fine' });
  });

  it('converts a thrown ApiError into its envelope, headers included', async () => {
    const res = await handle(async () => {
      throw new ApiError('RATE_LIMITED', 'Too many checks.', { 'retry-after': '3600' });
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect((await body(res)).error.code).toBe('RATE_LIMITED');
  });

  // An exception message can carry an upstream URL, a query string, or an API
  // key. It must reach the log and never the client.
  it('does not leak an unexpected error message to the client', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handle(async () => {
      throw new Error('https://newsdata.io/api/1/latest?apikey=SECRET123');
    });

    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('SECRET123');
    expect(text).not.toContain('newsdata.io');
    expect(JSON.parse(text).error.code).toBe('INTERNAL');
    expect(spy).toHaveBeenCalled();
  });

  it('handles a non-Error throw without itself throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handle(async () => {
      throw 'a bare string';
    });
    expect(res.status).toBe(500);
  });
});
