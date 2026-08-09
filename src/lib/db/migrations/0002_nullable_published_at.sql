-- ============================================================================
-- NewzWale — D1 migration 0002: articles.published_at becomes NULLABLE
--
-- Apply:
--   local   npx wrangler d1 execute newzwale --local  --file=src/lib/db/migrations/0002_nullable_published_at.sql
--   remote  npx wrangler d1 execute newzwale --remote --file=src/lib/db/migrations/0002_nullable_published_at.sql
--
-- WHY
--
-- 0001 declared `published_at TEXT NOT NULL`. Ingestion therefore had three
-- options for an article whose publication date could not be read, and two of
-- them were unacceptable:
--
--   fabricate a date            — invents a fact, the exact failure the
--                                 evidence schema's separate published_at /
--                                 accessed_at columns exist to prevent
--   substitute the fetch time   — same lie, wearing a plausible number
--   drop the article            — what Phase 5B did; honest, but it discards
--                                 otherwise valid journalism over a missing
--                                 metadata field
--
-- NULL is the fourth option and the correct one: it says "we do not know",
-- which is true, and it is what `fact_check_evidence.published_at` already
-- does for the same reason. `ingested_at` stays NOT NULL and keeps answering
-- the different question of when WE saw the article.
--
-- WHY A TABLE REBUILD
--
-- SQLite cannot relax a NOT NULL constraint with ALTER TABLE. The supported
-- route is the 12-step procedure from the SQLite docs ("Making Other Kinds Of
-- Table Schema Changes"): build the new table, copy, drop, rename, then put
-- back everything that was attached to the old table.
--
-- THREE THINGS THIS MIGRATION MUST NOT BREAK, and how each is handled:
--
--   1. fact_checks.article_id REFERENCES articles(id) ON DELETE SET NULL.
--      A naive DROP TABLE articles fires that action and quietly NULLs the
--      article link on published fact-checks — mutating append-only rows.
--      (The append-only UPDATE trigger would not even catch it: article_id is
--      deliberately not in its column list.) Foreign keys are therefore
--      DISABLED for the duration and re-enabled at the end — step 1 of the
--      SQLite recipe — and `PRAGMA foreign_key_check` verifies nothing was
--      orphaned before they go back on.
--
--      NOT `defer_foreign_keys`: that pragma only has effect INSIDE an
--      explicit transaction and resets at every commit, so under autocommit
--      (how migration files run) it silently does nothing. Measured, not
--      assumed — the first draft used it and the fact_checks row came back
--      with article_id = NULL. The test below is what caught it.
--
--   2. articles_fts is an EXTERNAL-CONTENT FTS5 table keyed on articles.rowid.
--      A rebuilt table does not guarantee the same rowids, which would leave
--      every search result pointing at the wrong row. The index is therefore
--      rebuilt from scratch at the end rather than assumed to survive.
--
--   3. Indexes and the FTS sync triggers are dropped along with the old table
--      and are recreated verbatim below.
--
-- Everything else in 0001 — the append-only triggers on fact_checks, the six
-- verdict CHECK, claims_fts — is untouched by design: this migration does not
-- name those objects.
--
-- VERIFIED against real SQLite in tests/db/migration-0002.test.ts: data
-- survives, a NULL publication date is accepted, a referencing fact_check row
-- keeps its article_id, FTS still matches, and re-applying is a no-op.
-- ============================================================================

-- Step 1 of the SQLite table-rebuild recipe. Connection-level, and it must be
-- OUTSIDE any transaction to take effect. Without it, the DROP below fires
-- ON DELETE SET NULL and blanks fact_checks.article_id.
PRAGMA foreign_keys = OFF;

-- The FTS sync triggers reference `articles` by name and must not fire while
-- the table is being swapped. Recreated at the bottom.
DROP TRIGGER IF EXISTS articles_fts_insert;
DROP TRIGGER IF EXISTS articles_fts_delete;
DROP TRIGGER IF EXISTS articles_fts_update;

-- Identical to 0001 in every respect EXCEPT `published_at`, which loses
-- NOT NULL. Kept spelled out rather than generated so a reviewer can diff the
-- two definitions directly.
CREATE TABLE IF NOT EXISTS articles_new (
  id                   TEXT PRIMARY KEY,
  slug                 TEXT NOT NULL UNIQUE,
  canonical_url        TEXT NOT NULL UNIQUE,
  original_url         TEXT NOT NULL,

  title                TEXT NOT NULL,
  summary              TEXT,
  image_url            TEXT,

  source_id            TEXT REFERENCES sources (id) ON DELETE SET NULL,
  publisher_name       TEXT NOT NULL,

  category             TEXT NOT NULL,
  language             TEXT NOT NULL,
  region               TEXT,

  -- THE CHANGE. NULL = the publication date genuinely could not be
  -- established. It is never a stand-in for ingested_at below.
  published_at         TEXT,
  ingested_at          TEXT NOT NULL DEFAULT (datetime('now')),

  cluster_id           TEXT REFERENCES story_clusters (id) ON DELETE SET NULL,
  reading_time_seconds INTEGER,

  provider_id          TEXT NOT NULL DEFAULT 'unknown',

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO articles_new (
  id, slug, canonical_url, original_url, title, summary, image_url,
  source_id, publisher_name, category, language, region,
  published_at, ingested_at, cluster_id, reading_time_seconds, provider_id,
  created_at, updated_at
)
SELECT
  id, slug, canonical_url, original_url, title, summary, image_url,
  source_id, publisher_name, category, language, region,
  published_at, ingested_at, cluster_id, reading_time_seconds, provider_id,
  created_at, updated_at
FROM articles;

DROP TABLE articles;
ALTER TABLE articles_new RENAME TO articles;

-- Recreated verbatim from 0001; they went with the dropped table.
CREATE INDEX IF NOT EXISTS idx_articles_feed
  ON articles (category, language, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_cluster
  ON articles (cluster_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_recent
  ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source
  ON articles (source_id);

CREATE TRIGGER IF NOT EXISTS articles_fts_insert AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts (rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_delete AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, summary)
    VALUES ('delete', old.rowid, old.title, old.summary);
END;

CREATE TRIGGER IF NOT EXISTS articles_fts_update AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts (articles_fts, rowid, title, summary)
    VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO articles_fts (rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END;

-- Rowids are not guaranteed to have survived the rebuild, so the external-
-- content index is rebuilt rather than trusted. Without this, search would
-- return rows that do not correspond to the matched documents.
INSERT INTO articles_fts (articles_fts) VALUES ('rebuild');

-- Steps 10-12 of the recipe: confirm nothing was orphaned while enforcement
-- was off, then restore it. `foreign_key_check` reports rather than raises, so
-- it is a diagnostic in the migration output, not a gate.
PRAGMA foreign_key_check;
PRAGMA foreign_keys = ON;
