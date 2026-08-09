/** Shared query-parameter validation for /api/v1 read routes.
 *
 *  One implementation, several routes. Validation duplicated per route is
 *  validation that drifts: the news endpoint caps `limit` at 100, the search
 *  endpoint forgets to, and the looser one becomes the way to pull the table.
 *
 *  Builds on ./request.ts rather than replacing it — `intParam`, `enumParam`
 *  and `cursorParam` already exist and are already tested. */

import { ApiError } from './errors';
import { cursorParam, intParam } from './request';
import { decodeCursor, type Cursor } from '../db/client';
import { DEFAULT_CATEGORY, isValidCategory } from '../news/categories';
import { DEFAULT_LANGUAGE, isValidLanguage } from '../news/languages';

/** Hard ceiling on rows any v1 route will return, whatever the caller asks. */
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 24;

export function limitParam(url: URL): number {
  return intParam(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
}

/** Decodes `?cursor=`, rejecting anything that is not one of ours.
 *
 *  A malformed cursor is a CLIENT error, not something to silently ignore:
 *  quietly restarting from page 1 would make a paging client loop forever over
 *  the first page with no signal that anything was wrong.
 *
 *  Tampering is handled by construction rather than by a signature. The two
 *  decoded fields are only ever bound as SQL parameters, so a forged cursor
 *  can shift the reader's position in a public feed and nothing else — there
 *  is no data behind it to escalate to. Signing would add key management for
 *  no confidentiality gain over a public list. */
export function cursorFrom(url: URL): Cursor | null {
  const raw = cursorParam(url.searchParams.get('cursor'));
  if (!raw) return null;

  const cursor = decodeCursor(raw);
  if (!cursor) {
    throw new ApiError('BAD_REQUEST', 'The cursor parameter is not a valid pagination cursor.');
  }
  return cursor;
}

/** Category and language, narrowed to the allowlists.
 *
 *  Unrecognised values fall back to the default rather than 400 — matching the
 *  existing behaviour of /api/news and of resolveNewsQuery, so a stale
 *  bookmark keeps working. The allowlist remains the security boundary either
 *  way: an unrecognised value never reaches a query. */
export function feedFilters(url: URL): { category: string; language: string } {
  const category = url.searchParams.get('category');
  const language = url.searchParams.get('language');
  return {
    category: isValidCategory(category) ? category : DEFAULT_CATEGORY,
    language: isValidLanguage(language) ? language : DEFAULT_LANGUAGE,
  };
}

/** Optional filters: absent means "no filter", not "the default".
 *
 *  Search differs from the feed here. A feed must show SOMETHING, so an
 *  unknown category falls back to the default. A search with no category
 *  should span every category rather than silently narrowing to `top` and
 *  reporting no results for a story that exists. */
export function optionalFilters(url: URL): { category?: string; language?: string } {
  const category = url.searchParams.get('category');
  const language = url.searchParams.get('language');
  return {
    category: isValidCategory(category) ? category : undefined,
    language: isValidLanguage(language) ? language : undefined,
  };
}

/** Longest accepted search query.
 *
 *  Bounded before it reaches FTS5: `ftsQuery` turns every whitespace-separated
 *  word into a quoted phrase, so an unbounded input becomes an unbounded
 *  MATCH expression and a cheap way to make the database do expensive work. */
export const MAX_QUERY_CHARS = 200;

/** The required `?q=` of /api/v1/search. */
export function requireQuery(url: URL): string {
  const raw = (url.searchParams.get('q') ?? '').trim();

  if (!raw) {
    throw new ApiError('BAD_REQUEST', 'The q parameter is required.');
  }
  if (raw.length > MAX_QUERY_CHARS) {
    throw new ApiError(
      'INVALID_INPUT',
      `The q parameter must be ${MAX_QUERY_CHARS} characters or fewer.`,
    );
  }
  return raw;
}
