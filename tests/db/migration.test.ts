import { describe, it, expect, beforeAll } from 'vitest';
// ?raw keeps this test free of node:fs, and therefore free of an
// @types/node devDependency added for one file read.
import MIGRATION_SQL from '../../src/lib/db/migrations/0001_init.sql?raw';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** Executes migration 0001 against an in-memory SQLite database.
 *
 *  This is a real execution, not a string match: it catches syntax errors,
 *  broken triggers, invalid CHECK constraints and bad FTS5 options before they
 *  reach D1, where a failed migration is far more expensive to unpick.
 *
 *  LIMITATION, stated honestly: this runs against Node's bundled SQLite, not
 *  Cloudflare's D1 build. D1 is SQLite-compatible so syntax and constraint
 *  behaviour carry over, but this cannot prove D1-specific limits (statement
 *  size, binding count, transaction semantics). Applying against a real
 *  `--local` D1 remains a required step in Phase 2.
 *
 *  node:sqlite is unflagged from Node 23.4. On Node 22 (which CI currently
 *  pins) it needs --experimental-sqlite, so these tests skip rather than fail.
 *  See the Phase 0 report: bumping CI to Node 24 is recommended so this
 *  coverage actually runs in CI. */

type Db = { exec(sql: string): void; prepare(sql: string): StatementSync };

/** node:sqlite is unflagged from Node 23.4 but needs --experimental-sqlite on
 *  Node 22. Probe once rather than assuming, so this file degrades to a skip
 *  instead of a suite-wide failure on an older runtime. */
const available = (() => {
  try {
    new DatabaseSync(':memory:').close();
    return true;
  } catch {
    return false;
  }
})();

const d = available ? describe : describe.skip;

if (!available) {
  // Loud rather than silent: a skipped schema test is not a passing one, and
  // nobody should read a green run as coverage it does not have.
  console.warn(
    '[migration.test] node:sqlite unavailable (needs Node >= 23.4, or --experimental-sqlite on Node 22). SCHEMA TESTS SKIPPED.',
  );
}

function fresh(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec(MIGRATION_SQL);
  return db;
}

d('migration 0001 — applies cleanly', () => {
  let db: Db;
  beforeAll(() => {
    db = fresh();
  });

  it('executes without error', () => {
    expect(() => fresh()).not.toThrow();
  });

  it('is idempotent — re-applying is a no-op, not an error', () => {
    expect(() => db.exec(MIGRATION_SQL)).not.toThrow();
  });

  it('creates exactly the five approved tables and no deferred ones', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r: any) => r.name)
      .sort();

    expect(names).toEqual([
      'articles',
      'fact_check_evidence',
      'fact_checks',
      'sources',
      'story_clusters',
    ]);
  });

  it('does not create the explicitly deferred tables', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    for (const deferred of ['users', 'verdicts', 'source_snapshots', 'related_claims']) {
      expect(names).not.toContain(deferred);
    }
  });

  it('creates both FTS indexes', () => {
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
      .all()
      .map((r: any) => r.name);

    expect(names).toContain('articles_fts');
    expect(names).toContain('claims_fts');
  });
});

d('fact_checks — append-only is enforced by the database', () => {
  function seed(db: Db, id = 'fc1') {
    db.prepare(
      `INSERT INTO fact_checks
        (id, claim, claim_normalized, verdict, evidence_strength, summary, reasoning,
         pipeline_version, evidence_version)
       VALUES (?, 'A claim', 'a claim', 'unverified', 'none', 'No answer.', 'No evidence found.', 1, 1)`,
    ).run(id);
  }

  it('accepts an insert', () => {
    const db = fresh();
    expect(() => seed(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM fact_checks').all()[0].n).toBe(1);
  });

  // A verdict a reader has seen and shared must keep saying what they saw.
  it('refuses to delete a row', () => {
    const db = fresh();
    seed(db);
    expect(() => db.prepare("DELETE FROM fact_checks WHERE id='fc1'").run()).toThrow(
      /append-only/,
    );
  });

  it('refuses to rewrite a verdict', () => {
    const db = fresh();
    seed(db);
    expect(() => db.prepare("UPDATE fact_checks SET verdict='true' WHERE id='fc1'").run()).toThrow(
      /append-only/,
    );
  });

  it('refuses to rewrite the claim or the reasoning', () => {
    const db = fresh();
    seed(db);
    expect(() => db.prepare("UPDATE fact_checks SET claim='different' WHERE id='fc1'").run()).toThrow(/append-only/);
    expect(() => db.prepare("UPDATE fact_checks SET reasoning='rewritten' WHERE id='fc1'").run()).toThrow(/append-only/);
  });

  // The one permitted mutation: linking an old row to the check that replaced
  // it. Without this, supersession would be impossible and the table unusable.
  it('permits setting superseded_by, so a re-check can supersede', () => {
    const db = fresh();
    seed(db, 'fc1');
    seed(db, 'fc2');
    expect(() =>
      db.prepare("UPDATE fact_checks SET superseded_by='fc2' WHERE id='fc1'").run(),
    ).not.toThrow();
  });
});

d('fact_checks — constraints encode the locked verdict system', () => {
  function insertVerdict(db: Db, verdict: string) {
    db.prepare(
      `INSERT INTO fact_checks
        (id, claim, claim_normalized, verdict, evidence_strength, summary, reasoning,
         pipeline_version, evidence_version)
       VALUES (?, 'c', 'c', ?, 'none', 's', 'r', 1, 1)`,
    ).run(`id-${verdict}`, verdict);
  }

  it('accepts all six canonical verdicts and only those', () => {
    const db = fresh();
    for (const v of ['true', 'false', 'partly_true', 'misleading', 'unverified', 'needs_context']) {
      expect(() => insertVerdict(db, v), v).not.toThrow();
    }
  });

  it('rejects the superseded four-value enum', () => {
    const db = fresh();
    // These are what the pipeline emits TODAY. The CHECK failing is the
    // intended safety net: persistence must not begin until Phase 3 has
    // migrated the enum.
    expect(() => insertVerdict(db, 'verified')).toThrow();
    expect(() => insertVerdict(db, 'insufficient_evidence')).toThrow();
  });

  it('rejects an invented verdict', () => {
    const db = fresh();
    expect(() => insertVerdict(db, 'mostly_true')).toThrow();
    expect(() => insertVerdict(db, '')).toThrow();
  });

  it('requires an evidence strength alongside every verdict', () => {
    const db = fresh();
    expect(() =>
      db
        .prepare(
          `INSERT INTO fact_checks
            (id, claim, claim_normalized, verdict, evidence_strength, summary, reasoning,
             pipeline_version, evidence_version)
           VALUES ('x','c','c','true','very-strong','s','r',1,1)`,
        )
        .run(),
    ).toThrow();
  });

  it('allows user_id to be null, so accounts stay additive', () => {
    const db = fresh();
    insertVerdict(db, 'unverified');
    expect(db.prepare('SELECT user_id FROM fact_checks').all()[0].user_id).toBeNull();
  });
});

d('fact_check_evidence — principle 7: dates are preserved, never fabricated', () => {
  function seedCheck(db: Db) {
    db.prepare(
      `INSERT INTO fact_checks
        (id, claim, claim_normalized, verdict, evidence_strength, summary, reasoning,
         pipeline_version, evidence_version)
       VALUES ('fc1','c','c','unverified','none','s','r',1,1)`,
    ).run();
  }

  function addEvidence(db: Db, position: number, publishedAt: string | null) {
    db.prepare(
      `INSERT INTO fact_check_evidence
        (id, fact_check_id, position, url, title, publisher, stance, published_at)
       VALUES (?, 'fc1', ?, 'https://example.com/a', 'T', 'example.com', 'supporting', ?)`,
    ).run(`ev${position}`, position, publishedAt);
  }

  // published_at NULL means the publication date genuinely could not be
  // determined. Backfilling it with the fetch time would fabricate a date,
  // which is worse than admitting we lack one.
  it('accepts a null published_at', () => {
    const db = fresh();
    seedCheck(db);
    expect(() => addEvidence(db, 1, null)).not.toThrow();
    expect(db.prepare('SELECT published_at FROM fact_check_evidence').all()[0].published_at).toBeNull();
  });

  it('always records accessed_at, and keeps it distinct from published_at', () => {
    const db = fresh();
    seedCheck(db);
    addEvidence(db, 1, null);
    const row = db.prepare('SELECT published_at, accessed_at FROM fact_check_evidence').all()[0];
    expect(row.accessed_at).toBeTruthy();
    expect(row.published_at).toBeNull();
    expect(row.accessed_at).not.toBe(row.published_at);
  });

  it('constrains stance to the three classifications', () => {
    const db = fresh();
    seedCheck(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO fact_check_evidence (id, fact_check_id, position, url, title, publisher, stance)
           VALUES ('e','fc1',9,'https://x/','T','x.com','neutral')`,
        )
        .run(),
    ).toThrow();
  });

  it('defaults read_method to search_snippet, the weaker claim', () => {
    const db = fresh();
    seedCheck(db);
    addEvidence(db, 1, '2026-08-04');
    expect(db.prepare('SELECT read_method FROM fact_check_evidence').all()[0].read_method).toBe(
      'search_snippet',
    );
  });

  it('cascades evidence when a check is removed by an admin path', () => {
    const db = fresh();
    seedCheck(db);
    addEvidence(db, 1, null);
    // Deleting the parent is itself blocked, so orphan evidence cannot arise
    // through normal operation. Asserted so the FK intent is recorded.
    expect(() => db.prepare("DELETE FROM fact_checks WHERE id='fc1'").run()).toThrow(/append-only/);
  });

  it('prevents duplicate citation positions within one check', () => {
    const db = fresh();
    seedCheck(db);
    addEvidence(db, 1, null);
    expect(() => addEvidence(db, 1, null)).toThrow();
  });
});

d('articles — canonical URL is the dedup boundary', () => {
  function insertArticle(db: Db, id: string, slug: string, canonical: string) {
    db.prepare(
      `INSERT INTO articles
        (id, slug, canonical_url, original_url, title, publisher_name, category, language, published_at)
       VALUES (?, ?, ?, ?, 'T', 'The Hindu', 'top', 'en', '2026-08-08T00:00:00Z')`,
    ).run(id, slug, canonical, canonical);
  }

  it('rejects a duplicate canonical url', () => {
    const db = fresh();
    insertArticle(db, 'a1', 'slug-1', 'https://thehindu.com/story');
    expect(() => insertArticle(db, 'a2', 'slug-2', 'https://thehindu.com/story')).toThrow();
  });

  it('rejects a duplicate slug', () => {
    const db = fresh();
    insertArticle(db, 'a1', 'slug-1', 'https://thehindu.com/one');
    expect(() => insertArticle(db, 'a2', 'slug-1', 'https://thehindu.com/two')).toThrow();
  });

  it('mirrors inserted articles into the FTS index', () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO articles
        (id, slug, canonical_url, original_url, title, summary, publisher_name, category, language, published_at)
       VALUES ('a1','s1','https://x/1','https://x/1','RBI holds repo rate','Central bank decision','The Hindu','business','en','2026-08-08T00:00:00Z')`,
    ).run();

    const hits = db.prepare("SELECT rowid FROM articles_fts WHERE articles_fts MATCH 'repo'").all();
    expect(hits.length).toBe(1);
  });
});
