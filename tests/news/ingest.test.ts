/** Ingestion against a real SQLite database running the real migration.
 *
 *  Executable, not string-matched: the append-only triggers, UNIQUE
 *  constraints, foreign keys and FTS sync triggers all participate, so a
 *  repository that writes the wrong column fails here rather than in
 *  production. Same adapter approach as tests/db/repositories.test.ts. */

import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_SQL from '../../src/lib/db/migrations/0001_init.sql?raw';
import MIGRATION_0002 from '../../src/lib/db/migrations/0002_nullable_published_at.sql?raw';
import { DatabaseSync } from 'node:sqlite';
import { ingest, harvest, normalize, publishedAtIso } from '../../src/lib/news/ingest';
import type { NewsProvider } from '../../src/lib/news/providers';
import type { Article } from '../../src/lib/news/types';
import {
  ArticleRepository,
  SourceRepository,
  StoryClusterRepository,
} from '../../src/lib/db/repositories/articles';
import type { Db } from '../../src/lib/db/client';

function makeDb(): Db & { _raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(MIGRATION_SQL);
  // Tests run the schema as production has it: both migrations applied.
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

function article(over: Partial<Article> = {}): Article {
  return {
    id: 'x',
    title: 'ISRO launches Chandrayaan-4 mission successfully',
    url: 'https://thehindu.com/isro-launch',
    summary: 'Publisher summary',
    imageUrl: 'https://cdn.thehindu.com/1.jpg',
    source: 'The Hindu',
    category: 'top',
    publishedAt: '2026-08-08T10:00:00Z',
    ...over,
  };
}

/** Provider stub. `fail` makes it throw, which is how isolation is tested. */
function stubProvider(id: string, articles: Article[], fail = false): NewsProvider {
  return {
    id,
    paginated: false,
    multilingual: true,
    isConfigured: () => true,
    async fetchPage() {
      if (fail) throw new Error(`${id}: upstream 500 https://api.example.com/?apikey=SECRET`);
      return { articles, nextPage: null };
    },
  };
}

const count = (db: Db & { _raw: DatabaseSync }, table: string) =>
  (db._raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

d('publishedAtIso', () => {
  it('normalises a parseable date to ISO-8601', () => {
    expect(publishedAtIso('Fri, 08 Aug 2026 10:00:00 GMT')).toBe('2026-08-08T10:00:00.000Z');
  });

  // The whole point: an unknown date stays unknown. Substituting the fetch
  // time would invent a publication date.
  it('returns null for an unreadable or absent date', () => {
    expect(publishedAtIso('')).toBeNull();
    expect(publishedAtIso(null)).toBeNull();
    expect(publishedAtIso('not a date')).toBeNull();
  });
});

d('normalize', () => {
  it('maps a provider article onto the durable row', async () => {
    const out = await normalize(article(), 'rss', { category: 'top', language: 'en' });
    expect('record' in out).toBe(true);
    if (!('record' in out)) return;

    expect(out.record.canonicalUrl).toBe('https://thehindu.com/isro-launch');
    expect(out.record.publisherName).toBe('The Hindu');
    expect(out.record.imageUrl).toBe('https://cdn.thehindu.com/1.jpg');
    expect(out.record.providerId).toBe('rss');
    expect(out.domain).toBe('thehindu.com');
  });

  it('skips an unsafe URL', async () => {
    const out = await normalize(article({ url: 'javascript:alert(1)' }), 'rss', {
      category: 'top',
      language: 'en',
    });
    expect(out).toEqual({ skip: 'invalid' });
  });

  it('skips an empty title', async () => {
    const out = await normalize(article({ title: '   ' }), 'rss', { category: 'top', language: 'en' });
    expect(out).toEqual({ skip: 'invalid' });
  });

  // Since migration 0002 an unknown date is carried as null, not a reason to
  // discard the article. It is still never invented.
  it('carries an unknown publication date through as null', async () => {
    const out = await normalize(article({ publishedAt: '' }), 'rss', {
      category: 'top',
      language: 'en',
    });
    if (!('record' in out)) throw new Error('expected a record, not a skip');
    expect(out.record.publishedAt).toBeNull();
    expect(out.record.title).toBeTruthy();
  });

  // P-17: the card must carry OUR category, not the provider's raw value.
  it('falls back to our category when the provider sends an unknown one', async () => {
    const out = await normalize(article({ category: 'weird-upstream-value' }), 'rss', {
      category: 'business',
      language: 'en',
    });
    if (!('record' in out)) throw new Error('expected a record');
    expect(out.record.category).toBe('business');
  });
});

d('harvest — provider isolation', () => {
  it('keeps results from providers that succeeded when one fails', async () => {
    const { harvests, failures } = await harvest({}, {}, [
      stubProvider('newsdata', [], true),
      stubProvider('guardian', [article({ url: 'https://g.com/1' })]),
      stubProvider('rss', [article({ url: 'https://r.com/1' })]),
    ]);

    expect(harvests.map((h) => h.providerId).sort()).toEqual(['guardian', 'rss']);
    expect(failures.map((f) => f.providerId)).toEqual(['newsdata']);
  });

  it('keeps the one survivor when the others fail', async () => {
    const { harvests, failures } = await harvest({}, {}, [
      stubProvider('newsdata', [article({ url: 'https://n.com/1' })]),
      stubProvider('guardian', [], true),
      stubProvider('rss', [], true),
    ]);

    expect(harvests.map((h) => h.providerId)).toEqual(['newsdata']);
    expect(failures).toHaveLength(2);
  });

  // Provider errors embed the request URL, which carries the API key.
  it('strips URLs from failure reasons so a key cannot leak', async () => {
    const { failures } = await harvest({}, {}, [stubProvider('newsdata', [], true)]);
    expect(failures[0].reason).not.toContain('SECRET');
    expect(failures[0].reason).not.toContain('api.example.com');
    expect(failures[0].reason).toContain('[url]');
  });

  it('skips unconfigured providers without calling them', async () => {
    let called = false;
    const unconfigured: NewsProvider = {
      id: 'newsdata',
      paginated: true,
      multilingual: true,
      isConfigured: () => false,
      async fetchPage() {
        called = true;
        return { articles: [], nextPage: null };
      },
    };
    const { harvests } = await harvest({}, {}, [unconfigured, stubProvider('rss', [article()])]);
    expect(called).toBe(false);
    expect(harvests.map((h) => h.providerId)).toEqual(['rss']);
  });
});

d('ingest', () => {
  let db: Db & { _raw: DatabaseSync };
  beforeEach(() => {
    db = makeDb();
  });

  it('persists articles, sources and clusters', async () => {
    const summary = await ingest(db, {}, { providers: [stubProvider('rss', [article()])] });

    expect(summary).toMatchObject({ fetched: 1, persisted: 1, deduplicated: 0, clustered: 1 });
    expect(count(db, 'articles')).toBe(1);
    expect(count(db, 'sources')).toBe(1);
    expect(count(db, 'story_clusters')).toBe(1);
  });

  it('reads back what it wrote', async () => {
    await ingest(db, {}, { providers: [stubProvider('rss', [article()])] });

    const repo = new ArticleRepository(db);
    const found = await repo.findByCanonicalUrl('https://thehindu.com/isro-launch');
    expect(found?.title).toBe('ISRO launches Chandrayaan-4 mission successfully');
    expect(found?.imageUrl).toBe('https://cdn.thehindu.com/1.jpg');
    expect(found?.clusterId).not.toBeNull();
  });

  // Tracking-parameter variants of one story must be ONE row.
  it('deduplicates canonical-URL variants within a run', async () => {
    const summary = await ingest(
      db,
      {},
      {
        providers: [
          stubProvider('rss', [
            article({ url: 'https://thehindu.com/isro-launch' }),
            article({ url: 'https://www.thehindu.com/isro-launch/?utm_source=twitter' }),
            article({ url: 'https://thehindu.com/isro-launch#top' }),
          ]),
        ],
      },
    );

    expect(summary.fetched).toBe(3);
    expect(summary.persisted).toBe(1);
    expect(summary.deduplicated).toBe(2);
    expect(count(db, 'articles')).toBe(1);
  });

  it('persists an undated article with published_at NULL', async () => {
    const summary = await ingest(
      db,
      {},
      { providers: [stubProvider('rss', [article({ publishedAt: 'garbage' })])] },
    );

    // Kept, not discarded — the article is valid, only its metadata is thin.
    expect(summary.persisted).toBe(1);
    expect(summary.undatedArticles).toBe(1);
    expect(count(db, 'articles')).toBe(1);

    const stored = await new ArticleRepository(db).findByCanonicalUrl(
      'https://thehindu.com/isro-launch',
    );
    expect(stored?.publishedAt).toBeNull();
  });

  // The whole reason the column is nullable rather than defaulted.
  it('never substitutes the ingestion time for an unknown publication date', async () => {
    await ingest(db, {}, { providers: [stubProvider('rss', [article({ publishedAt: '' })])] });

    const row = db._raw
      .prepare('SELECT published_at, ingested_at FROM articles WHERE id IS NOT NULL')
      .get() as { published_at: unknown; ingested_at: unknown };

    expect(row.published_at).toBeNull();
    expect(typeof row.ingested_at).toBe('string');
  });

  it('an undated article opens its own cluster rather than merging on title alone', async () => {
    await ingest(
      db,
      {},
      {
        providers: [
          stubProvider('rss', [
            article({ url: 'https://a.com/1', publishedAt: '2026-08-08T10:00:00Z' }),
            article({ url: 'https://b.com/2', publishedAt: '' }),
          ]),
        ],
      },
    );

    // Same headline, but without a date the time window cannot be applied, so
    // the two are not asserted to be one story.
    expect(count(db, 'story_clusters')).toBe(2);
  });

  it('persists surviving providers when one throws', async () => {
    const summary = await ingest(
      db,
      {},
      {
        providers: [
          stubProvider('newsdata', [], true),
          stubProvider('guardian', [article({ url: 'https://guardian.com/1', source: 'Guardian' })]),
          stubProvider('rss', [article({ url: 'https://ndtv.com/1', source: 'NDTV' })]),
        ],
      },
    );

    expect(summary.persisted).toBe(2);
    expect(summary.failedProviders.map((f) => f.providerId)).toEqual(['newsdata']);
    expect(count(db, 'articles')).toBe(2);
    expect(count(db, 'sources')).toBe(2);
  });

  describe('idempotency', () => {
    const run = () =>
      ingest(
        db,
        {},
        {
          providers: [
            stubProvider('rss', [
              article({ url: 'https://thehindu.com/a', title: 'ISRO launches Chandrayaan-4 mission' }),
              article({ url: 'https://ndtv.com/b', title: 'Chennai floods displace thousands', source: 'NDTV' }),
            ]),
          ],
        },
      );

    it('a second identical run writes nothing new', async () => {
      const first = await run();
      const articlesAfterFirst = count(db, 'articles');
      const sourcesAfterFirst = count(db, 'sources');
      const clustersAfterFirst = count(db, 'story_clusters');

      const second = await run();

      expect(first.persisted).toBe(2);
      expect(second.persisted).toBe(0);
      expect(second.deduplicated).toBe(2);

      expect(count(db, 'articles')).toBe(articlesAfterFirst);
      expect(count(db, 'sources')).toBe(sourcesAfterFirst);
      expect(count(db, 'story_clusters')).toBe(clustersAfterFirst);
    });

    it('article identity is stable across runs', async () => {
      await run();
      const repo = new ArticleRepository(db);
      const before = await repo.findByCanonicalUrl('https://thehindu.com/a');

      await run();
      const after = await repo.findByCanonicalUrl('https://thehindu.com/a');

      expect(after?.id).toBe(before?.id);
      expect(after?.slug).toBe(before?.slug);
      expect(after?.clusterId).toBe(before?.clusterId);
    });

    // News rows may gain a cluster; fact-check rows must never be touched by
    // a news run. The append-only triggers would abort if they were.
    it('does not disturb fact-check records', async () => {
      db._raw.exec(`
        INSERT INTO fact_checks (
          id, claim, claim_normalized, verdict, evidence_strength, basis,
          summary, reasoning, pipeline_version, evidence_version
        ) VALUES ('fc1','c','c','true','moderate','ai_assessment','s','r',4,3);
      `);

      await run();
      await run();

      const row = db._raw.prepare('SELECT verdict, summary FROM fact_checks WHERE id = ?').get('fc1');
      expect(row).toMatchObject({ verdict: 'true', summary: 's' });
      expect(count(db, 'fact_checks')).toBe(1);
    });
  });

  describe('clustering', () => {
    it('puts two reports of one event in the same cluster', async () => {
      await ingest(
        db,
        {},
        {
          providers: [
            stubProvider('rss', [
              article({
                url: 'https://thehindu.com/a',
                title: 'ISRO launches Chandrayaan-4 mission successfully',
                source: 'The Hindu',
              }),
              article({
                url: 'https://ndtv.com/b',
                title: 'ISRO successfully launches Chandrayaan-4 lunar mission',
                source: 'NDTV',
                publishedAt: '2026-08-08T11:00:00Z',
              }),
            ]),
          ],
        },
      );

      expect(count(db, 'story_clusters')).toBe(1);

      const repo = new ArticleRepository(db);
      const a = await repo.findByCanonicalUrl('https://thehindu.com/a');
      const b = await repo.findByCanonicalUrl('https://ndtv.com/b');
      expect(a?.clusterId).toBe(b?.clusterId);

      // Two independent publishers, counted from the rows rather than incremented.
      const cluster = await new StoryClusterRepository(db).findById(a!.clusterId!);
      expect(cluster?.articleCount).toBe(2);
      expect(cluster?.sourceCount).toBe(2);
    });

    it('keeps unrelated stories in separate clusters', async () => {
      await ingest(
        db,
        {},
        {
          providers: [
            stubProvider('rss', [
              article({ url: 'https://a.com/1', title: 'ISRO launches Chandrayaan-4 mission successfully' }),
              article({ url: 'https://b.com/2', title: 'Chennai floods displace thousands as rains continue' }),
            ]),
          ],
        },
      );
      expect(count(db, 'story_clusters')).toBe(2);
    });

    // The over-merge guard, end to end.
    it('does not merge headlines sharing only generic words', async () => {
      await ingest(
        db,
        {},
        {
          providers: [
            stubProvider('rss', [
              article({ url: 'https://a.com/1', title: 'PM inaugurates Delhi metro line today' }),
              article({ url: 'https://b.com/2', title: 'PM addresses Delhi rally today' }),
            ]),
          ],
        },
      );
      expect(count(db, 'story_clusters')).toBe(2);
    });

    it('collapses outlets sharing an owner into one independent source', async () => {
      // Both publishers belong to one group, so they are not independent
      // corroboration even though they are two rows.
      const sources = new SourceRepository(db);
      const { canonicalIdentity } = await import('../../src/lib/news/canonical');
      const one = await canonicalIdentity('https://ndtv.com/b', 't');
      const two = await canonicalIdentity('https://gadgets360.com/c', 't');
      await sources.upsert({
        id: one!.sourceId,
        domain: 'ndtv.com',
        displayName: 'NDTV',
        tier: 'tier3',
        ownerGroup: 'adani',
      });
      await sources.upsert({
        id: two!.sourceId,
        domain: 'gadgets360.com',
        displayName: 'Gadgets360',
        tier: 'tier3',
        ownerGroup: 'adani',
      });

      await ingest(
        db,
        {},
        {
          providers: [
            stubProvider('rss', [
              article({
                url: 'https://ndtv.com/b',
                title: 'ISRO launches Chandrayaan-4 mission successfully',
              }),
              article({
                url: 'https://gadgets360.com/c',
                title: 'ISRO successfully launches Chandrayaan-4 lunar mission',
                publishedAt: '2026-08-08T11:00:00Z',
              }),
            ]),
          ],
        },
      );

      const repo = new ArticleRepository(db);
      const a = await repo.findByCanonicalUrl('https://ndtv.com/b');
      const cluster = await new StoryClusterRepository(db).findById(a!.clusterId!);

      expect(cluster?.articleCount).toBe(2);
      // Two articles, ONE independent source.
      expect(cluster?.sourceCount).toBe(1);
    });
  });

  describe('curated source metadata', () => {
    /** Ingestion discovers publishers; it does not curate them.
     *
     *  If ingestion used `upsert`, every scheduled run would push its only
     *  known value — tier3 — over a curated tier, and blank owner_group. A
     *  tier1 primary source would silently become tier3 and verdicts resting
     *  on it would weaken, with nothing in the logs. */
    it('does not downgrade a curated tier or blank an owner group', async () => {
      const { canonicalIdentity } = await import('../../src/lib/news/canonical');
      const identity = await canonicalIdentity('https://thehindu.com/isro-launch', 't');

      await new SourceRepository(db).upsert({
        id: identity!.sourceId,
        domain: 'thehindu.com',
        displayName: 'The Hindu',
        tier: 'tier1',
        ownerGroup: 'kasturi',
        ifcnSignatory: true,
      });

      await ingest(db, {}, { providers: [stubProvider('rss', [article()])] });

      const after = await new SourceRepository(db).findByDomain('thehindu.com');
      expect(after?.tier).toBe('tier1');
      expect(after?.ownerGroup).toBe('kasturi');
      expect(after?.ifcnSignatory).toBe(true);
    });

    it('registers an unknown publisher at the conservative default tier', async () => {
      await ingest(db, {}, { providers: [stubProvider('rss', [article()])] });
      const created = await new SourceRepository(db).findByDomain('thehindu.com');
      expect(created?.tier).toBe('tier3');
      expect(created?.displayName).toBe('The Hindu');
    });
  });

  describe('security', () => {
    // Titles and URLs are attacker-influenced. They are bound as parameters,
    // never concatenated, so SQL metacharacters are stored as data.
    it('treats SQL metacharacters in a title as data', async () => {
      const nasty = "Robert'); DROP TABLE articles;-- launches Chandrayaan mission";
      await ingest(db, {}, { providers: [stubProvider('rss', [article({ title: nasty })])] });

      expect(count(db, 'articles')).toBe(1);
      const repo = new ArticleRepository(db);
      const found = await repo.findByCanonicalUrl('https://thehindu.com/isro-launch');
      expect(found?.title).toBe(nasty);
    });

    it('treats SQL metacharacters in a publisher name as data', async () => {
      await ingest(
        db,
        {},
        { providers: [stubProvider('rss', [article({ source: "'; DELETE FROM sources;--" })])] },
      );
      expect(count(db, 'sources')).toBe(1);
    });

    it('requires a database rather than silently doing nothing', async () => {
      await expect(ingest(undefined, {})).rejects.toThrow(/database binding/i);
    });
  });
});
