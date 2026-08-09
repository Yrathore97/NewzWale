/** /api/v1/news/[slug] (P5, AD-09) is a thin wrapper — findBySlug +
 *  listByCluster + listByArticle, then an envelope. The route file itself
 *  cannot be imported under vitest (it imports `env` from
 *  'cloudflare:workers', which only resolves inside a Worker — the same
 *  constraint that already applied to /api/factcheck.ts before P5, and the
 *  reason no existing test imports a route module directly). This file tests
 *  the composition those three calls perform, executed against real SQLite
 *  running both real migrations, which is what the route's logic actually
 *  is. */

import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_0001 from '../../src/lib/db/migrations/0001_init.sql?raw';
import MIGRATION_0002 from '../../src/lib/db/migrations/0002_nullable_published_at.sql?raw';
import { DatabaseSync } from 'node:sqlite';
import {
  ArticleRepository,
  StoryClusterRepository,
  type ArticleRecord,
} from '../../src/lib/db/repositories/articles';
import { FactCheckRepository, type FactCheckWithEvidence } from '../../src/lib/db/repositories/fact-checks';
import { toApiArticle } from '../../src/lib/news/read';
import type { Db } from '../../src/lib/db/client';

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

const article = (id: string, over: Partial<ArticleRecord> = {}): ArticleRecord => ({
  id,
  slug: id,
  canonicalUrl: `https://x.com/${id}`,
  originalUrl: `https://x.com/${id}`,
  title: `Story ${id}`,
  summary: "Publisher's own summary",
  publisherName: 'The Hindu',
  category: 'top',
  language: 'en',
  publishedAt: '2026-08-08T10:00:00Z',
  providerId: 'rss',
  ...over,
});

/** Reproduces exactly what src/pages/api/v1/news/[slug].ts computes. */
async function loadStory(db: Db, slug: string) {
  const articles = new ArticleRepository(db);
  const article = await articles.findBySlug(slug);
  if (!article) return null;

  const [coverage, factChecks] = await Promise.all([
    article.clusterId ? articles.listByCluster(article.clusterId, article.id) : Promise.resolve([]),
    new FactCheckRepository(db).listByArticle(article.id),
  ]);

  return { article: toApiArticle(article), coverage: coverage.map(toApiArticle), factChecks };
}

d('/api/v1/news/[slug] composition (AD-09)', () => {
  let db: Db & { _raw: DatabaseSync };
  beforeEach(() => {
    db = makeDb();
  });

  it('returns null for an unknown slug rather than throwing', async () => {
    expect(await loadStory(db, 'no-such-story')).toBeNull();
  });

  it('resolves a story with no coverage and no linked fact-checks — the common case', async () => {
    await new ArticleRepository(db).insertIfNew(article('a1'));
    const story = await loadStory(db, 'a1');

    expect(story?.article.title).toBe('Story a1');
    // AD-09: the publisher's summary, quoted verbatim, never rewritten.
    expect(story?.article.summary).toBe("Publisher's own summary");
    expect(story?.coverage).toEqual([]);
    expect(story?.factChecks).toEqual([]);
  });

  it('includes other articles in the same cluster as "also reported by", excluding itself', async () => {
    const articles = new ArticleRepository(db);
    const clusters = new StoryClusterRepository(db);
    await clusters.upsert({
      id: 'c1',
      headline: 'ISRO launch',
      category: 'top',
      language: 'en',
      articleCount: 2,
      sourceCount: 2,
      trendingScore: 0,
      firstSeenAt: '2026-08-08T10:00:00Z',
      lastSeenAt: '2026-08-08T10:00:00Z',
    });
    await articles.insertIfNew(article('a1', { clusterId: 'c1' }));
    await articles.insertIfNew(article('a2', { clusterId: 'c1', publisherName: 'NDTV' }));

    const story = await loadStory(db, 'a1');
    expect(story?.coverage.map((c) => c.id)).toEqual(['a2']);
    expect(story?.coverage.every((c) => c.id !== 'a1')).toBe(true);
  });

  it('links fact-checks submitted from this article, most recent first', async () => {
    await new ArticleRepository(db).insertIfNew(article('a1'));
    const factChecks = new FactCheckRepository(db);
    const sample = (id: string, checkedAt: string): FactCheckWithEvidence => ({
      factCheck: {
        id,
        claim: `Claim ${id}`,
        claimNormalized: `claim ${id}`,
        claimSource: 'url',
        verdict: 'true',
        evidenceStrength: 'moderate',
        basis: 'ai_assessment',
        summary: 's',
        reasoning: 'r',
        independentSupportingDomains: 1,
        independentContradictingDomains: 0,
        pipelineVersion: 4,
        evidenceVersion: 3,
        articleId: 'a1',
        checkedAt,
      },
      evidence: [],
    });
    await factChecks.create(sample('fc1', '2026-08-08T09:00:00Z'));
    await factChecks.create(sample('fc2', '2026-08-08T10:00:00Z'));

    const story = await loadStory(db, 'a1');
    expect(story?.factChecks.map((f) => f.id)).toEqual(['fc2', 'fc1']);
  });

  it('never fetches article content or invents a body — only the persisted summary', async () => {
    await new ArticleRepository(db).insertIfNew(article('a1', { summary: null }));
    const story = await loadStory(db, 'a1');
    // Absent stays absent. No fallback text is manufactured.
    expect(story?.article.summary).toBeNull();
  });
});
