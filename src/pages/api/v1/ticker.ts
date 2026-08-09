import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod } from '../../../lib/api/request';
import { handle, ok } from '../../../lib/api/response';
import { limitParam } from '../../../lib/api/query';
import { requireDbBinding } from '../../../lib/api/bindings';
import { ArticleRepository } from '../../../lib/db/repositories/articles';
import { toApiArticle } from '../../../lib/news/read';

/** GET /api/v1/ticker — the newest persisted headlines.
 *
 *  Query: ?limit=
 *
 *  DIFFERENT THING FROM /api/ticker, which is left untouched. That endpoint
 *  returns Sensex/Nifty quotes from Yahoo Finance and is what the masthead
 *  strip renders today; this one is the HEADLINE ticker the v1 surface needs,
 *  served from D1. Two endpoints, two datasets, and the older name is not
 *  reused for the new meaning — renaming it would silently change what an
 *  existing client receives.
 *
 *  No provider is contacted here. Ordering is (published_at DESC, id DESC)
 *  with undated articles last, so it is deterministic and total.
 *
 *  Uncursored on purpose: a ticker shows the newest N and nothing else.
 *  Paging backwards through it is what /api/v1/news is for. */
export const GET: APIRoute = async ({ request, url }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const db = requireDbBinding(env);
    const articles = await new ArticleRepository(db).listRecent(limitParam(url));

    return ok(articles.map(toApiArticle), { cached: false });
  });
