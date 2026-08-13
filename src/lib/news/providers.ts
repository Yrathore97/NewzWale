/** Provider abstraction for news ingestion.
 *
 *  WHY: today `/api/news` hardcodes the chain NewsData -> Guardian -> RSS
 *  inline in the route handler, which makes NewsData structurally privileged
 *  and the whole feed hostage to one paid vendor. The approved architecture
 *  makes RSS a first-class ingestion layer and paid APIs optional enrichment.
 *
 *  This module is the seam that makes that possible. It deliberately does NOT
 *  change behaviour: the existing fetchers in newsdata.ts, guardian.ts and
 *  rss.ts are wrapped verbatim, and `resolveChain` reproduces the current
 *  order and fallback semantics exactly. Reordering providers, or promoting
 *  RSS, is a later phase and a separate decision - one that must be taken
 *  against measured provider coverage, not assumed.
 *
 *  Providers are pure with respect to the Worker: keys are passed in rather
 *  than imported, matching the existing convention in search.ts and cache.ts. */

import type { NewsPage } from './types';
import { fetchNewsData } from './newsdata';
import { fetchGuardianFallback } from './guardian';
import { fetchRssFallback } from './rss';

export interface ProviderRequest {
  /** Site category slug (not an upstream category name). */
  category?: string;
  language?: string;
  /** Opaque upstream pagination token. */
  page?: string;
}

/** Credentials a provider may need. Absent key = provider not configured. */
export interface ProviderKeys {
  newsdata?: string;
  guardian?: string;
}

export interface NewsProvider {
  readonly id: string;
  /** Can serve pages beyond the first. A provider that cannot must never be
   *  asked for one - paging into an unpaginated source returns the same
   *  articles forever. */
  readonly paginated: boolean;
  /** Whether the provider honours the `language` request. English-only
   *  providers must not be used to answer a Hindi request, or the reader
   *  silently gets the wrong language. */
  readonly multilingual: boolean;
  /** False when a required key is missing, so the chain can skip it without
   *  paying a failed request. */
  isConfigured(keys: ProviderKeys): boolean;
  fetchPage(req: ProviderRequest, keys: ProviderKeys): Promise<NewsPage>;
}

export const newsDataProvider: NewsProvider = {
  id: 'newsdata',
  paginated: true,
  multilingual: true,
  isConfigured: (keys) => Boolean(keys.newsdata),
  async fetchPage(req, keys) {
    const fresh = await fetchNewsData(keys.newsdata ?? '', {
      category: req.category,
      language: req.language,
      page: req.page,
    });
    // An empty result is treated as a failure so the chain falls through,
    // preserving the existing `if (fresh.articles.length > 0) ... throw`
    // behaviour in /api/news.
    if (fresh.articles.length === 0) throw new Error('newsdata: empty');
    return fresh;
  },
};

export const guardianProvider: NewsProvider = {
  id: 'guardian',
  paginated: false,
  multilingual: false,
  isConfigured: (keys) => Boolean(keys.guardian),
  async fetchPage(req, keys) {
    const articles = await fetchGuardianFallback(keys.guardian ?? '', req.category);
    if (articles.length === 0) throw new Error('guardian: empty');
    return { articles, nextPage: null };
  },
};

export const rssProvider: NewsProvider = {
  id: 'rss',
  paginated: false,
  multilingual: false,
  // No key required. This is why RSS is the floor of the chain and why it can
  // become the foundation later: it is the only provider that cannot be
  // switched off by a billing event.
  isConfigured: () => true,
  async fetchPage() {
    const articles = await fetchRssFallback();
    if (articles.length === 0) throw new Error('rss: empty');
    return { articles, nextPage: null };
  },
};

/** Registration order = current fallback order. Preserved verbatim from
 *  /api/news so this refactor is provably behaviour-neutral. */
export const PROVIDERS: NewsProvider[] = [newsDataProvider, guardianProvider, rssProvider];

/** The providers eligible to answer one request, in order.
 *
 *  Two filters, both carried over from the existing route:
 *  - a paginated request may only be served by a paginated provider
 *  - a non-default language may only be served by a multilingual provider
 *
 *  The second is stricter than today's code, which would have let an
 *  English-only fallback answer a Hindi request. That was latent rather than
 *  live (the fallbacks only run when NewsData is down), and serving English
 *  headlines to a Hindi reader is a worse outcome than serving none. */
export function resolveChain(
  req: ProviderRequest,
  keys: ProviderKeys,
  defaultLanguage = 'en',
  providers: NewsProvider[] = PROVIDERS,
): NewsProvider[] {
  const wantsPage = Boolean(req.page);
  const wantsOtherLanguage = Boolean(req.language && req.language !== defaultLanguage);

  return providers.filter((p) => {
    if (!p.isConfigured(keys)) return false;
    if (wantsPage && !p.paginated) return false;
    if (wantsOtherLanguage && !p.multilingual) return false;
    return true;
  });
}

export interface ChainResult extends NewsPage {
  /** Which provider actually answered. Recorded so a degraded feed is
   *  observable rather than silent. */
  providerId: string;
}

/** Runs the chain until one provider succeeds.
 *
 *  Throws only if every eligible provider failed, which lets the caller's
 *  `cached()` wrapper serve its stale copy instead of caching an empty feed
 *  for the full TTL. That behaviour is load-bearing and is preserved. */
export async function fetchFromChain(
  req: ProviderRequest,
  keys: ProviderKeys,
  defaultLanguage = 'en',
  providers: NewsProvider[] = PROVIDERS,
): Promise<ChainResult> {
  const chain = resolveChain(req, keys, defaultLanguage, providers);
  const failures: string[] = [];

  for (const provider of chain) {
    try {
      const page = await provider.fetchPage(req, keys);
      return { ...page, providerId: provider.id };
    } catch (err) {
      // One provider failing is expected and contained; it must not break the
      // feed. Logged because a silent fallback is indistinguishable from a
      // healthy primary.
      failures.push(`${provider.id}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  throw new Error(
    chain.length === 0
      ? 'No news provider is eligible for this request.'
      : `All news providers failed (${failures.join('; ')}).`,
  );
}
