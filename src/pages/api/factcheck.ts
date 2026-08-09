import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { searchGoogleFactCheck } from '../../lib/factcheck/google';
import { searchEvidence } from '../../lib/factcheck/providers';
import { fetchArticle, fetchArticleText } from '../../lib/factcheck/extract';
import { extractRelevantPassage } from '../../lib/factcheck/passage';
import { extractPublicationDate } from '../../lib/factcheck/metadata';
import { runFactCheck, type FetchedPassage } from '../../lib/factcheck/pipeline';
import { persistFactCheck } from '../../lib/factcheck/persist';
import type { FactCheckResult } from '../../lib/factcheck/types';
import { factCheckCacheKey, normalizeClaim } from '../../lib/cache';
import { contentId, getDb } from '../../lib/db/client';
import {
  checkRateLimitSafe,
  requestIdentity,
  type RateLimiterNamespace,
} from '../../lib/ratelimit';
import { readJson } from '../../lib/api/request';
import { ApiError } from '../../lib/api/errors';
import { MODEL } from '../../lib/factcheck/version';

const RATE_LIMIT = 20; // per identity per hour
const CACHE_TTL = 60 * 60 * 24;

const MIN_CLAIM_CHARS = 10;
const MAX_CLAIM_CHARS = 4000;
const MAX_BODY_BYTES = 64 * 1024;
/** Search results to consider. Raised from 3 now that fetching is bounded and
 *  corroboration needs candidates to work with. */
const MAX_SEARCH_RESULTS = 6;

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

/** Resolves the request body into the text to be checked. */
async function resolveInput(
  body: unknown,
): Promise<{ text: string; source: 'text' | 'url'; originUrl?: string }> {
  const { claim, url } = (body ?? {}) as { claim?: unknown; url?: unknown };

  if (typeof url === 'string' && url.trim()) {
    // safeFetchText validates scheme, blocks private hosts on every redirect
    // hop, and bounds time, size and content type.
    const text = (await fetchArticleText(url.trim())).trim();
    return { text, source: 'url', originUrl: url.trim() };
  }
  if (typeof claim === 'string') return { text: claim.trim(), source: 'text' };
  return { text: '', source: 'text' };
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await readJson(request, MAX_BODY_BYTES);
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 400;
    return json({ error: err instanceof Error ? err.message : 'Invalid JSON body.' }, status);
  }

  const identity = requestIdentity(request);
  if (!identity) {
    return json({ error: 'Could not identify the request source.' }, 400);
  }

  // Rate limit before any outbound work, so the article fetch cannot be used
  // as an unmetered proxy.
  const limiter = (env as unknown as { RATE_LIMITER?: RateLimiterNamespace }).RATE_LIMITER;
  const decision = await checkRateLimitSafe(limiter, { endpoint: 'factcheck', identity }, RATE_LIMIT);
  if (!decision.allowed) {
    return json({ error: 'Too many checks from this address. Try again later.' }, 429, {
      'retry-after': String(decision.retryAfterSeconds),
    });
  }

  let input: { text: string; source: 'text' | 'url'; originUrl?: string };
  try {
    input = await resolveInput(body);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not read that URL.' }, 400);
  }

  if (input.text.length < MIN_CLAIM_CHARS) {
    return json({ error: `Give at least ${MIN_CLAIM_CHARS} characters to check.` }, 400);
  }
  if (input.text.length > MAX_CLAIM_CHARS) {
    input.text = input.text.slice(0, MAX_CLAIM_CHARS);
  }

  // Cache identity binds the claim to the pipeline version, so a methodology
  // change makes older verdicts unreachable rather than re-labelled.
  const cacheKey = await factCheckCacheKey(input.text);
  const hit = await env.NEWZ_CACHE.get(cacheKey);
  if (hit) {
    try {
      return json(JSON.parse(hit) as FactCheckResult);
    } catch {
      // Corrupt cache entry - fall through and recompute.
    }
  }

  const googleKey =
    (env as unknown as { GOOGLE_FACTCHECK_API_KEY?: string }).GOOGLE_FACTCHECK_API_KEY ?? '';
  const tavilyKey = (env as unknown as { TAVILY_API_KEY?: string }).TAVILY_API_KEY ?? '';

  const result = await runFactCheck(
    input.text,
    {
      certified: async (query) => {
        if (!googleKey) return [];
        try {
          return await searchGoogleFactCheck(googleKey, query);
        } catch {
          // Certified review is one evidence source, not a requirement.
          return [];
        }
      },

      passages: async (query) => {
        const { hits: allHits } = await searchEvidence(query, { tavily: tavilyKey });
        const hits = allHits.slice(0, MAX_SEARCH_RESULTS);
        // allSettled: one page failing must never abort the others.
        const fetched = await Promise.allSettled(hits.map((h) => fetchArticle(h.url)));

        const out: FetchedPassage[] = [];
        hits.forEach((hitItem, i) => {
          const outcome = fetched[i];
          const ok = outcome?.status === 'fulfilled' ? outcome.value : null;

          // Whether we read the page or fell back to the search snippet is
          // recorded, not silently collapsed.
          const readMethod = ok?.text.trim() ? 'full_page' : 'search_snippet';

          // Select the blocks that engage the claim rather than the first N
          // characters, which were usually a cookie banner and a nav menu.
          const selected = ok?.html
            ? extractRelevantPassage(ok.html, query).text
            : '';
          const text = selected || ok?.text.trim() || hitItem.snippet.trim();
          if (!text) return;

          // Publication date from page metadata. NULL when the page carries
          // none — never the fetch time, never inferred from the URL.
          const dates = ok?.html
            ? extractPublicationDate(ok.html, { providerDate: hitItem.publishedAt ?? null })
            : { publishedAt: null, source: 'none' as const, conflict: false };

          out.push({
            hit: hitItem,
            text,
            readMethod,
            publishedAt: dates.publishedAt,
            dateSource: dates.source,
            dateConflict: dates.conflict,
          });
        });
        return out;
      },

      // Per-passage stance. A SEPARATE call from runModel, seeing only the
      // claim and one passage — never the proposed verdict. That separation
      // is what keeps stance from validating the verdict it helps produce.
      classifyStance: (system, user) =>
        env.AI.run(MODEL, {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: 250,
        }),

      runModel: (system, user) =>
        env.AI.run(MODEL, {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // Deterministic: the same claim and sources should not produce
          // different verdicts on different days.
          temperature: 0,
          max_tokens: 600,
        }),
    },
    { source: input.source, originUrl: input.originUrl },
  );

  // ── Persist to D1 (source of truth), then cache (performance copy). ──────
  const normalized = normalizeClaim(input.text);
  const recordId = await contentId(`${normalized}|p${result.pipelineVersion}|e${result.evidenceVersion}`);

  const outcome = await persistFactCheck(
    getDb(env),
    result,
    {
      id: recordId,
      claimNormalized: normalized,
      claimSource: input.source,
      originUrl: input.originUrl,
    },
  );

  // An id is only returned when a durable record actually exists behind it.
  // Handing out a permalink we cannot honour is worse than omitting one.
  const payload: FactCheckResult = outcome.persisted ? { ...result, id: outcome.id } : result;

  const { extracted: _extracted, ...cacheable } = payload as FactCheckResult & {
    extracted?: unknown;
  };

  try {
    await env.NEWZ_CACHE.put(cacheKey, JSON.stringify(cacheable), { expirationTtl: CACHE_TTL });
  } catch (err) {
    // A cache write failure is harmless: the next request recomputes and the
    // durable insert is idempotent on its primary key.
    console.error('Fact-check cache write failed:', err);
  }

  return json(cacheable);
};
