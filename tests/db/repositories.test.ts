import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_SQL from '../../src/lib/db/migrations/0001_init.sql?raw';
import MIGRATION_0002 from '../../src/lib/db/migrations/0002_nullable_published_at.sql?raw';
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
import {
  DbUnavailableError,
  hasDb,
  contentId,
  getDb,
  encodeCursor,
  decodeCursor,
  type Db,
} from '../../src/lib/db/client';
import type { Page } from '../../src/lib/db/repositories/articles';

/** Adapts node:sqlite to the D1 prepared-statement surface the repositories
 *  expect, so they can be tested without a Worker.
 *
 *  The schema itself is separately verified against REAL D1 via
 *  `wrangler d1 execute --local` (see the header of 0001_init.sql). This
 *  adapter tests the repository SQL, not D1 compatibility. */
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

  // One narrowing of the binding, instead of a raw double cast per call site.
  it('getDb reads the binding off the environment', () => {
    const db = {} as Db;
    expect(getDb({ NEWZ_DB: db })).toBe(db);
  });

  it('getDb returns undefined when the binding is absent, so callers degrade', () => {
    expect(getDb({})).toBeUndefined();
    expect(getDb(undefined)).toBeUndefined();
    expect(getDb(null)).toBeUndefined();
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

  describe('claim search', () => {
    it('finds a check by a word in its claim', async () => {
      await repo.create(sampleCheck('fc1'));
      expect((await repo.search('repo rate')).map((c) => c.id)).toEqual(['fc1']);
    });

    it('returns nothing for an unrelated term', async () => {
      await repo.create(sampleCheck('fc1'));
      expect(await repo.search('monsoon')).toEqual([]);
    });

    // A superseded verdict came from methodology this system no longer uses.
    // Surfacing it in search would republish a retracted conclusion.
    it('hides superseded checks', async () => {
      await repo.create(sampleCheck('old'));
      await repo.create(sampleCheck('new'));
      expect(await repo.search('repo rate')).toHaveLength(2);

      await repo.supersede('old', 'new');
      expect((await repo.search('repo rate')).map((c) => c.id)).toEqual(['new']);
    });

    it('treats FTS5 operators and quotes as literal text', async () => {
      await repo.create(sampleCheck('fc1'));
      for (const q of ['"', '*', '-', 'a OR b', 'NEAR']) {
        await expect(repo.search(q)).resolves.toBeInstanceOf(Array);
      }
    });

    it('returns nothing for an empty query', async () => {
      await repo.create(sampleCheck('fc1'));
      expect(await repo.search('  ')).toEqual([]);
    });
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

  it('reads back by id', async () => {
    await repo.insertIfNew(article('a1', 'https://thehindu.com/1'));
    expect((await repo.findById('a1'))?.slug).toBe('a1');
    expect(await repo.findById('nope')).toBeNull();
  });

  describe('cursor pagination', () => {
    // Distinct publishedAt values, newest last so insertion order != sort order.
    const seed = async (n: number) => {
      for (let i = 1; i <= n; i += 1) {
        await repo.insertIfNew({
          ...article(`a${i}`, `https://x.com/${i}`),
          publishedAt: `2026-08-${String(i).padStart(2, '0')}T00:00:00Z`,
        });
      }
    };

    it('omits the cursor on a final page', async () => {
      await seed(3);
      const page = await repo.pageByCategory('business', 'en', { limit: 10 });
      expect(page.items).toHaveLength(3);
      expect(page.cursor).toBeUndefined();
      expect('cursor' in page).toBe(false);
    });

    it('walks every row exactly once across pages', async () => {
      await seed(7);
      const seen: string[] = [];
      let cursor: ReturnType<typeof decodeCursor> = null;

      for (let guard = 0; guard < 10; guard += 1) {
        const page: Page<{ id: string }> = await repo.pageByCategory('business', 'en', {
          limit: 3,
          cursor,
        });
        seen.push(...page.items.map((a) => a.id));
        if (!page.cursor) break;
        cursor = decodeCursor(page.cursor);
      }

      // Newest first, no repeats, nothing dropped.
      expect(seen).toEqual(['a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1']);
      expect(new Set(seen).size).toBe(7);
    });

    // Without the id tiebreak, rows sharing a timestamp could repeat or vanish.
    it('does not repeat or drop rows that share a published_at', async () => {
      for (const id of ['a1', 'a2', 'a3', 'a4']) {
        await repo.insertIfNew({
          ...article(id, `https://x.com/${id}`),
          publishedAt: '2026-08-08T00:00:00Z',
        });
      }

      const first = await repo.pageByCategory('business', 'en', { limit: 2 });
      const second = await repo.pageByCategory('business', 'en', {
        limit: 2,
        cursor: decodeCursor(first.cursor),
      });

      const ids = [...first.items, ...second.items].map((a) => a.id);
      expect(new Set(ids).size).toBe(4);
    });

    it('bounds the limit rather than trusting the caller', async () => {
      await seed(3);
      const page = await repo.pageByCategory('business', 'en', { limit: 10_000 });
      expect(page.items).toHaveLength(3);
    });

    /** Undated rows are the pagination edge case that migration 0002 created.
     *
     *  `published_at < ?` is NULL for an undated row, never true, so without
     *  the COALESCE sort key those articles would vanish after page 1 —
     *  present in the table, unreachable through the API. */
    it('reaches undated articles instead of dropping them past page 1', async () => {
      await seed(3);
      await repo.insertIfNew({
        ...article('undated', 'https://x.com/undated'),
        publishedAt: null,
      });

      const seen: string[] = [];
      let cursor: ReturnType<typeof decodeCursor> = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await repo.pageByCategory('business', 'en', { limit: 2, cursor });
        seen.push(...page.items.map((a) => a.id));
        if (!page.cursor) break;
        cursor = decodeCursor(page.cursor);
      }

      expect(seen).toContain('undated');
      expect(new Set(seen).size).toBe(4);
      // Unknown dates sort last in a newest-first feed.
      expect(seen[seen.length - 1]).toBe('undated');
    });

    it('returns null publishedAt rather than an empty string', async () => {
      await repo.insertIfNew({
        ...article('undated', 'https://x.com/undated'),
        publishedAt: null,
      });
      const page = await repo.pageByCategory('business', 'en', {});
      expect(page.items[0]!.publishedAt).toBeNull();
    });

    it('ignores a malformed cursor instead of binding it into SQL', () => {
      expect(decodeCursor('not-base64!!')).toBeNull();
      expect(decodeCursor(btoa('no-separator'))).toBeNull();
      expect(decodeCursor('')).toBeNull();
      expect(decodeCursor(undefined)).toBeNull();
    });

    it('round-trips a cursor', () => {
      const c = { sortValue: '2026-08-08T00:00:00Z', id: 'abc123' };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    });

    // The schema writes timestamps in TWO shapes: nowIso() produces ISO-8601,
    // but every DEFAULT (datetime('now')) column produces SQLite's
    // 'YYYY-MM-DD HH:MM:SS', which contains a space. A space-separated cursor
    // would split the sort value in half here.
    it("round-trips a sort value containing SQLite's space-separated format", () => {
      const c = { sortValue: '2026-08-08 00:00:00', id: 'abc123' };
      expect(decodeCursor(encodeCursor(c))).toEqual(c);
    });
  });

  describe('full-text search', () => {
    it('matches on title and on publisher summary', async () => {
      await repo.insertIfNew({ ...article('a1', 'https://x.com/1'), title: 'Monsoon floods Kerala' });
      await repo.insertIfNew({
        ...article('a2', 'https://x.com/2'),
        title: 'Budget session opens',
        summary: 'Finance ministry tables the monsoon relief package',
      });
      await repo.insertIfNew({ ...article('a3', 'https://x.com/3'), title: 'Cricket final' });

      const ids = (await repo.search('monsoon')).map((a) => a.id);
      expect(ids.sort()).toEqual(['a1', 'a2']);
    });

    it('ANDs multiple words rather than ORing them', async () => {
      await repo.insertIfNew({ ...article('a1', 'https://x.com/1'), title: 'Kerala floods' });
      await repo.insertIfNew({ ...article('a2', 'https://x.com/2'), title: 'Kerala election' });
      expect((await repo.search('kerala floods')).map((a) => a.id)).toEqual(['a1']);
    });

    // FTS5 MATCH is a query language: unescaped operators would throw or
    // silently change the query. Each word is quoted as a literal phrase.
    it('treats FTS5 operators as literal words', async () => {
      await repo.insertIfNew({ ...article('a1', 'https://x.com/1'), title: 'Report on NEAR misses' });
      await repo.insertIfNew({ ...article('a2', 'https://x.com/2'), title: 'Unrelated story' });

      expect(async () => repo.search('NEAR')).not.toThrow();
      expect((await repo.search('NEAR')).map((a) => a.id)).toEqual(['a1']);
    });

    it('does not throw on quotes, wildcards or a lone hyphen', async () => {
      await repo.insertIfNew(article('a1', 'https://x.com/1'));
      for (const q of ['"', '""', '*', '-', 'a OR b', 'x AND y', '(', 'foo*']) {
        await expect(repo.search(q)).resolves.toBeInstanceOf(Array);
      }
    });

    it('returns nothing for a whitespace-only query', async () => {
      await repo.insertIfNew(article('a1', 'https://x.com/1'));
      expect(await repo.search('   ')).toEqual([]);
      expect(await repo.search('')).toEqual([]);
    });

    it('bounds the limit', async () => {
      await repo.insertIfNew(article('a1', 'https://x.com/1'));
      await expect(repo.search('story', 10_000)).resolves.toBeInstanceOf(Array);
    });

    /** MEASURED behaviour of FTS5 on Indic scripts. Not a claim that
     *  multilingual search is solved — these tests record what the tokenizer
     *  actually does, so the limitation is visible in code and a change to it
     *  fails loudly.
     *
     *  Measured with fts5vocab against the real tokenizer:
     *
     *    'मानसून की बारिश'  tokenizes to  म | नस | न | क | ब | र | श
     *    'monsoon rain'      tokenizes to  monsoon | rain
     *
     *  unicode61 treats Devanagari and Bengali combining vowel marks (matras)
     *  as token SEPARATORS, so a word shatters into consonant fragments
     *  instead of staying one token. Whole-word queries still find the right
     *  document, because the query shatters into the same fragment sequence
     *  and FTS5 phrase-matches it in order. The cost is that matching becomes
     *  substring-like in these scripts, and BM25 `rank` is computed over
     *  fragments rather than words, so relevance ordering is not trustworthy.
     *
     *  IMPORTANT CORRECTION: the migration comment claimed
     *  `remove_diacritics 2` was "needed for Indic scripts". Measured against
     *  `remove_diacritics 0`, the Devanagari token list is IDENTICAL — the
     *  setting has no bearing on this. Fixing it properly means a different
     *  tokenizer (ICU), which is a schema migration and a Phase 5D decision
     *  backed by evidence, not a quiet change here. */
    describe('Indic script behaviour (measured, not solved)', () => {
      const cases: Array<[string, string, string]> = [
        ['Devanagari (Hindi)', 'मानसून की बारिश शुरू', 'मानसून'],
        ['Bengali', 'ভারী বৃষ্টি শুরু', 'বৃষ্টি'],
        ['Tamil', 'கனமழை தொடங்கியது', 'கனமழை'],
        ['Telugu', 'భారీ వర్షాలు ప్రారంభం', 'వర్షాలు'],
        ['Urdu', 'شدید بارش شروع', 'بارش'],
      ];

      for (const [label, title, term] of cases) {
        it(`${label}: a whole-word query finds the document`, async () => {
          await repo.insertIfNew({ ...article('a1', 'https://x.com/1'), title });
          expect((await repo.search(term)).map((a) => a.id)).toEqual(['a1']);
        });
      }

      // English is genuinely token-based: a partial word does NOT match.
      it('English: a partial word does not match', async () => {
        await repo.insertIfNew({ ...article('a1', 'https://x.com/1'), title: 'monsoon rain' });
        expect(await repo.search('monso')).toEqual([]);
      });

      // Devanagari is NOT, because of the fragment shattering above. This is a
      // real inconsistency between scripts, asserted so it cannot regress
      // unnoticed and cannot be mistaken for intended behaviour.
      it('Devanagari: a partial word DOES match — known defect', async () => {
        await repo.insertIfNew({ ...article('a1', 'https://x.com/1'), title: 'मानसून की बारिश' });
        expect((await repo.search('मानसू')).map((a) => a.id)).toEqual(['a1']);
      });
    });
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
