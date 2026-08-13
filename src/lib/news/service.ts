/** The shared server-side read path for news.
 *
 *  ARCHITECTURAL PURPOSE
 *
 *  Today four SSR components each call `fetch(new URL('/api/news', Astro.url))`
 *  - the Worker issuing full HTTP requests to itself. One homepage render
 *  costs seven such self-subrequests (index lead, HeroMesh ticker, four
 *  CategoryRails, NewsFeed grid), each a real round trip, all counting against
 *  the per-request subrequest limit. See NEWZWALE_AUDIT.md section 4.1.
 *
 *  The fix is this module: one function that pages AND API routes both call.
 *
 *      page  ─┐
 *              ├─► getNewsPage() ─► cache (KV) ─► provider chain ─► upstream
 *      /api ─┘                                    (later: D1)
 *
 *  MIGRATION STATE - PHASE 0
 *
 *  Only `/api/news` has been switched over. The page components still self-
 *  fetch and are deliberately untouched: moving them changes what renders and
 *  belongs in a phase with UI verification, not in a foundations commit. The
 *  structure is now in place for that to be a small mechanical change.
 *
 *  Behaviour is unchanged from the route this was lifted from: same cache key,
 *  same TTL, same fallback order, same stale-on-error semantics. */

import { cached, newsCacheKey } from '../cache';
import { DEFAULT_CATEGORY, isValidCategory } from './categories';
import { DEFAULT_LANGUAGE, isValidLanguage } from './languages';
import { fetchFromChain, type ProviderKeys } from './providers';
import type { NewsPage } from './types';

/** How long a feed page stays fresh in KV. */
export const NEWS_TTL_SECONDS = 20 * 60;

/** Upstream pagination tokens are opaque and pass through untouched, but are
 *  bounded so they cannot stuff an unbounded string into a cache key. */
const MAX_PAGE_TOKEN = 200;

export interface NewsQuery {
  category?: string | null;
  language?: string | null;
  page?: string | null;
}

/** A query narrowed to values the rest of the system is allowed to see.
 *  The allowlists are the security boundary for user-supplied input: an
 *  unrecognised value becomes the default and never reaches an upstream API. */
export interface ResolvedNewsQuery {
  category: string;
  language: string;
  page?: string;
}

export function resolveNewsQuery(query: NewsQuery): ResolvedNewsQuery {
  const category = isValidCategory(query.category) ? query.category : DEFAULT_CATEGORY;
  const language = isValidLanguage(query.language) ? query.language : DEFAULT_LANGUAGE;
  const page = query.page?.slice(0, MAX_PAGE_TOKEN) || undefined;
  return { category, language, page };
}

export interface NewsResult extends NewsPage {
  /** True when KV answered without contacting any provider. Surfaced through
   *  the v1 envelope's `meta.cached`. */
  cached: boolean;
  /** Which provider produced the data, or null on a cache hit (the original
   *  provider is not recorded in the cached value). Null also when every
   *  provider failed and nothing stale was available. */
  providerId: string | null;
}

/** Reads one page of the feed, preferring cache, falling back through the
 *  provider chain, and finally serving a stale copy rather than an empty feed.
 *
 *  Returns an empty page rather than throwing: callers render an honest empty
 *  state. Whether the HTTP layer should turn that into a non-200 is a separate
 *  question, tracked as NEWZWALE_AUDIT.md P-16, and deliberately not changed
 *  here - it would alter current API behaviour. */
export async function getNewsPage(
  kv: KVNamespace,
  query: NewsQuery,
  keys: ProviderKeys,
): Promise<NewsResult> {
  const { category, language, page } = resolveNewsQuery(query);
  const key = newsCacheKey(category, language, page);

  let providerId: string | null = null;
  let servedFromCache = true;

  const result = await cached<NewsPage>(kv, key, NEWS_TTL_SECONDS, async () => {
    // Reaching the producer means it was a cache miss.
    servedFromCache = false;
    const chain = await fetchFromChain({ category, language, page }, keys, DEFAULT_LANGUAGE);
    providerId = chain.providerId;
    return { articles: chain.articles, nextPage: chain.nextPage };
  });

  return {
    articles: result?.articles ?? [],
    nextPage: result?.nextPage ?? null,
    cached: servedFromCache,
    providerId,
  };
}
