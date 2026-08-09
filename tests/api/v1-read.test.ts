/** The D1-backed read paths behind /api/v1, exercised against real SQLite
 *  running both real migrations.
 *
 *  The Astro route handlers themselves are thin wrappers over these calls
 *  (validate, call repository, envelope). Testing the data path executably is
 *  worth more than mocking a Request to assert the wrapper, so the wrapper's
 *  own logic is covered by tests/api/v1-query.test.ts and the envelope by
 *  tests/api/response.test.ts. */

import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_0001 from '../../src/lib/db/migrations/0001_init.sql?raw';
import MIGRATION_0002 from '../../src/lib/db/migrations/0002_nullable_published_at.sql?raw';
import { DatabaseSync } from 'node:sqlite';
import {
  ArticleRepository,
  type ArticleRecord,
  type StoryClusterRecord,
} from '../../src/lib/db/repositories/articles';
import { decodeCursor, type Db } from '../../src/lib/db/client';
import { toApiArticle, rankTrending, trendingScore } from '../../src/lib/news/read';
import { requireDbBinding } from '../../src/lib/api/bindings';
import { ApiError } from '../../src/lib/api/errors';

function makeDb(): Db & { _raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(MIGRATION_0001);
  raw.exec(MIGRATION_0002);

  const wrap = (sql: string, bound: unknown[] = []) => ({
    bind: (...values: unknown[]) => wrap(sql, values),
    first: async <T>() => (raw.prepare(sql).get(...(bound as never[])) as T) ?? null,
    all: async <T>() => ({ results: raw.prepare(sql).all(...(bound as never[])) as T[] }),
    run: async () => raw.prepare(sql).run(...(bound as never[])),
  });

  return {
    prepare: (sql: string) => wrap(sql) as unknown as ReturnType<Db['prepare']>,
    batch: async (statements) => {
      const out: unknown[] = [];
      for (const s of statements) out.push(await (s as unknown as { run(): Promise<unknown> }).run());
      return out;
    },
    _raw: raw,
  } as Db & { _raw: DatabaseSync };
}

const available = (() => {
  try {
    new DatabaseSync(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();
const d = available ? describe : describe.skip;

const article = (over: Partial<ArticleRecord> & { id: string }): ArticleRecord => ({
  slug: over.id,
  canonicalUrl: `https://thehindu.com/${over.id}`,
  originalUrl: `https://thehindu.com/${over.id}`,
  title: `Story ${over.id}`,
  summary: 'Publisher summary',
  imageUrl: null,
  publisherName: 'The Hindu',
  category: 'top',
  language: 'en',
  publishedAt: '2026-08-08T10:00:00Z',
  providerId: 'rss',
  ...over,
});

const cluster = (over: Partial<StoryClusterRecord> & { id: string }): StoryClusterRecord => ({
  headline: `Story ${over.id}`,
  category: 'top',
  language: 'en',
  articleCount: 2,
  sourceCount: 2,
  trendingScore: 0,
  firstSeenAt: '2026-08-08T10:00:00Z',
  lastSeenAt: '2026-08-08T10:00:00Z',
  ...over,
});

d('binding guard', () => {
  it('turns an absent database into a controlled 503, not a crash', () => {
    try {
      requireDbBinding({});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('UPSTREAM_UNAVAILABLE');
      expect((err as ApiError).status).toBe(503);
      // Names no binding, path or account detail.
      expect((err as ApiError).message).not.toMatch(/NEWZ_DB|wrangler|d1|binding/i);
    }
  });

  it('returns the database when present', () => {
    const db = makeDb();
    expect(requireDbBinding({ NEWZ_DB: db })).toBe(db);
  });
});

d('toApiArticle', () => {
  it('projects a row onto the public shape', () => {
    const out = toApiArticle(
      article({ id: 'a1', imageUrl: 'https://cdn.x.com/1.jpg', clusterId: 'c1' }),
    );

    expect(out).toEqual({
      id: 'a1',
      slug: 'a1',
      title: 'Story a1',
      summary: 'Publisher summary',
      url: 'https://thehindu.com/a1',
      imageUrl: 'https://cdn.x.com/1.jpg',
      source: 'The Hindu',
      category: 'top',
      language: 'en',
      publishedAt: '2026-08-08T10:00:00Z',
      clusterId: 'c1',
    });
  });

  // Ingestion bookkeeping is not part of the public contract.
  it('does not leak internal columns', () => {
    const out = toApiArticle(article({ id: 'a1', sourceId: 'src-1' })) as unknown as Record<
      string,
      unknown
    >;
    expect(out.sourceId).toBeUndefined();
    expect(out.providerId).toBeUndefined();
    expect(out.originalUrl).toBeUndefined();
  });

  it('keeps an unknown publication date null', () => {
    expect(toApiArticle(article({ id: 'a1', publishedAt: null })).publishedAt).toBeNull();
  });
});

d('/api/v1/news data path', () => {
  let db: Db & { _raw: DatabaseSync };
  let repo: ArticleRepository;

  beforeEach(async () => {
    db = makeDb();
    repo = new ArticleRepository(db);
    for (let i = 1; i <= 5; i += 1) {
      await repo.insertIfNew(
        article({ id: `a${i}`, publishedAt: `2026-08-0${i}T10:00:00Z` }),
      );
    }
  });

  it('returns newest first, deterministically', async () => {
    const page = await repo.pageByCategory('top', 'en', { limit: 10 });
    expect(page.items.map((a) => a.id)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1']);
  });

  it('omits the cursor on the final page', async () => {
    const page = await repo.pageByCategory('top', 'en', { limit: 10 });
    expect(page.cursor).toBeUndefined();
  });

  it('walks pages without repeating or dropping rows', async () => {
    const seen: string[] = [];
    let cursor = null as ReturnType<typeof decodeCursor>;

    for (let guard = 0; guard < 10; guard += 1) {
      const page = await repo.pageByCategory('top', 'en', { limit: 2, cursor });
      seen.push(...page.items.map((a) => a.id));
      if (!page.cursor) break;
      cursor = decodeCursor(page.cursor);
    }

    expect(seen).toEqual(['a5', 'a4', 'a3', 'a2', 'a1']);
  });

  it('returns an empty page rather than failing for an empty category', async () => {
    const page = await repo.pageByCategory('sports', 'en', { limit: 10 });
    expect(page.items).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });

  // A forged cursor reaches the query only as bound parameters.
  it('treats a forged cursor as data', async () => {
    const page = await repo.pageByCategory('top', 'en', {
      limit: 10,
      cursor: { sortValue: "' OR 1=1 --", id: "'; DROP TABLE articles;--" },
    });
    expect(Array.isArray(page.items)).toBe(true);
    expect(
      (db._raw.prepare('SELECT COUNT(*) c FROM articles').get() as { c: number }).c,
    ).toBe(5);
  });
});

d('/api/v1/search data path', () => {
  let db: Db & { _raw: DatabaseSync };
  let repo: ArticleRepository;

  beforeEach(async () => {
    db = makeDb();
    repo = new ArticleRepository(db);
    await repo.insertIfNew(
      article({ id: 'a1', title: 'Monsoon floods Kerala', publishedAt: '2026-08-01T10:00:00Z' }),
    );
    await repo.insertIfNew(
      article({
        id: 'a2',
        title: 'Monsoon session begins',
        category: 'politics',
        publishedAt: '2026-08-02T10:00:00Z',
      }),
    );
    await repo.insertIfNew(
      article({ id: 'a3', title: 'Cricket final', publishedAt: '2026-08-03T10:00:00Z' }),
    );
  });

  it('finds matching articles', async () => {
    const page = await repo.searchPage('monsoon', { limit: 10 });
    expect(page.items.map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('orders by recency, giving a total order', async () => {
    const page = await repo.searchPage('monsoon', { limit: 10 });
    expect(page.items.map((a) => a.id)).toEqual(['a2', 'a1']);
  });

  it('filters by category', async () => {
    const page = await repo.searchPage('monsoon', { category: 'politics', limit: 10 });
    expect(page.items.map((a) => a.id)).toEqual(['a2']);
  });

  it('filters by language', async () => {
    expect((await repo.searchPage('monsoon', { language: 'hi', limit: 10 })).items).toEqual([]);
    expect((await repo.searchPage('monsoon', { language: 'en', limit: 10 })).items).toHaveLength(2);
  });

  it('paginates search results', async () => {
    const first = await repo.searchPage('monsoon', { limit: 1 });
    expect(first.items.map((a) => a.id)).toEqual(['a2']);
    expect(first.cursor).toBeTruthy();

    const second = await repo.searchPage('monsoon', {
      limit: 1,
      cursor: decodeCursor(first.cursor),
    });
    expect(second.items.map((a) => a.id)).toEqual(['a1']);
    expect(second.cursor).toBeUndefined();
  });

  it('returns empty for no matches', async () => {
    expect((await repo.searchPage('zebra', { limit: 10 })).items).toEqual([]);
  });

  /** FTS5 MATCH is a query language. Unescaped, these either throw a syntax
   *  error or silently change the query. */
  it('never lets an FTS operator change or break the query', async () => {
    for (const q of ['"', '""', '*', '-', 'a OR b', 'x AND y', '(', 'foo*', 'NEAR(a b)', '^']) {
      await expect(repo.searchPage(q, { limit: 10 })).resolves.toBeDefined();
    }
  });

  it('treats SQL metacharacters in a query as text', async () => {
    await expect(
      repo.searchPage("'; DROP TABLE articles;--", { limit: 10 }),
    ).resolves.toBeDefined();
    expect(
      (db._raw.prepare('SELECT COUNT(*) c FROM articles').get() as { c: number }).c,
    ).toBe(3);
  });
});

d('/api/v1/ticker data path', () => {
  it('returns the newest headlines, undated last', async () => {
    const db = makeDb();
    const repo = new ArticleRepository(db);

    await repo.insertIfNew(article({ id: 'old', publishedAt: '2026-08-01T10:00:00Z' }));
    await repo.insertIfNew(article({ id: 'new', publishedAt: '2026-08-09T10:00:00Z' }));
    await repo.insertIfNew(article({ id: 'undated', publishedAt: null }));

    expect((await repo.listRecent(10)).map((a) => a.id)).toEqual(['new', 'old', 'undated']);
  });

  it('bounds the limit', async () => {
    const db = makeDb();
    const repo = new ArticleRepository(db);
    await repo.insertIfNew(article({ id: 'a1' }));
    expect(await repo.listRecent(10_000)).toHaveLength(1);
  });
});

describe('/api/v1/trending ranking', () => {
  const NOW = Date.parse('2026-08-09T12:00:00Z');
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

  it('scores breadth sub-linearly', () => {
    const two = trendingScore(cluster({ id: 'a', sourceCount: 2, lastSeenAt: at(0) }), NOW);
    const four = trendingScore(cluster({ id: 'b', sourceCount: 4, lastSeenAt: at(0) }), NOW);

    expect(four).toBeGreaterThan(two);
    // log2(5)/log2(3) ~= 1.46, not the 2x a linear term would give.
    expect(four / two).toBeLessThan(2);
  });

  it('halves the score every 12 hours', () => {
    const fresh = trendingScore(cluster({ id: 'a', sourceCount: 4, lastSeenAt: at(0) }), NOW);
    const older = trendingScore(cluster({ id: 'b', sourceCount: 4, lastSeenAt: at(12) }), NOW);
    expect(older).toBeCloseTo(fresh / 2, 6);
  });

  it('clamps a future timestamp instead of scoring above everything', () => {
    const future = trendingScore(cluster({ id: 'a', sourceCount: 4, lastSeenAt: at(-48) }), NOW);
    const now = trendingScore(cluster({ id: 'b', sourceCount: 4, lastSeenAt: at(0) }), NOW);
    expect(future).toBeCloseTo(now, 6);
  });

  it('scores an unparseable timestamp 0 rather than NaN', () => {
    expect(trendingScore(cluster({ id: 'a', lastSeenAt: 'garbage' }), NOW)).toBe(0);
  });

  // A story covered by one outlet is one article, not a trend.
  it('excludes single-source stories', () => {
    const ranked = rankTrending(
      [
        cluster({ id: 'solo', sourceCount: 1, lastSeenAt: at(0) }),
        cluster({ id: 'broad', sourceCount: 3, lastSeenAt: at(0) }),
      ],
      NOW,
      10,
    );
    expect(ranked.map((s) => s.id)).toEqual(['broad']);
  });

  it('prefers breadth at equal recency', () => {
    const ranked = rankTrending(
      [
        cluster({ id: 'narrow', sourceCount: 2, lastSeenAt: at(1) }),
        cluster({ id: 'wide', sourceCount: 8, lastSeenAt: at(1) }),
      ],
      NOW,
      10,
    );
    expect(ranked.map((s) => s.id)).toEqual(['wide', 'narrow']);
  });

  it('prefers recency at equal breadth', () => {
    const ranked = rankTrending(
      [
        cluster({ id: 'stale', sourceCount: 4, lastSeenAt: at(36) }),
        cluster({ id: 'fresh', sourceCount: 4, lastSeenAt: at(1) }),
      ],
      NOW,
      10,
    );
    expect(ranked.map((s) => s.id)).toEqual(['fresh', 'stale']);
  });

  /** Ranking on article_count would reward syndication: four outlets running
   *  one wire story are four rows from one newsroom. */
  it('does not rank on article count', () => {
    const ranked = rankTrending(
      [
        cluster({ id: 'syndicated', sourceCount: 2, articleCount: 50, lastSeenAt: at(1) }),
        cluster({ id: 'independent', sourceCount: 6, articleCount: 6, lastSeenAt: at(1) }),
      ],
      NOW,
      10,
    );
    expect(ranked.map((s) => s.id)).toEqual(['independent', 'syndicated']);
  });

  it('is deterministic across repeated calls', () => {
    const input = [
      cluster({ id: 'a', sourceCount: 3, lastSeenAt: at(2) }),
      cluster({ id: 'b', sourceCount: 3, lastSeenAt: at(2) }),
      cluster({ id: 'c', sourceCount: 5, lastSeenAt: at(9) }),
    ];
    const once = rankTrending(input, NOW, 10).map((s) => s.id);
    for (let i = 0; i < 5; i += 1) {
      expect(rankTrending([...input].reverse(), NOW, 10).map((s) => s.id)).toEqual(once);
    }
  });

  // Without a total order, two equally-scored stories could swap between calls.
  it('breaks exact ties by id, not by input order', () => {
    const tied = [
      cluster({ id: 'zzz', sourceCount: 3, lastSeenAt: at(2) }),
      cluster({ id: 'aaa', sourceCount: 3, lastSeenAt: at(2) }),
    ];
    expect(rankTrending(tied, NOW, 10).map((s) => s.id)).toEqual(['aaa', 'zzz']);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      cluster({ id: `c${i}`, sourceCount: 3, lastSeenAt: at(i) }),
    );
    expect(rankTrending(many, NOW, 5)).toHaveLength(5);
  });

  it('returns an empty list rather than failing when nothing qualifies', () => {
    expect(rankTrending([], NOW, 10)).toEqual([]);
    expect(rankTrending([cluster({ id: 'solo', sourceCount: 1 })], NOW, 10)).toEqual([]);
  });
});
