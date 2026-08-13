/** Migration 0002 executed against real SQLite, not string-matched.
 *
 *  A table rebuild is the riskiest kind of migration: it silently interacts
 *  with foreign keys, triggers and external-content FTS indexes. Every one of
 *  those interactions is asserted here against the actual SQL. */

import { describe, it, expect, beforeEach } from 'vitest';
import MIGRATION_0001 from '../../src/lib/db/migrations/0001_init.sql?raw';
import MIGRATION_0002 from '../../src/lib/db/migrations/0002_nullable_published_at.sql?raw';
import { DatabaseSync } from 'node:sqlite';

const available = (() => {
  try {
    new DatabaseSync(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();
const d = available ? describe : describe.skip;

const ARTICLE_COLS = `id, slug, canonical_url, original_url, title, summary,
  publisher_name, category, language, published_at, provider_id`;

function seededDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION_0001);

  db.exec(`
    INSERT INTO sources (id, domain, display_name, tier)
      VALUES ('s1', 'thehindu.com', 'The Hindu', 'tier1');

    INSERT INTO story_clusters (id, headline, category, language, first_seen_at, last_seen_at)
      VALUES ('c1', 'ISRO launch', 'top', 'en', '2026-08-08T10:00:00Z', '2026-08-08T10:00:00Z');

    INSERT INTO articles (${ARTICLE_COLS}, source_id, cluster_id)
      VALUES ('a1','isro-launch','https://thehindu.com/a','https://thehindu.com/a',
              'ISRO launches Chandrayaan','Publisher summary','The Hindu','top','en',
              '2026-08-08T10:00:00Z','rss','s1','c1');

    INSERT INTO fact_checks (
      id, claim, claim_normalized, verdict, evidence_strength, basis,
      summary, reasoning, pipeline_version, evidence_version, article_id
    ) VALUES ('fc1','c','c','true','moderate','ai_assessment','s','r',4,3,'a1');
  `);

  return db;
}

const one = <T>(db: DatabaseSync, sql: string, ...args: unknown[]): T =>
  db.prepare(sql).get(...(args as never[])) as T;

d('migration 0002 — nullable published_at', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = seededDb();
  });

  it('applies without error', () => {
    expect(() => db.exec(MIGRATION_0002)).not.toThrow();
  });

  it('makes published_at nullable and leaves ingested_at NOT NULL', () => {
    db.exec(MIGRATION_0002);
    const cols = db.prepare('PRAGMA table_info(articles)').all() as Array<{
      name: string;
      notnull: number;
    }>;

    expect(cols.find((c) => c.name === 'published_at')?.notnull).toBe(0);
    expect(cols.find((c) => c.name === 'ingested_at')?.notnull).toBe(1);
  });

  it('preserves existing article data', () => {
    db.exec(MIGRATION_0002);
    const row = one<Record<string, unknown>>(db, 'SELECT * FROM articles WHERE id = ?', 'a1');

    expect(row).toMatchObject({
      slug: 'isro-launch',
      canonical_url: 'https://thehindu.com/a',
      title: 'ISRO launches Chandrayaan',
      published_at: '2026-08-08T10:00:00Z',
      source_id: 's1',
      cluster_id: 'c1',
      provider_id: 'rss',
    });
  });

  /** The failure this migration was most likely to cause.
   *
   *  fact_checks.article_id is ON DELETE SET NULL. Dropping `articles` without
   *  deferring foreign keys fires that action and blanks the link on an
   *  already-published fact-check — an append-only row mutated by a schema
   *  change, and one the UPDATE trigger does not guard because article_id is
   *  not in its column list. */
  it('does not null out article_id on published fact-checks', () => {
    db.exec(MIGRATION_0002);
    const fc = one<{ article_id: string | null; verdict: string }>(
      db,
      'SELECT article_id, verdict FROM fact_checks WHERE id = ?',
      'fc1',
    );

    expect(fc.article_id).toBe('a1');
    expect(fc.verdict).toBe('true');
  });

  it('leaves the append-only guarantees intact', () => {
    db.exec(MIGRATION_0002);

    expect(() => db.exec(`DELETE FROM fact_checks WHERE id = 'fc1'`)).toThrow(/append-only/);
    expect(() =>
      db.exec(`UPDATE fact_checks SET verdict = 'false' WHERE id = 'fc1'`),
    ).toThrow(/append-only/);
    // The one permitted mutation still works.
    expect(() =>
      db.exec(`UPDATE fact_checks SET superseded_by = NULL WHERE id = 'fc1'`),
    ).not.toThrow();
  });

  it('accepts a NULL publication date and keeps it NULL', () => {
    db.exec(MIGRATION_0002);
    db.exec(`
      INSERT INTO articles (${ARTICLE_COLS})
        VALUES ('a2','no-date','https://x.com/b','https://x.com/b','Undated story',
                NULL,'X','top','en',NULL,'rss');
    `);

    const row = one<{ published_at: unknown; ingested_at: unknown }>(
      db,
      'SELECT published_at, ingested_at FROM articles WHERE id = ?',
      'a2',
    );

    expect(row.published_at).toBeNull();
    // ingested_at answers a different question and is always known.
    expect(typeof row.ingested_at).toBe('string');
    expect(row.ingested_at).not.toBeNull();
  });

  it('keeps ingested_at distinct from published_at', () => {
    db.exec(MIGRATION_0002);
    const row = one<{ published_at: string; ingested_at: string }>(
      db,
      'SELECT published_at, ingested_at FROM articles WHERE id = ?',
      'a1',
    );
    expect(row.published_at).not.toBe(row.ingested_at);
  });

  it('preserves UNIQUE constraints', () => {
    db.exec(MIGRATION_0002);
    expect(() =>
      db.exec(`INSERT INTO articles (${ARTICLE_COLS})
        VALUES ('dup','other','https://thehindu.com/a','u','t',NULL,'p','top','en','2026-08-08','rss')`),
    ).toThrow(/UNIQUE/i);

    expect(() =>
      db.exec(`INSERT INTO articles (${ARTICLE_COLS})
        VALUES ('dup2','isro-launch','https://x.com/z','u','t',NULL,'p','top','en','2026-08-08','rss')`),
    ).toThrow(/UNIQUE/i);
  });

  it('preserves the foreign key to story_clusters', () => {
    db.exec(MIGRATION_0002);
    db.exec('PRAGMA foreign_keys = ON');
    expect(() =>
      db.exec(`INSERT INTO articles (${ARTICLE_COLS}, cluster_id)
        VALUES ('a9','s9','https://x.com/9','u','t',NULL,'p','top','en','2026-08-08','rss','ghost')`),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('recreates every index from 0001', () => {
    db.exec(MIGRATION_0002);
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='articles'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);

    for (const idx of [
      'idx_articles_feed',
      'idx_articles_cluster',
      'idx_articles_recent',
      'idx_articles_source',
    ]) {
      expect(names).toContain(idx);
    }
  });

  it('recreates the FTS sync triggers', () => {
    db.exec(MIGRATION_0002);
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as Array<{ name: string }>
    ).map((r) => r.name);

    expect(names).toEqual(
      expect.arrayContaining(['articles_fts_insert', 'articles_fts_delete', 'articles_fts_update']),
    );
  });

  /** External-content FTS is keyed on articles.rowid. A rebuilt table can
   *  renumber rowids, so a stale index would return rows that do not match the
   *  documents that matched. The migration rebuilds it; this proves it. */
  it('keeps full-text search pointing at the right rows', () => {
    db.exec(MIGRATION_0002);
    const hit = one<{ id: string; title: string }>(
      db,
      `SELECT a.id, a.title FROM articles_fts f
       JOIN articles a ON a.rowid = f.rowid
       WHERE articles_fts MATCH ?`,
      '"Chandrayaan"',
    );

    expect(hit.id).toBe('a1');
    expect(hit.title).toBe('ISRO launches Chandrayaan');
  });

  it('indexes articles inserted after the migration', () => {
    db.exec(MIGRATION_0002);
    db.exec(`
      INSERT INTO articles (${ARTICLE_COLS})
        VALUES ('a3','monsoon','https://x.com/m','https://x.com/m','Monsoon floods Kerala',
                NULL,'X','top','en',NULL,'rss');
    `);

    const hit = one<{ id: string }>(
      db,
      `SELECT a.id FROM articles_fts f JOIN articles a ON a.rowid = f.rowid
       WHERE articles_fts MATCH ?`,
      '"Monsoon"',
    );
    expect(hit.id).toBe('a3');
  });

  it('is re-runnable without data loss', () => {
    db.exec(MIGRATION_0002);
    expect(() => db.exec(MIGRATION_0002)).not.toThrow();

    expect(one<{ c: number }>(db, 'SELECT COUNT(*) c FROM articles').c).toBe(1);
    expect(
      one<{ article_id: string | null }>(db, 'SELECT article_id FROM fact_checks WHERE id = ?', 'fc1')
        .article_id,
    ).toBe('a1');
  });

  it('applies cleanly to an empty database', () => {
    const fresh = new DatabaseSync(':memory:');
    fresh.exec(MIGRATION_0001);
    expect(() => fresh.exec(MIGRATION_0002)).not.toThrow();
    expect(one<{ c: number }>(fresh, 'SELECT COUNT(*) c FROM articles').c).toBe(0);
  });
});
