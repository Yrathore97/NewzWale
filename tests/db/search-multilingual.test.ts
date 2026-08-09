/** Phase 7 search fallback: FTS5 for Latin, LIKE for every other script.
 *
 *  Executed against real SQLite running both real migrations, so the actual
 *  tokenizer participates. The point of these tests is that the SAME user
 *  action means the same thing in every language — the previous behaviour was
 *  not "broken for Indic", it was INCONSISTENT between Indic scripts, which is
 *  harder to notice and worse to ship. */

import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_0001 from '../../src/lib/db/migrations/0001_init.sql?raw';
import MIGRATION_0002 from '../../src/lib/db/migrations/0002_nullable_published_at.sql?raw';
import { DatabaseSync } from 'node:sqlite';
import {
  ArticleRepository,
  needsLikeFallback,
  likePattern,
  likeTerms,
  type ArticleRecord,
} from '../../src/lib/db/repositories/articles';
import { decodeCursor, type Db } from '../../src/lib/db/client';

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

const article = (
  id: string,
  title: string,
  over: Partial<ArticleRecord> = {},
): ArticleRecord => ({
  id,
  slug: id,
  canonicalUrl: `https://x.com/${id}`,
  originalUrl: `https://x.com/${id}`,
  title,
  summary: null,
  imageUrl: null,
  publisherName: 'Publisher',
  category: 'top',
  language: 'en',
  publishedAt: '2026-08-08T10:00:00Z',
  providerId: 'rss',
  ...over,
});

describe('needsLikeFallback', () => {
  it('keeps Latin queries on the indexed FTS path', () => {
    for (const q of ['monsoon', 'Kerala floods', 'COVID-19', '2026 budget', 'café', 'Åland']) {
      expect(needsLikeFallback(q)).toBe(false);
    }
  });

  it('routes every non-Latin script to LIKE', () => {
    for (const q of ['मानसून', 'বৃষ্টি', 'கனமழை', 'వర్షాలు', 'بارش', 'ਪੰਜਾਬ', 'ગુજરાત']) {
      expect(needsLikeFallback(q)).toBe(true);
    }
  });

  // Digits and punctuation alone must not push a query off the fast path.
  it('ignores digits and punctuation', () => {
    for (const q of ['2026', 'covid-19', '!!!', '   ', '', '6.5%']) {
      expect(needsLikeFallback(q)).toBe(false);
    }
  });

  it('treats a mixed-script query as non-Latin', () => {
    expect(needsLikeFallback('ISRO मानसून')).toBe(true);
  });
});

describe('likePattern — wildcard escaping', () => {
  /** SECURITY. `%` and `_` are LIKE wildcards. Unescaped, a query of `%`
   *  matches every row: a full-table read from a public endpoint. */
  it('escapes LIKE wildcards', () => {
    expect(likePattern('%')).toBe('%\\%%');
    expect(likePattern('_')).toBe('%\\_%');
    expect(likePattern('100%_x')).toBe('%100\\%\\_x%');
  });

  it('escapes the escape character first, so escaping is not reversible', () => {
    expect(likePattern('\\')).toBe('%\\\\%');
    expect(likePattern('\\%')).toBe('%\\\\\\%%');
  });

  it('leaves ordinary text alone', () => {
    expect(likePattern('monsoon')).toBe('%monsoon%');
    expect(likePattern('मानसून')).toBe('%मानसून%');
  });

  it('bounds the number of terms so one query cannot become many scans', () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(' ');
    expect(likeTerms(many)).toHaveLength(8);
  });

  it('returns null for an empty query', () => {
    expect(likeTerms('   ')).toBeNull();
    expect(likeTerms('')).toBeNull();
  });
});

d('multilingual search behaviour', () => {
  let db: Db & { _raw: DatabaseSync };
  let repo: ArticleRepository;

  /** One headline per script, each carrying an INFLECTED form — the way the
   *  word actually appears in print. Indic languages attach the postposition
   *  to the noun, so a user typing the stem is the normal case, not an edge
   *  case. */
  beforeEach(async () => {
    db = makeDb();
    repo = new ArticleRepository(db);
    await repo.insertIfNew(article('en', 'Monsoon floods Kerala villages'));
    await repo.insertIfNew(article('hi', 'मानसून की बारिश से केरल में बाढ़', { language: 'hi' }));
    await repo.insertIfNew(article('bn', 'ভারী বৃষ্টিতে কেরালায় বন্যা', { language: 'bn' }));
    await repo.insertIfNew(article('ta', 'கனமழையால் கேரளாவில் வெள்ளம்', { language: 'ta' }));
    await repo.insertIfNew(article('te', 'భారీ వర్షాలతో కేరళలో వరదలు', { language: 'te' }));
    await repo.insertIfNew(article('ur', 'شدید بارش سے کیرالہ میں سیلاب', { language: 'ur' }));
  });

  const ids = async (q: string) => (await repo.searchPage(q, { limit: 20 })).items.map((a) => a.id);

  it('finds a full word in every script', async () => {
    expect(await ids('Monsoon')).toEqual(['en']);
    expect(await ids('मानसून')).toEqual(['hi']);
    expect(await ids('বন্যা')).toEqual(['bn']);
    expect(await ids('வெள்ளம்')).toEqual(['ta']);
    expect(await ids('వరదలు')).toEqual(['te']);
    expect(await ids('سیلاب')).toEqual(['ur']);
  });

  /** THE PHASE 7 FIX. Under pure FTS5 these three MISSED — Telugu because the
   *  tokenizer does not fragment it the way it fragments Devanagari, so a stem
   *  query found nothing. Measured before the change; asserted after. */
  it('finds a stem inside an inflected form in every Indic script', async () => {
    expect(await ids('बारिश')).toEqual(['hi']); // बारिश से
    expect(await ids('বৃষ্টি')).toEqual(['bn']); // বৃষ্টিতে
    expect(await ids('கனமழை')).toEqual(['ta']); // கனமழையால்
    expect(await ids('వర్షాల')).toEqual(['te']); // వర్షాలతో  <- previously MISS
    expect(await ids('కేరళ')).toEqual(['te']); // కేరళలో     <- previously MISS
    expect(await ids('بارش')).toEqual(['ur']); // بارش سے
  });

  it('does not match an unrelated word in the same script', async () => {
    expect(await ids('क्रिकेट')).toEqual([]);
    expect(await ids('ক্রিকেট')).toEqual([]);
  });

  it('ANDs multiple non-Latin terms rather than ORing them', async () => {
    expect(await ids('मानसून बाढ़')).toEqual(['hi']);
    // Second term appears in no Hindi headline.
    expect(await ids('मानसून क्रिकेट')).toEqual([]);
  });

  it('searches the publisher summary as well as the title', async () => {
    await repo.insertIfNew(
      article('hi2', 'एक अलग शीर्षक', { language: 'hi', summary: 'यहाँ चक्रवात का उल्लेख है' }),
    );
    expect(await ids('चक्रवात')).toEqual(['hi2']);
  });

  it('handles a mixed-script query', async () => {
    await repo.insertIfNew(article('mix', 'ISRO ने मानसून उपग्रह भेजा', { language: 'hi' }));
    expect(await ids('ISRO मानसून')).toEqual(['mix']);
  });

  it('ignores surrounding punctuation and whitespace', async () => {
    expect(await ids('  मानसून  ')).toEqual(['hi']);
    expect(await ids('मानसून, बाढ़')).toEqual(['hi']);
  });

  it('returns empty rather than failing for a whitespace-only query', async () => {
    expect(await ids('   ')).toEqual([]);
    expect(await ids('')).toEqual([]);
  });

  it('returns empty for a non-Latin query with no matches', async () => {
    expect(await ids('ऑस्ट्रेलिया')).toEqual([]);
  });

  describe('operator and injection safety on the LIKE path', () => {
    /** The new surface this fallback introduces. Unescaped, `%` returns every
     *  row — a full-table read from a public endpoint. */
    it('does not let a bare wildcard dump the table', async () => {
      expect(await ids('%')).toEqual([]);
      expect(await ids('%%')).toEqual([]);
      expect(await ids('_')).toEqual([]);
      expect(await ids('%_%')).toEqual([]);
    });

    // Wildcards around a real term are stripped as punctuation and the term
    // itself is searched — the same thing FTS5 does. The word matches; the
    // wildcards contribute nothing.
    it('strips wildcards around a term instead of expanding them', async () => {
      expect(await ids('%मानसून%')).toEqual(['hi']);
      expect(await ids('_मानसून_')).toEqual(['hi']);
    });

    /** `_` is split out as punctuation before a pattern is built, so it can
     *  never reach LIKE as a single-character wildcard. The query becomes two
     *  terms, which is exactly what FTS5's tokenizer would do with it. */
    it('never lets an underscore act as a single-character wildcard', async () => {
      await repo.insertIfNew(article('u1', 'शब्द एक', { language: 'hi' }));
      await repo.insertIfNew(article('u2', 'शब्दXएक', { language: 'hi' }));

      // Both contain the substrings "शब्द" and "एक"; neither is matched via a
      // wildcard expansion of `_`.
      expect((await ids('शब्द_एक')).sort()).toEqual(['u1', 'u2']);
      // A term that genuinely appears nowhere still returns nothing.
      expect(await ids('शब्द_क्रिकेट')).toEqual([]);
    });

    it('treats SQL metacharacters as text', async () => {
      for (const q of ["मानसून'; DROP TABLE articles;--", "'--", "' OR 1=1 --"]) {
        await expect(repo.searchPage(q, { limit: 20 })).resolves.toBeDefined();
      }
      expect(
        (db._raw.prepare('SELECT COUNT(*) c FROM articles').get() as { c: number }).c,
      ).toBe(6);
    });

    it('survives operator-heavy input on both paths', async () => {
      for (const q of ['"', '*', '-', 'a OR b', 'NEAR(x y)', '(', '^', 'मानसून OR *', '\\']) {
        await expect(repo.searchPage(q, { limit: 20 })).resolves.toBeDefined();
      }
    });
  });

  describe('filters and pagination on the LIKE path', () => {
    beforeEach(async () => {
      // Three Hindi articles sharing a term, distinct dates, for paging.
      for (let i = 1; i <= 3; i += 1) {
        await repo.insertIfNew(
          article(`p${i}`, `मानसून समाचार ${i}`, {
            language: 'hi',
            category: i === 3 ? 'sports' : 'top',
            publishedAt: `2026-08-0${i}T10:00:00Z`,
          }),
        );
      }
    });

    it('filters by category', async () => {
      expect(await ids('समाचार')).toEqual(['p3', 'p2', 'p1']);
      const only = await repo.searchPage('समाचार', { category: 'sports', limit: 20 });
      expect(only.items.map((a) => a.id)).toEqual(['p3']);
    });

    it('filters by language', async () => {
      const hi = await repo.searchPage('समाचार', { language: 'hi', limit: 20 });
      expect(hi.items).toHaveLength(3);
      const en = await repo.searchPage('समाचार', { language: 'en', limit: 20 });
      expect(en.items).toEqual([]);
    });

    it('paginates deterministically with the same cursor mechanism', async () => {
      const first = await repo.searchPage('समाचार', { limit: 2 });
      expect(first.items.map((a) => a.id)).toEqual(['p3', 'p2']);
      expect(first.cursor).toBeTruthy();

      const second = await repo.searchPage('समाचार', {
        limit: 2,
        cursor: decodeCursor(first.cursor),
      });
      expect(second.items.map((a) => a.id)).toEqual(['p1']);
      expect(second.cursor).toBeUndefined();
    });

    it('gives the same order on repeated calls', async () => {
      const once = await ids('समाचार');
      for (let i = 0; i < 3; i += 1) expect(await ids('समाचार')).toEqual(once);
    });

    it('bounds the limit', async () => {
      const page = await repo.searchPage('मानसून', { limit: 10_000 });
      expect(page.items.length).toBeLessThanOrEqual(100);
    });
  });

  // The English path is untouched: still FTS5, still token-based.
  describe('Latin queries keep FTS semantics', () => {
    it('matches whole words', async () => {
      expect(await ids('Monsoon')).toEqual(['en']);
      expect(await ids('kerala')).toEqual(['en']);
    });

    it('still does not stem English, which FTS5 never did', async () => {
      // Documented, not fixed here: enabling the porter tokenizer is a
      // separate decision with its own trade-offs.
      expect(await ids('flood')).toEqual([]);
    });
  });
});
