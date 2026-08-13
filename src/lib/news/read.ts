/** The D1-backed read layer behind /api/v1.
 *
 *  Every v1 news endpoint reads PERSISTED rows. No route in this path calls a
 *  provider: ingestion (src/lib/news/ingest.ts) is what talks to NewsData,
 *  Guardian and RSS, on a schedule, and D1 is the system of record the reader
 *  is served from. That separation is the point of Phase 5 — a reader's
 *  request must not be blocked on a third-party API being awake, and a request
 *  spike must not become an upstream quota spike.
 *
 *  The legacy /api/news is deliberately NOT routed through here. It still uses
 *  the KV + provider-chain path in ./service.ts and still answers in its old
 *  un-enveloped shape, because NewsFeed.astro parses that shape today. */

import type { ArticleRecord, StoryClusterRecord } from '../db/repositories/articles';

/** One article as /api/v1 exposes it.
 *
 *  A deliberate projection of ArticleRecord, not the row itself: `sourceId`,
 *  `providerId` and the internal timestamps are ingestion bookkeeping and are
 *  not part of the public contract. Field names stay camelCase to match the
 *  existing `Article` type the frontend already consumes. */
export interface ApiArticle {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  url: string;
  imageUrl: string | null;
  source: string;
  category: string;
  language: string;
  /** ISO-8601, or NULL when the publication date genuinely could not be
   *  established. Clients must render the absence rather than substituting
   *  "now" — that is the entire reason the column is nullable. */
  publishedAt: string | null;
  clusterId: string | null;
}

export function toApiArticle(row: ArticleRecord): ApiArticle {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? null,
    // The canonical URL is what we link out to, and what dedup is keyed on.
    url: row.canonicalUrl,
    imageUrl: row.imageUrl ?? null,
    source: row.publisherName,
    category: row.category,
    language: row.language,
    publishedAt: row.publishedAt,
    clusterId: row.clusterId ?? null,
  };
}

export interface ApiStory {
  id: string;
  headline: string;
  category: string;
  language: string;
  articleCount: number;
  /** Distinct INDEPENDENT publishers, after collapsing shared ownership. */
  sourceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  score: number;
}

/** Half-life of the recency term, in hours.
 *
 *  12 hours: a story that led the feed this morning should not still lead it
 *  tomorrow morning purely on the coverage it accumulated. */
export const TRENDING_HALF_LIFE_HOURS = 12;

/** Minimum independent sources before a story may appear in trending.
 *
 *  A "trending story" covered by one outlet is not trending, it is one
 *  article. Breadth of independent coverage is the only trending signal we
 *  can measure honestly — there are no click counts, no dwell time and no
 *  social data anywhere in this system, and inventing a proxy for them would
 *  be dressing up recency as popularity. */
export const TRENDING_MIN_SOURCES = 2;

/** Deterministic trending score. Documented because it is shown to readers.
 *
 *      score = log2(1 + independentSources) x 0.5 ^ (ageHours / 12)
 *
 *  Two terms, both defensible:
 *
 *  BREADTH, log2(1 + sources). Sub-linear on purpose. The step from one
 *  outlet to three is real evidence that something happened; the step from
 *  twenty to twenty-two is not, and a linear term would let a heavily
 *  syndicated story dominate indefinitely.
 *
 *  RECENCY, exponential decay. Smooth rather than a cliff, so a story fades
 *  out of the list instead of dropping off it at an arbitrary age boundary.
 *
 *  NOT IN THE FORMULA, deliberately: article_count. It counts ROWS, and four
 *  outlets running the same wire copy produce four rows from one newsroom.
 *  Ranking on it would reward syndication, which is the opposite of the
 *  breadth this is trying to measure. It is returned for display but not
 *  ranked on.
 *
 *  Deterministic: same inputs, same output, no randomness and no model. `now`
 *  is a parameter rather than a call to Date.now() so the ordering is testable
 *  and reproducible.
 *
 *  A story with an age in the future (clock skew on a publisher's timestamp)
 *  is clamped to age 0 rather than scoring above every real story. */
export function trendingScore(cluster: StoryClusterRecord, now: number): number {
  const seen = Date.parse(cluster.lastSeenAt);
  // An unparseable timestamp scores 0 rather than NaN; NaN would make the
  // comparator non-deterministic and could scramble the whole ordering.
  if (Number.isNaN(seen)) return 0;

  const ageHours = Math.max(0, (now - seen) / (60 * 60 * 1000));
  const breadth = Math.log2(1 + Math.max(0, cluster.sourceCount));
  const recency = Math.pow(0.5, ageHours / TRENDING_HALF_LIFE_HOURS);

  return breadth * recency;
}

/** Ranks clusters by `trendingScore`, filtering out single-source stories.
 *
 *  Ties break on lastSeenAt then id, so the order is TOTAL: two stories with
 *  an identical score cannot swap between calls, which would make cursor
 *  pagination skip or repeat rows. */
export function rankTrending(
  clusters: StoryClusterRecord[],
  now: number,
  limit: number,
): ApiStory[] {
  return clusters
    .filter((c) => c.sourceCount >= TRENDING_MIN_SOURCES)
    .map((c) => ({
      id: c.id,
      headline: c.headline,
      category: c.category,
      language: c.language,
      articleCount: c.articleCount,
      sourceCount: c.sourceCount,
      firstSeenAt: c.firstSeenAt,
      lastSeenAt: c.lastSeenAt,
      score: trendingScore(c, now),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, limit);
}
