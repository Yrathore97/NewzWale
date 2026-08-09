import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod } from '../../../lib/api/request';
import { handle, ok } from '../../../lib/api/response';
import { limitParam } from '../../../lib/api/query';
import { requireDbBinding } from '../../../lib/api/bindings';
import { StoryClusterRepository } from '../../../lib/db/repositories/articles';
import { rankTrending, TRENDING_HALF_LIFE_HOURS } from '../../../lib/news/read';

/** GET /api/v1/trending — stories ranked by breadth of independent coverage.
 *
 *  Query: ?limit=
 *
 *  THE RANKING IS PUBLISHED, because readers are entitled to know what
 *  "trending" means here:
 *
 *      score = log2(1 + independentSources) x 0.5 ^ (ageHours / 12)
 *
 *  and a story needs at least 2 independent sources to appear at all.
 *
 *  It is NOT popularity. NewzWale has no click counts, no dwell time and no
 *  social signals, so any "most read" label would be invented. What can be
 *  measured honestly is how many INDEPENDENT newsrooms covered a story —
 *  independent meaning after collapsing shared ownership, so two outlets under
 *  one owner count once.
 *
 *  `articleCount` is returned but deliberately NOT ranked on: it counts rows,
 *  and four outlets running the same wire copy are four rows from one
 *  newsroom. Ranking on it would reward syndication.
 *
 *  No AI model is involved. Same inputs, same order, every time.
 *
 *  Candidates are read from D1 and scored at request time rather than read
 *  from the stored `trending_score`: the recency term decays continuously, so
 *  a persisted score is stale the moment it is written. */

/** How far back a story may have been seen and still be ranked. Four
 *  half-lives, past which the recency term has decayed to ~6% and the story
 *  cannot realistically place. */
const WINDOW_HOURS = TRENDING_HALF_LIFE_HOURS * 4;

export const GET: APIRoute = async ({ request, url }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const db = requireDbBinding(env);
    const now = Date.now();
    const since = new Date(now - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const clusters = await new StoryClusterRepository(db).listRecentClusters(since);
    const stories = rankTrending(clusters, now, limitParam(url));

    return ok(stories, {
      cached: false,
      total: stories.length,
    });
  });
