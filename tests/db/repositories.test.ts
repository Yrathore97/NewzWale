import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_SQL from '../../src/lib/db/migrations/0001_init.sql?raw';
import { DatabaseSync } from 'node:sqlite';
import {
  FactCheckRepository,
  type FactCheckWithEvidence,
} from '../../src/lib/db/repositories/fact-checks';
import {
  ArticleRepository,
  SourceRepository,
  StoryClusterRepository,
} from '../../src/lib/db/repositories/articles';
import { DbUnavailableError, hasDb, contentId, type Db } from '../../src/lib/db/client';

/** Adapts node:sqlite to the D1 prepared-statement surface the repositories
 *  expect, so they can be tested without a Worker.
 *
 *  The schema itself is separately verified against REAL D1 via
 *  `wrangler d1 execute --local` (see the header of 0001_init.sql). This
 *  adapter tests the repository SQL, not D1 compatibility. */
function makeDb(): Db & { _raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(MIGRATION_SQL);

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

function sampleCheck(id = 'fc1'): FactCheckWithEvidence {
  return {
    factCheck: {
      id,
      claim: 'RBI held the repo rate at 6.5%.',
      claimNormalized: 'rbi held the repo rate at 6.5%.',
      claimSource: 'text',
      verdict: 'true',
      evidenceStrength: 'moderate',
      basis: 'ai_assessment',
      summary: 'The rate was held.',
      reasoning: 'Two independent sources [1][2] report the pause.',
      limitations: 'Only two sources were available.',
      independentSupportingDomains: 2,
      independentContradictingDomains: 0,
      pipelineVersion: 1,
      evidenceVersion: 1,
      modelId: '@cf/meta/llama-3.1-8b-instruct-fp8',
    },
    evidence: [
      {
        id: `${id}-e1`,
        factCheckId: id,
        position: 1,
        url: 'https://thehindu.com/a',
        title: 'RBI holds rate',
        publisher: 'thehindu.com',
        tierAtCheck: 'tier2',
        publishedAt: '2026-08-04',
        stance: 'supporting',
        quotedPassage: 'The repo rate was left unchanged at 6.5%.',
        readMethod: 'full_page',
        injectionFlagged: false,
      },
      {
        id: `${id}-e2`,
        factCheckId: id,
        position: 2,
        url: 'https://rbi.org.in/press',
        title: 'Policy statement',
        publisher: 'rbi.org.in',
        tierAtCheck: 'tier1',
        // Genuinely unknown. Must stay null, never filled from accessedAt.
        publishedAt: null,
        stance: 'supporting',
        readMethod: 'search_snippet',
        injectionFlagged: false,
      },
    ],
  };
}

d('client helpers', () => {
  it('throws a legible error when the binding is missing', () => {
    expect(() => new FactCheckRepository(undefined)).toThrow(DbUnavailableError);
  });

  it('hasDb lets callers degrade instead of failing', () => {
    expect(hasDb(undefined)).toBe(false);
    expect(hasDb(makeDb())).toBe(true);
  });

  it('contentId is a stable sha256 hex digest', async () => {
    const a = await contentId('https://x.com/a');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await contentId('https://x.com/a'));
    expect(a).not.toBe(await contentId('https://x.com/b'));
  });
});

d('FactCheckRepository', () => {
  let db: Db;
  let repo: FactCheckRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new FactCheckRepository(db);
  });

  it('persists a check with its evidence and reads it back', async () => {
    await repo.create(sampleCheck());
    const found = await repo.findById('fc1');

    expect(found?.factCheck.verdict).toBe('true');
    expect(found?.factCheck.evidenceStrength).toBe('moderate');
    expect(found?.evidence).toHaveLength(2);
  });

  it('returns evidence in citation order', async () => {
    await repo.create(sampleCheck());
    const found = await repo.findById('fc1');
    expect(found?.evidence.map((e) => e.position)).toEqual([1, 2]);
  });

  // Principle 7. The two columns answer different questions and one must never
  // stand in for the other.
  it('preserves a null published_at rather than substituting accessed_at', async () => {
    await repo.create(sampleCheck());
    const found = await repo.findById('fc1');
    const undated = found!.evidence.find((e) => e.position === 2)!;

    expect(undated.publishedAt).toBeNull();
    expect(undated.accessedAt).toBeTruthy();
    expect(undated.publishedAt).not.toBe(undated.accessedAt);
  });

  it('keeps a known published_at intact', async () => {
    await repo.create(sampleCheck());
    const found = await repo.findById('fc1');
    expect(found!.evidence.find((e) => e.position === 1)!.publishedAt).toBe('2026-08-04');
  });

  it('records read method and injection flag per source', async () => {
    await repo.create(sampleCheck());
    const found = await repo.findById('fc1');
    expect(found!.evidence[0]!.readMethod).toBe('full_page');
    expect(found!.evidence[1]!.readMethod).toBe('search_snippet');
    expect(found!.evidence[0]!.injectionFlagged).toBe(false);
  });

  it('round-trips the reproducibility triple', async () => {
    await repo.create(sampleCheck());
    const { factCheck } = (await repo.findById('fc1'))!;
    expect(factCheck.pipelineVersion).toBe(1);
    expect(factCheck.evidenceVersion).toBe(1);
    expect(factCheck.modelId).toContain('llama');
  });

  it('returns null for an unknown id', async () => {
    expect(await repo.findById('nope')).toBeNull();
  });

  it('exposes no update or delete method — the table is append-only', () => {
    expect((repo as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it('supersedes an older check without rewriting it', async () => {
    await repo.create(sampleCheck('fc1'));
    await repo.create(sampleCheck('fc2'));
    await repo.supersede('fc1', 'fc2');

    // The original verdict and reasoning are untouched.
    const old = await repo.findById('fc1');
    expect(old?.factCheck.verdict).toBe('true');
    expect(old?.factCheck.reasoning).toContain('Two independent sources');
  });

  it('excludes superseded checks from recent listings', async () => {
    await repo.create(sampleCheck('fc1'));
    await repo.create(sampleCheck('fc2'));
    await repo.supersede('fc1', 'fc2');

    const recent = await repo.listRecent();
    expect(recent.map((r) => r.id)).toEqual(['fc2']);
  });

  it('filters by verdict for history', async () => {
    await repo.create(sampleCheck('fc1'));
    const unverified = sampleCheck('fc2');
    unverified.factCheck.verdict = 'unverified';
    unverified.factCheck.evidenceStrength = 'none';
    await repo.create(unverified);

    expect((await repo.listByVerdict('unverified')).map((r) => r.id)).toEqual(['fc2']);
    expect((await repo.listByVerdict('true')).map((r) => r.id)).toEqual(['fc1']);
  });

  it('bounds the limit rather than trusting the caller', async () => {
    await repo.create(sampleCheck());
    await expect(repo.listRecent(99999)).resolves.toBeTruthy();
    await expect(repo.listRecent(-5)).resolves.toBeTruthy();
  });

  // Parameterised throughout: a value like this must be stored as data, never
  // executed as SQL.
  it('treats SQL metacharacters in a claim as data', async () => {
    const nasty = sampleCheck('fc-inj');
    nasty.factCheck.claim = "'; DROP TABLE fact_checks; --";
    await repo.create(nasty);

    const found = await repo.findById('fc-inj');
    expect(found?.factCheck.claim).toBe("'; DROP TABLE fact_checks; --");
    // The table is still there.
    expect(await repo.listRecent()).toHaveLength(1);
  });
});

d('ArticleRepository', () => {
  let repo: ArticleRepository;

  const article = (id: string, canonical: string, slug = id) => ({
    id,
    slug,
    canonicalUrl: canonical,
    originalUrl: canonical,
    title: `Story ${id}`,
    summary: 'Publisher summary',
    publisherName: 'The Hindu',
    category: 'business',
    language: 'en',
    publishedAt: '2026-08-08T00:00:00Z',
    providerId: 'rss',
  });

  beforeEach(() => {
    repo = new ArticleRepository(makeDb());
  });

  it('inserts and reads back by slug', async () => {
    await repo.insertIfNew(article('a1', 'https://thehindu.com/1'));
    expect((await repo.findBySlug('a1'))?.title).toBe('Story a1');
  });

  // The scheduled job re-reads overlapping feeds every few minutes.
  it('is idempotent on canonical_url', async () => {
    await repo.insertIfNew(article('a1', 'https://thehindu.com/1'));
    await repo.insertIfNew(article('a2', 'https://thehindu.com/1', 'a2'));
    expect(await repo.listByCategory('business', 'en')).toHaveLength(1);
  });

  it('keeps genuinely different articles', async () => {
    await repo.insertIfNew(article('a1', 'https://thehindu.com/1'));
    await repo.insertIfNew(article('a2', 'https://thehindu.com/2', 'a2'));
    expect(await repo.listByCategory('business', 'en')).toHaveLength(2);
  });

  it('orders a category feed newest first', async () => {
    await repo.insertIfNew({ ...article('old', 'https://x.com/old'), publishedAt: '2026-08-01T00:00:00Z' });
    await repo.insertIfNew({ ...article('new', 'https://x.com/new'), publishedAt: '2026-08-08T00:00:00Z' });
    expect((await repo.listByCategory('business', 'en')).map((a) => a.id)).toEqual(['new', 'old']);
  });

  it('separates categories and languages', async () => {
    await repo.insertIfNew(article('a1', 'https://x.com/1'));
    await repo.insertIfNew({ ...article('a2', 'https://x.com/2'), category: 'sports' });
    await repo.insertIfNew({ ...article('a3', 'https://x.com/3'), language: 'hi' });

    expect(await repo.listByCategory('business', 'en')).toHaveLength(1);
    expect(await repo.listByCategory('sports', 'en')).toHaveLength(1);
    expect(await repo.listByCategory('business', 'hi')).toHaveLength(1);
  });

  it('lists other coverage in a cluster, excluding the current article', async () => {
    // Shared db: the cluster must exist before articles can reference it.
    const db = makeDb();
    const articles = new ArticleRepository(db);
    const clusters = new StoryClusterRepository(db);

    await clusters.upsert({
      id: 'c1',
      headline: 'Shared story',
      category: 'business',
      language: 'en',
      articleCount: 2,
      sourceCount: 2,
      trendingScore: 5,
      firstSeenAt: '2026-08-08T00:00:00Z',
      lastSeenAt: '2026-08-08T01:00:00Z',
    });

    await articles.insertIfNew({ ...article('a1', 'https://x.com/1'), clusterId: 'c1' });
    await articles.insertIfNew({ ...article('a2', 'https://y.com/2', 'a2'), clusterId: 'c1' });

    const others = await articles.listByCluster('c1', 'a1');
    expect(others.map((a) => a.id)).toEqual(['a2']);
  });

  // The migration sets PRAGMA foreign_keys = ON, and D1 honours it. An article
  // cannot claim membership of a cluster that does not exist.
  it('rejects an article referencing a non-existent cluster', async () => {
    await expect(
      repo.insertIfNew({ ...article('orphan', 'https://x.com/orphan'), clusterId: 'ghost' }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

d('SourceRepository', () => {
  it('upserts and looks up by domain, case-insensitively', async () => {
    const repo = new SourceRepository(makeDb());
    await repo.upsert({
      id: 'thehindu',
      domain: 'TheHindu.com',
      displayName: 'The Hindu',
      tier: 'tier2',
      sourceType: 'news',
      ownerGroup: 'kasturi',
    });

    const found = await repo.findByDomain('thehindu.com');
    expect(found?.displayName).toBe('The Hindu');
    expect(found?.tier).toBe('tier2');
    expect(found?.ownerGroup).toBe('kasturi');
  });

  it('updates an existing source rather than duplicating it', async () => {
    const repo = new SourceRepository(makeDb());
    const base = { id: 's', domain: 'x.com', displayName: 'X', tier: 'tier3' as const };
    await repo.upsert(base);
    await repo.upsert({ ...base, tier: 'tier1', displayName: 'X Official' });

    const all = await repo.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.tier).toBe('tier1');
  });

  it('round-trips the internal independence flags', async () => {
    const repo = new SourceRepository(makeDb());
    await repo.upsert({
      id: 'pti',
      domain: 'ptinews.com',
      displayName: 'PTI',
      tier: 'tier2',
      isWireAgency: true,
      ifcnSignatory: false,
    });
    const found = await repo.findByDomain('ptinews.com');
    expect(found?.isWireAgency).toBe(true);
    expect(found?.ifcnSignatory).toBe(false);
  });
});

d('StoryClusterRepository', () => {
  const cluster = (id: string, sourceCount: number, score: number) => ({
    id,
    headline: `Story ${id}`,
    category: 'top',
    language: 'en',
    articleCount: sourceCount,
    sourceCount,
    trendingScore: score,
    firstSeenAt: '2026-08-08T00:00:00Z',
    lastSeenAt: '2026-08-08T01:00:00Z',
  });

  it('ranks trending by score', async () => {
    const repo = new StoryClusterRepository(makeDb());
    await repo.upsert(cluster('c1', 3, 10));
    await repo.upsert(cluster('c2', 4, 50));
    expect((await repo.listTrending()).map((c) => c.id)).toEqual(['c2', 'c1']);
  });

  // A "trending story" covered by one outlet is not trending; it is one
  // article. Breadth of independent coverage is the only signal we can
  // honestly measure - there are no click counts.
  it('excludes single-source clusters from trending', async () => {
    const repo = new StoryClusterRepository(makeDb());
    await repo.upsert(cluster('solo', 1, 999));
    await repo.upsert(cluster('real', 2, 1));
    expect((await repo.listTrending()).map((c) => c.id)).toEqual(['real']);
  });

  it('upsert updates counts rather than duplicating', async () => {
    const repo = new StoryClusterRepository(makeDb());
    await repo.upsert(cluster('c1', 2, 5));
    await repo.upsert(cluster('c1', 6, 40));
    const found = await repo.findById('c1');
    expect(found?.sourceCount).toBe(6);
    expect(found?.trendingScore).toBe(40);
  });
});
