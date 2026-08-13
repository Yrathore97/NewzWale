/** Scheduled ingestion: what one cron tick actually does.
 *
 *  Kept OUT of src/worker.ts so it is unit-testable without a Worker runtime —
 *  the same reason `ingest()` takes a structural `Db` rather than importing
 *  Cloudflare's D1Database type.
 *
 *  ── WHY THE FEED WAS EMPTY ─────────────────────────────────────────────────
 *
 *  D1 was provisioned and the schema applied, but nothing ever wrote to it:
 *  `ingest()` had no caller. /trending and /search therefore rendered a
 *  correct-but-permanent empty state. This module is that missing caller.
 *
 *  ── QUOTA IS THE BINDING CONSTRAINT, NOT WALL-CLOCK FRESHNESS ──────────────
 *
 *  NEWZWALE_IMPLEMENTATION_PLAN.md Phase 2 is explicit that the schedule must
 *  be sized against real provider quota, and that 8 categories x 13 languages
 *  is "far beyond any free tier". One `ingest()` call spends ONE NewsData
 *  request (plus one Guardian request and the RSS fetches, neither of which is
 *  the scarce resource).
 *
 *  So the cost of a tick is exactly `CRON_CATEGORIES.length` NewsData
 *  requests. At the shipped 2-hourly schedule that is:
 *
 *      8 categories x 12 ticks/day = 96 NewsData requests/day
 *
 *  NewsData's free tier is documented at 200 credits/day, so this sits at
 *  roughly half — deliberate headroom, because the on-demand read path
 *  (`/api/news`, which still serves the homepage) spends from the same quota
 *  on a cache miss. Raising the frequency without re-measuring that shared
 *  spend is how a feed goes dark at 6pm.
 *
 *  ENGLISH ONLY, for now. Adding a language multiplies the cost by the number
 *  of languages, which is exactly the trap the plan names. The other twelve
 *  languages remain available on the on-demand read path, which is how they
 *  are served today; widening ingestion to them is a quota decision with a
 *  measured number behind it, not a default.
 *
 *  ── FAILURE POLICY ─────────────────────────────────────────────────────────
 *
 *  Categories run SEQUENTIALLY and each is independently guarded. A cron tick
 *  that throws is retried by Cloudflare, so a single failing category must not
 *  discard the categories that already succeeded — and must not turn one bad
 *  provider response into a repeating full-fan-out retry storm against a
 *  metered API. */

import { ingest } from './ingest';
import type { ProviderKeys } from './providers';
import type { Db } from '../db/client';

/** Categories ingested on every tick. `top` first: it is the homepage's
 *  default and the one most likely to matter if a later category fails. */
export const CRON_CATEGORIES = [
  'top',
  'india',
  'world',
  'business',
  'sports',
  'entertainment',
  'technology',
  'health',
] as const;

/** See the quota note above before changing this. */
export const CRON_LANGUAGE = 'en';

export interface ScheduledIngestResult {
  category: string;
  ok: boolean;
  fetched?: number;
  persisted?: number;
  deduplicated?: number;
  clustered?: number;
  /** Carried through so a provider degrading (a dead key, a rate limit) is
   *  visible in the tick's log rather than hidden behind a healthy `ok: true`
   *  from the providers that still worked. `safeReason()` in ingest.ts has
   *  already stripped URLs, so this is safe to log. */
  failedProviders?: Array<{ providerId: string; reason: string }>;
  error?: string;
}

/** Runs one cron tick's worth of ingestion.
 *
 *  Never throws: a tick is a best-effort background job, and Cloudflare's
 *  retry on an unhandled rejection would re-spend quota on the categories that
 *  already succeeded. The per-category outcome is returned (and logged by the
 *  caller) so a degraded run is observable rather than silent. */
export async function runScheduledIngest(
  db: Db | undefined,
  keys: ProviderKeys,
  categories: readonly string[] = CRON_CATEGORIES,
  language: string = CRON_LANGUAGE,
): Promise<ScheduledIngestResult[]> {
  if (!db) {
    return categories.map((category) => ({
      category,
      ok: false,
      error: 'database binding absent',
    }));
  }

  const results: ScheduledIngestResult[] = [];

  for (const category of categories) {
    try {
      const summary = await ingest(db, keys, { category, language });
      results.push({
        category,
        ok: true,
        fetched: summary.fetched,
        persisted: summary.persisted,
        deduplicated: summary.deduplicated,
        clustered: summary.clustered,
        failedProviders: summary.failedProviders,
      });
    } catch (error) {
      results.push({
        category,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
