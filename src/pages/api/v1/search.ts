import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod, enumParam } from '../../../lib/api/request';
import { handle, ok } from '../../../lib/api/response';
import { cursorFrom, limitParam, optionalFilters, requireQuery } from '../../../lib/api/query';
import { requireDbBinding } from '../../../lib/api/bindings';
import { ArticleRepository } from '../../../lib/db/repositories/articles';
import { FactCheckRepository } from '../../../lib/db/repositories/fact-checks';
import { toApiArticle } from '../../../lib/news/read';

const SEARCH_TYPES = ['news', 'factcheck', 'all'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

/** GET /api/v1/search — full-text search over persisted articles.
 *
 *  Query: ?q= (required) ?category= ?language= ?limit= ?cursor=
 *
 *  `q` is required and bounded. FTS5 MATCH is a query LANGUAGE, so the
 *  repository quotes every word as a literal phrase before it reaches the
 *  database: operators like NEAR, OR and `*` degrade to ordinary words rather
 *  than changing the query or throwing a syntax error.
 *
 *  TWO SEARCH STRATEGIES, chosen by script. Latin queries use the FTS5 index;
 *  every other script uses LIKE substring matching, which is the fallback the
 *  implementation plan prescribes for "scripts FTS handles poorly". Measured
 *  rather than assumed — see the note on `needsLikeFallback`. A stem query
 *  such as `వర్షాల` against the printed `వర్షాలతో` missed under FTS5 and hits
 *  now, and Indic scripts no longer disagree with each other about what a
 *  search means.
 *
 *  RESULTS ARE ORDERED BY RECENCY, NOT RELEVANCE. BM25 `rank` exists only on
 *  the FTS path, so ranking by it would order Latin results by relevance and
 *  non-Latin results by nothing — reintroducing exactly the per-language
 *  inconsistency the fallback removes. Recency is uniform across both paths
 *  and gives the total order keyset pagination requires.
 *
 *  Unlike the feed, an unrecognised category or language is treated as NO
 *  filter rather than as the default: a search should span everything rather
 *  than quietly narrowing to `top` and reporting nothing for a story that
 *  exists.
 *
 *  `?type=` selects the corpus, per the documented contract
 *  (`/api/v1/search?q&type&cursor`, NEWZWALE_ARCHITECTURE.md §4.2):
 *
 *    news (default)  data: ApiArticle[]        — UNCHANGED from before this
 *                                                 param existed; a caller
 *                                                 that never sends `type`
 *                                                 gets byte-identical output.
 *    factcheck       data: FactCheckRecord[]   — reuses
 *                                                 FactCheckRepository.search(),
 *                                                 which is limit-only.
 *                                                 `meta.cursor` is honestly
 *                                                 absent rather than faked:
 *                                                 that repository method has
 *                                                 no cursor support to
 *                                                 forward.
 *    all             data: { news, factChecks } — both corpora, un-paginated
 *                                                 relative to each other for
 *                                                 the same reason.
 *
 *  Category/language filters apply to `news` only — fact-checks are not
 *  categorised by article category in the schema. */
export const GET: APIRoute = async ({ request, url }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const db = requireDbBinding(env);
    const q = requireQuery(url);
    const type = enumParam(url.searchParams.get('type'), SEARCH_TYPES, 'news' as SearchType);
    const limit = limitParam(url);

    if (type === 'factcheck') {
      const results = await new FactCheckRepository(db).search(q, limit);
      return ok(results, { cached: false });
    }

    if (type === 'all') {
      const { category, language } = optionalFilters(url);
      const [newsPage, factChecks] = await Promise.all([
        new ArticleRepository(db).searchPage(q, { category, language, limit }),
        new FactCheckRepository(db).search(q, limit),
      ]);
      return ok(
        { news: newsPage.items.map(toApiArticle), factChecks },
        { cached: false },
      );
    }

    const { category, language } = optionalFilters(url);
    const page = await new ArticleRepository(db).searchPage(q, {
      category,
      language,
      limit,
      cursor: cursorFrom(url),
    });

    return ok(page.items.map(toApiArticle), {
      cursor: page.cursor,
      cached: false,
    });
  });
