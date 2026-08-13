import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod } from '../../../lib/api/request';
import { handle, ok, fail } from '../../../lib/api/response';
import { fetchMarketTicker, type Quote } from '../../../lib/market';
import {
  checkRateLimitSafe,
  requestIdentity,
  type RateLimiterNamespace,
} from '../../../lib/ratelimit';

/** GET /api/v1/ticker — Sensex/Nifty quotes.
 *
 *  THIS IS THE MARKET TICKER, per NEWZWALE_ARCHITECTURE.md §4.2 ("KV-cached
 *  60 s, rate-limited (security S-08)") — not a news-headline feed. An
 *  earlier draft of this route served D1 headlines under this path; nothing
 *  in any planning document names a headline endpoint here, so that was a
 *  naming error corrected in this pass rather than a documented contract
 *  being preserved. `/api/ticker` (legacy) remains the only other market-data
 *  route and is untouched.
 *
 *  S-08 REMEDIATION, applied to the v1 path: the legacy `/api/ticker` makes
 *  two outbound Yahoo Finance calls on every hit with no cache and no rate
 *  limit — free request amplification, and a way to get NewzWale's egress IPs
 *  throttled by Yahoo. This route KV-caches the quote for 60 s and rate-limits
 *  by identity before making any outbound call.
 *
 *  ON FAILURE THIS RETURNS 503, NOT A STALE NUMBER. S-08 explicitly calls
 *  "hide rather than show a stale number" the correct behaviour for market
 *  data and says to keep it. The shared `cached()` helper in ../../../lib/cache
 *  is deliberately NOT used here: it falls back to a `:stale` KV entry on a
 *  fetch failure, which is exactly the behaviour S-08 says to avoid for this
 *  data. This route reads/writes a plain KV entry with a 60 s TTL and nothing
 *  else — a miss or an expired entry always re-fetches, and a fetch failure
 *  always surfaces as 503. */
const CACHE_TTL_SECONDS = 60;
const CACHE_KEY = 'v1:ticker:market';
const RATE_LIMIT = 60; // generous: one client polling every few seconds all day

export const GET: APIRoute = async ({ request }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const identity = requestIdentity(request);
    if (identity) {
      const limiter = (env as unknown as { RATE_LIMITER?: RateLimiterNamespace }).RATE_LIMITER;
      const decision = await checkRateLimitSafe(
        limiter,
        { endpoint: 'v1-ticker', identity },
        RATE_LIMIT,
      );
      if (!decision.allowed) {
        return fail('RATE_LIMITED', 'Too many requests. Try again shortly.', {
          'retry-after': String(decision.retryAfterSeconds),
        });
      }
    }

    const hit = await env.NEWZ_CACHE.get(CACHE_KEY);
    if (hit) {
      try {
        return ok(JSON.parse(hit) as { sensex: Quote; nifty: Quote }, { cached: true });
      } catch {
        // Corrupt cache entry - fall through and refetch.
      }
    }

    let quote: { sensex: Quote; nifty: Quote };
    try {
      quote = await fetchMarketTicker();
    } catch {
      // Hide rather than show a stale number (S-08). No fallback KV read.
      return fail('UPSTREAM_UNAVAILABLE', 'Market data is unavailable right now.');
    }

    try {
      await env.NEWZ_CACHE.put(CACHE_KEY, JSON.stringify(quote), { expirationTtl: CACHE_TTL_SECONDS });
    } catch (err) {
      // A cache write failure is harmless: the next request just refetches.
      console.error('Ticker cache write failed:', err);
    }

    return ok(quote, { cached: false });
  });
