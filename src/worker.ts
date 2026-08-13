/** Worker entrypoint.
 *
 *  WHY THIS FILE EXISTS. `wrangler.jsonc` used to point `main` straight at
 *  `@astrojs/cloudflare/entrypoints/server`, which exports only
 *  `{ fetch }`. Two things have to be reachable from the entry module and
 *  cannot be from there:
 *
 *    1. A Durable Object class must be a named export of the Worker's entry
 *       module, so the rate limiter could not be reached.
 *    2. A cron trigger calls `scheduled()` on the DEFAULT export, so
 *       ingestion had nowhere to live.
 *
 *  The request path is untouched: `fetch` is the adapter's own, so SSR
 *  routing, asset serving and the image service behave exactly as before.
 *  Only `scheduled` is added alongside it.
 *
 *  DEPLOYMENT: `main` in wrangler.jsonc must point HERE, not at the adapter. */

import adapter from '@astrojs/cloudflare/entrypoints/server';
import { runScheduledIngest } from './lib/news/schedule';
import { getDb } from './lib/db/client';

export { RateLimiter } from './lib/durable/rate-limiter';

/** The secrets ingestion needs. Structural rather than an import of the
 *  generated `Env`, so this file states exactly what it reads. */
interface IngestEnv {
  NEWSDATA_API_KEY?: string;
  GUARDIAN_API_KEY?: string;
}

export default {
  // Spread rather than re-declare: whatever the adapter exports on its
  // handler (today `fetch`) keeps working without this file having to know
  // the full shape.
  ...adapter,

  /** Cron tick — populates D1 so /trending, /search and /news/[slug] have
   *  something to read.
   *
   *  AWAITED, not fired into `waitUntil`: ingestion IS the work of this
   *  invocation, and a scheduled handler that returns early gets its pending
   *  promises cancelled once the event settles.
   *
   *  `runScheduledIngest` is contractually non-throwing. That matters here:
   *  Cloudflare retries a cron invocation that rejects, and a retry would
   *  re-spend NewsData quota on the categories that already succeeded. */
  async scheduled(
    controller: { cron?: string; scheduledTime?: number },
    env: unknown,
    _ctx: unknown,
  ): Promise<void> {
    const secrets = env as IngestEnv | undefined;

    const results = await runScheduledIngest(getDb(env), {
      newsdata: secrets?.NEWSDATA_API_KEY ?? '',
      guardian: secrets?.GUARDIAN_API_KEY ?? '',
    });

    // Observability is on (wrangler.jsonc), so this lands in Workers logs and
    // is how a degraded feed gets noticed. Only counts, provider ids and
    // already-sanitised reasons — `safeReason()` in ingest.ts has stripped
    // any URL that could carry an API key.
    const persisted = results.reduce((n, r) => n + (r.persisted ?? 0), 0);
    const failed = results.filter((r) => !r.ok).map((r) => r.category);
    const degraded = results.flatMap((r) => r.failedProviders ?? []);

    console.log(
      JSON.stringify({
        event: 'scheduled_ingest',
        cron: controller?.cron ?? null,
        categories: results.length,
        persisted,
        failedCategories: failed,
        degradedProviders: degraded,
      }),
    );
  },
};
