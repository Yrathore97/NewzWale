import { describe, it, expect } from 'vitest';
import {
  assertMethod,
  readJson,
  requireString,
  enumParam,
  intParam,
  cursorParam,
  DEFAULT_MAX_BODY_BYTES,
} from '../../src/lib/api/request';
import { ApiError } from '../../src/lib/api/errors';

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://newzwale.com/api/v1/factcheck', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

/** Asserts fn throws an ApiError carrying the expected code. */
async function expectApiError(fn: () => unknown | Promise<unknown>, code: string) {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe(code);
    return err as ApiError;
  }
  throw new Error(`expected an ApiError with code ${code}, but nothing was thrown`);
}

describe('assertMethod', () => {
  it('allows a permitted method', () => {
    expect(() => assertMethod(new Request('https://x/', { method: 'POST' }), 'POST')).not.toThrow();
  });

  it('is case-insensitive about the declared method', () => {
    expect(() => assertMethod(new Request('https://x/'), 'get')).not.toThrow();
  });

  it('rejects a disallowed method with 405', async () => {
    const err = await expectApiError(
      () => assertMethod(new Request('https://x/', { method: 'DELETE' }), 'GET'),
      'METHOD_NOT_ALLOWED',
    );
    expect(err.status).toBe(405);
  });

  // RFC 9110 requires Allow on a 405; it is how a client discovers the verb.
  it('advertises permitted methods in the Allow header', async () => {
    const err = await expectApiError(
      () => assertMethod(new Request('https://x/', { method: 'PUT' }), 'GET', 'POST'),
      'METHOD_NOT_ALLOWED',
    );
    expect(err.headers.allow).toContain('GET');
    expect(err.headers.allow).toContain('POST');
  });

  it('treats HEAD as implied by GET', () => {
    expect(() =>
      assertMethod(new Request('https://x/', { method: 'HEAD' }), 'GET'),
    ).not.toThrow();
  });

  it('does not imply HEAD for a POST-only route', async () => {
    await expectApiError(
      () => assertMethod(new Request('https://x/', { method: 'HEAD' }), 'POST'),
      'METHOD_NOT_ALLOWED',
    );
  });
});

describe('readJson', () => {
  it('parses a well-formed body', async () => {
    expect(await readJson(post(JSON.stringify({ claim: 'hello' })))).toEqual({ claim: 'hello' });
  });

  it('rejects invalid JSON as INVALID_JSON, not BAD_REQUEST', async () => {
    await expectApiError(() => readJson(post('{oh no')), 'INVALID_JSON');
  });

  it('rejects an empty body', async () => {
    await expectApiError(() => readJson(post('   ')), 'INVALID_JSON');
  });

  // The parser's own message quotes body content back at the caller.
  it('does not echo body content in the error message', async () => {
    const err = await expectApiError(
      () => readJson(post('{"secret":"hunter2"')),
      'INVALID_JSON',
    );
    expect(err.message).not.toContain('hunter2');
  });

  it('rejects a body over the limit using content-length, before reading it', async () => {
    const err = await expectApiError(
      () => readJson(post('{}', { 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) })),
      'PAYLOAD_TOO_LARGE',
    );
    expect(err.status).toBe(413);
  });

  // content-length can be absent or simply wrong, so the header check alone
  // would be trivially bypassable. The decoded body is measured too.
  it('rejects an oversized body even when content-length lies', async () => {
    const huge = JSON.stringify({ claim: 'x'.repeat(2000) });
    await expectApiError(() => readJson(post(huge, { 'content-length': '10' }), 500), 'PAYLOAD_TOO_LARGE');
  });

  // A Devanagari claim is 3 bytes per character; a character-count limit would
  // let a Hindi body through at 3x the intended size.
  it('measures the limit in bytes, not characters', async () => {
    const devanagari = JSON.stringify({ claim: 'न'.repeat(100) }); // ~300 bytes
    expect(devanagari.length).toBeLessThan(310);
    await expectApiError(() => readJson(post(devanagari), 200), 'PAYLOAD_TOO_LARGE');
  });

  it('accepts a body exactly at the limit', async () => {
    const body = JSON.stringify({ a: 'b' });
    const size = new TextEncoder().encode(body).byteLength;
    await expect(readJson(post(body), size)).resolves.toEqual({ a: 'b' });
  });
});

describe('requireString', () => {
  it('returns the trimmed value', () => {
    expect(requireString({ claim: '  hello  ' }, 'claim')).toBe('hello');
  });

  it('rejects a missing field', async () => {
    await expectApiError(() => requireString({}, 'claim'), 'BAD_REQUEST');
  });

  it('rejects a non-string field', async () => {
    await expectApiError(() => requireString({ claim: 42 }, 'claim'), 'BAD_REQUEST');
  });

  it('rejects a value under the minimum as INVALID_INPUT', async () => {
    await expectApiError(() => requireString({ claim: 'hi' }, 'claim', { min: 10 }), 'INVALID_INPUT');
  });

  it('rejects a value over the maximum', async () => {
    await expectApiError(
      () => requireString({ claim: 'x'.repeat(50) }, 'claim', { max: 10 }),
      'INVALID_INPUT',
    );
  });

  it('measures length after trimming, so padding cannot satisfy a minimum', async () => {
    await expectApiError(
      () => requireString({ claim: '  ab  ' }, 'claim', { min: 5 }),
      'INVALID_INPUT',
    );
  });

  it('returns empty string for an optional missing field', () => {
    expect(requireString({}, 'url', { required: false })).toBe('');
  });

  it('survives a null or undefined body', async () => {
    await expectApiError(() => requireString(null, 'claim'), 'BAD_REQUEST');
    await expectApiError(() => requireString(undefined, 'claim'), 'BAD_REQUEST');
  });
});

describe('enumParam', () => {
  const CATEGORIES = ['top', 'india', 'world'] as const;

  it('accepts a declared value', () => {
    expect(enumParam('india', CATEGORIES, 'top')).toBe('india');
  });

  // Matches isValidCategory/isValidLanguage: a bad ?category= serves the
  // default feed rather than a 400. The allowlist stays the security boundary
  // either way — an unrecognised value never reaches an upstream API.
  it('falls back rather than throwing on an unknown value', () => {
    expect(enumParam('../../etc/passwd', CATEGORIES, 'top')).toBe('top');
    expect(enumParam(null, CATEGORIES, 'top')).toBe('top');
    expect(enumParam('', CATEGORIES, 'top')).toBe('top');
  });
});

describe('intParam', () => {
  it('parses and clamps', () => {
    expect(intParam('20', 10, 1, 50)).toBe(20);
    expect(intParam('999', 10, 1, 50)).toBe(50);
    expect(intParam('0', 10, 1, 50)).toBe(1);
  });

  it('falls back for absent or non-integer input', () => {
    expect(intParam(null, 10, 1, 50)).toBe(10);
    expect(intParam('abc', 10, 1, 50)).toBe(10);
    expect(intParam('1.5', 10, 1, 50)).toBe(10);
    expect(intParam('1e999', 10, 1, 50)).toBe(10);
  });
});

describe('cursorParam', () => {
  it('passes an opaque token through', () => {
    expect(cursorParam('eyJwYWdlIjoyfQ')).toBe('eyJwYWdlIjoyfQ');
  });

  it('returns undefined for absent or empty input', () => {
    expect(cursorParam(null)).toBeUndefined();
    expect(cursorParam('')).toBeUndefined();
  });

  // Bounded so an attacker cannot stuff an unbounded string into a cache key.
  it('truncates an overlong token', () => {
    expect(cursorParam('x'.repeat(5000))).toHaveLength(256);
  });
});
