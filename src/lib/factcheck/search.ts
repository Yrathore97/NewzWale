// Web search provider: Tavily.
//
// WHY NOT the Cloudflare Web Search binding: it was the original choice, but
// every call on this account throws `Error: account_disabled` (confirmed via
// `wrangler tail`). That is an account entitlement, not a bug we can fix in
// code - Web Search is absent from Cloudflare's public bindings docs, so it
// appears not to be generally available. The practical effect was that stage 2
// retrieved nothing, stage 3 never ran, and every claim without a published
// fact-check came back `insufficient_evidence`. Do not restore the binding
// without first confirming it works on the account.
//
// Tavily also returns better evidence: `content` is a query-relevant extract,
// whereas Web Search only ever exposed the page-level meta description.
// Grounding on an extract beats grounding on a meta tag.
//
// The API key is injected rather than imported so this module stays pure
// TypeScript with no Worker imports, matching `cached(kv, ...)` in ../cache.ts.

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Date the provider claims for the page, where it supplies one.
   *
   *  Ranked LOWEST by extractPublicationDate: it is a third party's assertion
   *  about when the publisher published, not the publisher's own markup. Used
   *  only when the page itself carries no date. */
  publishedAt?: string | null;
}

const ENDPOINT = 'https://api.tavily.com/search';

/** Domains excluded from Tavily results.
 *
 *  MEASURED, not guessed - both categories were seen occupying evidence
 *  slots on a real claim without ever contributing a usable stance:
 *
 *    - Social platforms require a login to render their actual content, so
 *      `fetchArticle` gets a logged-out shell, not the post. Facebook did
 *      exactly this on the live run this list was built from: retrieved,
 *      fetched in full, `relevanceLevel: 'none'` - a wasted slot every time.
 *    - Document/listing aggregators (Scribd, MagicBricks) surface pages
 *      that mention a topic without asserting anything about it - a PDF
 *      upload, a real-estate listing referencing a nearby expressway. Both
 *      were retrieved, both scored low relevance, neither corroborated.
 *
 *  With MAX_SOURCES capped at 6, every slot one of these fills is a slot a
 *  source that could actually settle the claim does not get. */
const EXCLUDED_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'scribd.com',
  'magicbricks.com',
];
/** Raised from 5. `pipeline.ts` still caps total evidence shown at
 *  `MAX_SOURCES` (6) — this only widens the candidate pool Tavily ranks
 *  before that cap is applied, so a source that directly addresses a narrow
 *  sub-fact (e.g. "who governed when X was built") has more chance of
 *  surviving into the final 6 instead of being pushed out by generic
 *  coverage of the same topic. */
const MAX_RESULTS = 8;

export function parseTavilyResults(raw: any): SearchHit[] {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  return results
    .filter((r: any) => r?.url && r?.title)
    .map((r: any) => ({
      title: String(r.title),
      url: String(r.url),
      snippet: String(r.content ?? ''),
      publishedAt: typeof r.published_date === 'string' ? r.published_date : null,
    }));
}

export async function search(apiKey: string, query: string): Promise<SearchHit[]> {
  // No key means no search. Returning [] degrades to insufficient_evidence,
  // which is the honest outcome - never a guessed verdict.
  if (!apiKey) {
    console.error('TAVILY_API_KEY is not set; skipping evidence retrieval.');
    return [];
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        // Header, not a query param: a key in the URL leaks into logs.
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        max_results: MAX_RESULTS,
        search_depth: 'basic',
        exclude_domains: EXCLUDED_DOMAINS,
      }),
    });

    if (!res.ok) {
      console.error('Tavily search failed:', res.status);
      return [];
    }

    return parseTavilyResults(await res.json());
  } catch (err) {
    // Evidence retrieval is best-effort: the caller falls back to reporting
    // insufficient evidence rather than failing the whole fact check. Logged
    // because a silent failure here is indistinguishable from "no results".
    console.error('Tavily search failed:', err);
    return [];
  }
}
