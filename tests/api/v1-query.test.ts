/** Shared /api/v1 query validation.
 *
 *  Tested at the helper rather than through each route, because the point of
 *  the helper is that every route validates IDENTICALLY — asserting it once
 *  per route would let a route quietly stop using it and still pass. */

import { describe, it, expect } from 'vitest';
import {
  limitParam,
  cursorFrom,
  feedFilters,
  optionalFilters,
  requireQuery,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_QUERY_CHARS,
} from '../../src/lib/api/query';
import { ApiError } from '../../src/lib/api/errors';
import { encodeCursor } from '../../src/lib/db/client';

const u = (qs: string) => new URL(`https://newzwale.com/api/v1/news${qs}`);

describe('limitParam', () => {
  it('defaults when absent', () => {
    expect(limitParam(u(''))).toBe(DEFAULT_LIMIT);
  });

  it('accepts a valid limit', () => {
    expect(limitParam(u('?limit=5'))).toBe(5);
  });

  // Bounded rather than rejected: an oversized limit is a client mistake, not
  // an attack worth a 4xx, but it must never become an unbounded scan.
  it('caps at MAX_LIMIT', () => {
    expect(limitParam(u('?limit=100000'))).toBe(MAX_LIMIT);
    expect(limitParam(u('?limit=101'))).toBe(MAX_LIMIT);
  });

  it('floors at 1', () => {
    expect(limitParam(u('?limit=0'))).toBe(1);
    expect(limitParam(u('?limit=-20'))).toBe(1);
  });

  it('falls back for non-integers', () => {
    for (const bad of ['abc', '1.5', '', 'NaN', 'Infinity', '1e9999']) {
      expect(limitParam(u(`?limit=${bad}`))).toBeLessThanOrEqual(MAX_LIMIT);
      expect(limitParam(u(`?limit=${bad}`))).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('cursorFrom', () => {
  it('returns null when absent', () => {
    expect(cursorFrom(u(''))).toBeNull();
  });

  it('round-trips a valid cursor', () => {
    const c = { sortValue: '2026-08-08T00:00:00Z', id: 'abc123' };
    expect(cursorFrom(u(`?cursor=${encodeURIComponent(encodeCursor(c))}`))).toEqual(c);
  });

  /** A malformed cursor must be an explicit error.
   *
   *  Silently restarting from page 1 would leave a paging client looping over
   *  the first page forever with no signal that anything went wrong. */
  it('rejects a malformed cursor with BAD_REQUEST', () => {
    for (const bad of ['not-base64!!', 'Zm9v', '%%%', 'a']) {
      expect(() => cursorFrom(u(`?cursor=${encodeURIComponent(bad)}`))).toThrow(ApiError);
    }
  });

  it('rejects rather than exposing why', () => {
    try {
      cursorFrom(u('?cursor=garbage!!'));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('BAD_REQUEST');
      expect((err as ApiError).status).toBe(400);
      // No internals in the message.
      expect((err as ApiError).message).not.toMatch(/base64|atob|sql|sqlite/i);
    }
  });

  // Tampering shifts position in a public feed and nothing more: both fields
  // are only ever bound as SQL parameters.
  it('treats a tampered cursor as data, not as syntax', () => {
    const forged = encodeCursor({ sortValue: "' OR 1=1 --", id: "'; DROP TABLE articles;--" });
    const parsed = cursorFrom(u(`?cursor=${encodeURIComponent(forged)}`));
    expect(parsed).toEqual({ sortValue: "' OR 1=1 --", id: "'; DROP TABLE articles;--" });
  });
});

describe('feedFilters', () => {
  it('accepts allowlisted values', () => {
    expect(feedFilters(u('?category=sports&language=hi'))).toEqual({
      category: 'sports',
      language: 'hi',
    });
  });

  // Matches /api/news: a stale bookmark serves the default feed rather than 400.
  it('falls back to defaults for unknown values', () => {
    const out = feedFilters(u('?category=../../etc/passwd&language=zz'));
    expect(out.category).toBe('top');
    expect(out.language).toBe('en');
  });

  it('never passes an unallowlisted value through', () => {
    for (const bad of ["'; DROP TABLE articles;--", '../../x', '%00', 'top OR 1=1']) {
      const out = feedFilters(u(`?category=${encodeURIComponent(bad)}`));
      expect(out.category).toBe('top');
    }
  });
});

describe('optionalFilters', () => {
  // Search spans everything unless narrowed on purpose; defaulting to `top`
  // would report "no results" for stories that exist.
  it('is undefined rather than defaulted when absent', () => {
    expect(optionalFilters(u(''))).toEqual({ category: undefined, language: undefined });
  });

  it('drops unrecognised values instead of defaulting them', () => {
    expect(optionalFilters(u('?category=nonsense')).category).toBeUndefined();
  });

  it('keeps allowlisted values', () => {
    expect(optionalFilters(u('?category=sports&language=ta'))).toEqual({
      category: 'sports',
      language: 'ta',
    });
  });
});

describe('requireQuery', () => {
  it('returns a trimmed query', () => {
    expect(requireQuery(u('?q=%20monsoon%20'))).toBe('monsoon');
  });

  it('rejects an absent or blank query', () => {
    for (const qs of ['', '?q=', '?q=%20%20']) {
      expect(() => requireQuery(u(qs))).toThrow(ApiError);
    }
  });

  // Bounded before FTS5 sees it: every word becomes a quoted phrase, so an
  // unbounded query is an unbounded MATCH expression.
  it('rejects an over-long query with INVALID_INPUT', () => {
    const long = 'a'.repeat(MAX_QUERY_CHARS + 1);
    try {
      requireQuery(u(`?q=${long}`));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as ApiError).code).toBe('INVALID_INPUT');
      expect((err as ApiError).status).toBe(422);
    }
  });

  it('accepts a query exactly at the limit', () => {
    expect(requireQuery(u(`?q=${'a'.repeat(MAX_QUERY_CHARS)}`))).toHaveLength(MAX_QUERY_CHARS);
  });

  it('passes FTS operators through as text for the repository to quote', () => {
    expect(requireQuery(u('?q=NEAR%20OR%20*'))).toBe('NEAR OR *');
  });
});
