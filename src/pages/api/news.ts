import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getNewsPage } from '../../lib/news/service';

/** Legacy news endpoint.
 *
 *  The validation, caching and provider-fallback logic that used to live here
 *  now lives in src/lib/news/service.ts, so pages and API routes can share one
 *  read path instead of pages issuing HTTP requests back into this route.
 *
 *  The RESPONSE SHAPE IS DELIBERATELY UNCHANGED - a bare
 *  `{ articles, nextPage }`, not the /api/v1 envelope. NewsFeed.astro's "Load
 *  more" handler parses this shape, and the point of versioning under /v1 is
 *  that the migration can be gradual rather than a flag day. */
export const GET: APIRoute = async ({ url }) => {
  const result = await getNewsPage(
    env.NEWZ_CACHE,
    {
      category: url.searchParams.get('category'),
      language: url.searchParams.get('language'),
      page: url.searchParams.get('page'),
    },
    {
      newsdata: (env as unknown as { NEWSDATA_API_KEY?: string }).NEWSDATA_API_KEY ?? '',
      guardian: (env as unknown as { GUARDIAN_API_KEY?: string }).GUARDIAN_API_KEY ?? '',
    },
  );

  return new Response(
    JSON.stringify({
      articles: result.articles,
      nextPage: result.nextPage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
