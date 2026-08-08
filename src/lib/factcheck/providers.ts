/** Evidence-search provider abstraction.
 *
 *  Mirrors the NewsProvider pattern in ../news/providers.ts and exists for the
 *  same reason: `search.ts` hardcodes Tavily, which makes one vendor
 *  structurally privileged and the whole fact-check hostage to its uptime and
 *  billing.
 *
 *  Behaviour is deliberately UNCHANGED. Tavily is still the only registered
 *  provider and still the first tried; this is the seam that makes adding a
 *  second one a registration rather than a rewrite.
 *
 *  ── FAILURE ISOLATION ──────────────────────────────────────────────────────
 *
 *  Providers are called independently and a failure is contained. A dead
 *  provider degrades the evidence set; it does not fail the fact check. The
 *  honest consequence of retrieving nothing is UNVERIFIED, which the gate
 *  already produces.
 *
 *  ── SECRETS ────────────────────────────────────────────────────────────────
 *
 *  Keys are injected, never imported, and never logged. `ProviderAttempt`
 *  records the query and the error but NEVER the credential — an error object
 *  from a failed request can carry the full request URL. */

import { search as tavilySearch, type SearchHit } from './search';

export interface SearchProviderKeys {
  tavily?: string;
}

export interface SearchProvider {
  readonly id: string;
  /** False when a required credential is absent, so the chain can skip it
   *  without paying a failed request. */
  isConfigured(keys: SearchProviderKeys): boolean;
  search(query: string, keys: SearchProviderKeys): Promise<SearchHit[]>;
}

/** One provider's attempt, for observability. Contains no secret. */
export interface ProviderAttempt {
  provider: string;
  /** Truncated: a claim can be long, and full text does not belong in a log. */
  query: string;
  resultCount: number;
  ok: boolean;
  /** Sanitised message. Never the raw error, which can carry a request URL. */
  error?: string;
  durationMs: number;
}

export const tavilyProvider: SearchProvider = {
  id: 'tavily',
  isConfigured: (keys) => Boolean(keys.tavily),
  search: (query, keys) => tavilySearch(keys.tavily ?? '', query),
};

/** Registration order. Tavily first, preserving current behaviour exactly. */
export const SEARCH_PROVIDERS: SearchProvider[] = [tavilyProvider];

export interface SearchChainResult {
  hits: SearchHit[];
  attempts: ProviderAttempt[];
}

/** Truncates a query for logging. */
function safeQuery(query: string): string {
  return query.slice(0, 120);
}

/** Runs configured providers and merges their results.
 *
 *  Merged rather than first-wins: two providers finding different sources is
 *  strictly better evidence, and the deduplication and independence layers
 *  already handle overlap. Order is preserved so the primary provider's
 *  ranking still leads.
 *
 *  Never throws. An empty result is a legitimate outcome that the gate turns
 *  into UNVERIFIED — which is the honest answer when nothing was found. */
export async function searchEvidence(
  query: string,
  keys: SearchProviderKeys,
  providers: SearchProvider[] = SEARCH_PROVIDERS,
): Promise<SearchChainResult> {
  const eligible = providers.filter((p) => p.isConfigured(keys));
  const attempts: ProviderAttempt[] = [];

  // allSettled, not sequential: one slow or dead provider must not delay or
  // abort the others.
  const settled = await Promise.allSettled(
    eligible.map(async (provider) => {
      const started = Date.now();
      try {
        const hits = await provider.search(query, keys);
        attempts.push({
          provider: provider.id,
          query: safeQuery(query),
          resultCount: hits.length,
          ok: true,
          durationMs: Date.now() - started,
        });
        return hits;
      } catch (err) {
        attempts.push({
          provider: provider.id,
          query: safeQuery(query),
          resultCount: 0,
          ok: false,
          // Deliberately generic. A provider error can carry the request URL,
          // and for these APIs the key travels in that URL.
          error: err instanceof Error ? err.name : 'error',
          durationMs: Date.now() - started,
        });
        return [] as SearchHit[];
      }
    }),
  );

  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const outcome of settled) {
    if (outcome.status !== 'fulfilled') continue;
    for (const hit of outcome.value) {
      // Cheap URL-level dedupe here; the real deduplication (canonical URL,
      // article identity, syndication) happens in ./dedupe.ts once passages
      // have been fetched.
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  }

  return { hits, attempts };
}
