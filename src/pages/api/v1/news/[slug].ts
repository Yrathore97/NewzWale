import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod } from '../../../../lib/api/request';
import { handle, ok, fail } from '../../../../lib/api/response';
import { requireDbBinding } from '../../../../lib/api/bindings';
import { ArticleRepository } from '../../../../lib/db/repositories/articles';
import { FactCheckRepository } from '../../../../lib/db/repositories/fact-checks';
import { toApiArticle } from '../../../../lib/news/read';

const MAX_SLUG_LENGTH = 200;

/** GET /api/v1/news/[slug] — one story page (AD-09).
 *
 *  AD-09: this is a STORY PAGE, not a reproduction. The response carries the
 *  publisher's own summary (verbatim, never rewritten — `article.summary` is
 *  stored exactly as the provider supplied it) and the canonical URL to read
 *  the full story at the publisher. No article body is fetched, generated or
 *  hosted here.
 *
 *  Three pieces, matching the documented shape:
 *    - the article itself
 *    - "also reported by" — other articles in the same cluster
 *    - linked fact-checks for claims submitted from this story */
export const GET: APIRoute = async ({ request, params }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const slug = params.slug ?? '';
    if (!slug || slug.length > MAX_SLUG_LENGTH) {
      return fail('NOT_FOUND', 'No story exists at that address.');
    }

    const db = requireDbBinding(env);
    const articles = new ArticleRepository(db);

    const article = await articles.findBySlug(slug);
    if (!article) {
      return fail('NOT_FOUND', 'No story exists at that address.');
    }

    const [coverage, factChecks] = await Promise.all([
      article.clusterId ? articles.listByCluster(article.clusterId, article.id) : Promise.resolve([]),
      new FactCheckRepository(db).listByArticle(article.id),
    ]);

    return ok(
      {
        article: toApiArticle(article),
        coverage: coverage.map(toApiArticle),
        factChecks,
      },
      { cached: false },
    );
  });
