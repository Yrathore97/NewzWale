import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod } from '../../../lib/api/request';
import { handle, ok } from '../../../lib/api/response';
import { cursorFrom, feedFilters, limitParam } from '../../../lib/api/query';
import { requireDbBinding } from '../../../lib/api/bindings';
import { ArticleRepository } from '../../../lib/db/repositories/articles';
import { toApiArticle } from '../../../lib/news/read';

/** GET /api/v1/news — the persisted category feed.
 *
 *  READS D1, NEVER A PROVIDER. The legacy /api/news still calls the provider
 *  chain on a cache miss, which means a reader's request can block on
 *  NewsData being awake and a traffic spike becomes an upstream quota spike.
 *  Here ingestion has already done that work on a schedule, so this route only
 *  reads rows.
 *
 *  Query: ?category= ?language= ?limit= ?cursor=
 *
 *  Pagination is KEYSET, not OFFSET: the feed grows continuously, so an offset
 *  would repeat or skip articles as rows shift beneath it. `meta.cursor` is
 *  present only when a further page exists, so `'cursor' in meta` is a
 *  reliable "has more".
 *
 *  Unknown category/language fall back to the defaults rather than 400,
 *  matching /api/news, so an old bookmark keeps working. A malformed cursor
 *  DOES 400 — silently restarting from page 1 would leave a paging client
 *  looping over the first page forever. */
export const GET: APIRoute = async ({ request, url }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const db = requireDbBinding(env);
    const { category, language } = feedFilters(url);
    const limit = limitParam(url);
    const cursor = cursorFrom(url);

    const page = await new ArticleRepository(db).pageByCategory(category, language, {
      limit,
      cursor,
    });

    return ok(page.items.map(toApiArticle), {
      cursor: page.cursor,
      cached: false,
    });
  });
