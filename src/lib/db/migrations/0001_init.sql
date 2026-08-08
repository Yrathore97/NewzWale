-- ============================================================================
-- NewzWale — D1 migration 0001: initial schema
--
-- Apply:
--   local   npx wrangler d1 execute newzwale --local  --file=src/lib/db/migrations/0001_init.sql
--   remote  npx wrangler d1 execute newzwale --remote --file=src/lib/db/migrations/0001_init.sql
--
-- STATUS: VERIFIED AGAINST REAL D1 (local), Phase 1/2. Not yet applied to
-- production: the binding in wrangler.jsonc stays commented out until
-- `wrangler d1 create` yields a real database_id.
--
-- Verified with `wrangler d1 execute newzwale --local`, NOT only with Node's
-- bundled SQLite — D1 compatibility was not assumed:
--   * migration applies cleanly, and is idempotent
--   * all 5 tables + both FTS indexes created
--   * FTS triggers fire on insert (matched 'repo' in a seeded article)
--   * six-verdict CHECK accepts all six and REJECTS the old 4-value enum
--     ('verified' -> SQLITE_CONSTRAINT_CHECK)
--   * DELETE blocked -> SQLITE_CONSTRAINT_TRIGGER "append-only"
--   * substantive UPDATE blocked -> SQLITE_CONSTRAINT_TRIGGER
--   * superseded_by UPDATE permitted
--   * published_at NULL accepted; accessed_at auto-populated and distinct
--   * stance CHECK rejects an out-of-set value
--
-- NO D1/SQLite dialect differences were found; this file needed no adaptation.
--
-- ONE FORMAT NOTE: SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS'
-- (space separator, no timezone), not strict ISO-8601. Application-written
-- timestamps use nowIso() in ../client.ts, which produces real ISO-8601, so
-- DEFAULT-generated and application-generated values differ in shape. Compare
-- and sort on these columns with that in mind, or write the value explicitly.
--
-- SCOPE. Five tables plus two FTS indexes. Deliberately NOT created:
--   users              — no accounts yet (architecture AD-08). The nullable
--                        user_id columns below are the forward hook, so adding
--                        accounts later is additive rather than a destructive
--                        migration.
--   verdicts           — a lookup table for six fixed values is ceremony. A
--                        CHECK constraint enforces the same thing and reads
--                        better in queries.
--   source_snapshots   — archiving source pages carries storage and copyright
--                        cost. quoted_passage below preserves what the verdict
--                        actually relied on, which is the auditability we need.
--   related_claims     — derivable from claims_fts. A table would be a second
--                        thing to keep in sync for no gain.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- sources — publishers, and the provenance signals the fact-check engine needs.
--
-- Trust here is PROVENANCE, never political lean. An outlet's editorial
-- position is not evidence about a factual claim; treating it as such
-- dismisses accurate reporting from disliked outlets and launders inaccurate
-- reporting from trusted ones.
--
-- Three PUBLIC tiers are shown to readers. The extra columns are internal
-- signals that feed corroboration without being surfaced as a score.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
  id                TEXT PRIMARY KEY,
  domain            TEXT NOT NULL UNIQUE,        -- registrable domain, lowercased, no www.
  display_name      TEXT NOT NULL,
  country           TEXT,

  -- PUBLIC tier. tier1 = primary/authoritative, tier2 = high-quality
  -- secondary, tier3 = discovery/contextual. Tier 3 may contribute context but
  -- must never independently establish a high-confidence verdict.
  tier              TEXT NOT NULL DEFAULT 'tier3'
                      CHECK (tier IN ('tier1', 'tier2', 'tier3')),

  -- INTERNAL signals. Not rendered as a score.
  source_type       TEXT CHECK (source_type IN (
                      'government', 'regulator', 'court', 'academic',
                      'ifcn_factchecker', 'news', 'wire_agency',
                      'blog', 'forum', 'social', 'aggregator', 'unknown')),
  is_primary_source INTEGER NOT NULL DEFAULT 0 CHECK (is_primary_source IN (0, 1)),
  ifcn_signatory    INTEGER NOT NULL DEFAULT 0 CHECK (ifcn_signatory IN (0, 1)),
  low_reliability   INTEGER NOT NULL DEFAULT 0 CHECK (low_reliability IN (0, 1)),

  -- Independence. Outlets sharing an owner, or republishing the same wire
  -- copy, are NOT independent corroboration. Without this, "two independent
  -- sources" is trivially satisfied by PTI/ANI syndication across Indian media.
  owner_group       TEXT,
  is_wire_agency    INTEGER NOT NULL DEFAULT 0 CHECK (is_wire_agency IN (0, 1)),

  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_tier  ON sources (tier);
CREATE INDEX IF NOT EXISTS idx_sources_owner ON sources (owner_group) WHERE owner_group IS NOT NULL;

-- ---------------------------------------------------------------------------
-- story_clusters — one real-world story, covered by many articles.
--
-- Powers "Also reported by N sources", honest deduplication, and trending
-- ranked by breadth of coverage rather than by volume.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_clusters (
  id                        TEXT PRIMARY KEY,
  representative_article_id TEXT,               -- FK added after articles exists
  headline                  TEXT NOT NULL,
  category                  TEXT NOT NULL,
  language                  TEXT NOT NULL,
  region                    TEXT,

  article_count             INTEGER NOT NULL DEFAULT 1,
  -- Distinct INDEPENDENT sources, after collapsing wire copy and shared
  -- ownership. Not a row count.
  source_count              INTEGER NOT NULL DEFAULT 1,

  -- Transparent ranking: recency decay x log(source breadth) x velocity.
  -- Never click counts (we have none) or editorial promotion.
  trending_score            REAL NOT NULL DEFAULT 0,

  first_seen_at             TEXT NOT NULL,
  last_seen_at              TEXT NOT NULL,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clusters_trending
  ON story_clusters (trending_score DESC, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_clusters_feed
  ON story_clusters (category, language, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- articles — normalised, deduplicated headlines. NOT article bodies.
--
-- NewzWale links out to publishers and does not republish. `summary` holds the
-- publisher's own description verbatim; it is never model-generated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
  id                   TEXT PRIMARY KEY,        -- sha256(canonical_url)
  slug                 TEXT NOT NULL UNIQUE,
  -- utm_*/fbclid/gclid stripped, fragment removed, trailing slash normalised.
  -- Exact-URL dedup fails without this: tracking params defeat it.
  canonical_url        TEXT NOT NULL UNIQUE,
  original_url         TEXT NOT NULL,

  title                TEXT NOT NULL,
  summary              TEXT,                    -- publisher's own words, verbatim
  image_url            TEXT,

  source_id            TEXT REFERENCES sources (id) ON DELETE SET NULL,
  publisher_name       TEXT NOT NULL,           -- denormalised: survives source deletion

  -- OUR category slug, not the upstream provider's. Today Article.category
  -- carries the upstream value, so a card in the Sports rail can display a
  -- different badge (audit P-17).
  category             TEXT NOT NULL,
  language             TEXT NOT NULL,
  region               TEXT,

  published_at         TEXT NOT NULL,           -- ISO 8601, from the publisher
  ingested_at          TEXT NOT NULL DEFAULT (datetime('now')),

  cluster_id           TEXT REFERENCES story_clusters (id) ON DELETE SET NULL,
  reading_time_seconds INTEGER,                 -- estimate; labelled as such in UI

  -- Which provider supplied this row, so a degraded feed is observable.
  provider_id          TEXT NOT NULL DEFAULT 'unknown',

  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_articles_feed
  ON articles (category, language, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_cluster
  ON articles (cluster_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_recent
  ON articles (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_source
  ON articles (source_id);

-- ---------------------------------------------------------------------------
-- fact_checks — APPEND-ONLY.
--
-- A fact-check is a published claim about the world. Once a reader has seen a
-- verdict and shared its permalink, that row must keep saying what they saw.
-- Re-running a claim under new methodology therefore INSERTs a new row and
-- points the old one at it via superseded_by; it never rewrites history.
-- Triggers below enforce this at the database, not by convention.
--
-- Reproducibility: pipeline_version + evidence_version + model_id record the
-- methodology that produced the row. The same triple forms the cache identity
-- (src/lib/factcheck/version.ts), so a methodology bump makes stale verdicts
-- unreachable without a manual purge.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_checks (
  -- sha256(normalized_claim | pipeline_identity) — stable, shareable, and the
  -- same identity the KV cache key uses.
  id                    TEXT PRIMARY KEY,

  claim                 TEXT NOT NULL,          -- as extracted and shown to the user
  claim_normalized      TEXT NOT NULL,          -- canonical form used for id and dedup
  claim_source          TEXT NOT NULL DEFAULT 'text'
                          CHECK (claim_source IN ('text', 'url', 'image')),
  origin_url            TEXT,                   -- when submitted as a URL
  claim_topic           TEXT,                   -- classification, for related claims

  -- The six canonical verdicts. Locked.
  -- NOTE ON SEQUENCING: the shipped pipeline still emits the older four-value
  -- enum. Nothing writes this table until Phase 4, by which point Phase 3 has
  -- migrated the enum. Do not begin persisting before that ordering holds, or
  -- these inserts will fail the CHECK — which is the intended safety net.
  verdict               TEXT NOT NULL
                          CHECK (verdict IN (
                            'true', 'false', 'partly_true',
                            'misleading', 'unverified', 'needs_context')),

  -- Independent of the verdict, and always displayed alongside it. Computed
  -- deterministically from the evidence set — never self-reported by a model.
  evidence_strength     TEXT NOT NULL
                          CHECK (evidence_strength IN ('strong', 'moderate', 'weak', 'none')),

  -- Keeps fact separate from inference (principle 4).
  basis                 TEXT NOT NULL DEFAULT 'none'
                          CHECK (basis IN ('certified', 'ai_assessment', 'none')),

  summary               TEXT NOT NULL,          -- one-line answer
  reasoning             TEXT NOT NULL,          -- "why this verdict", cites [1] [3]
  limitations           TEXT,                   -- what could NOT be established

  -- Principle 6, stored rather than recomputed: a verdict records how many
  -- genuinely independent domains backed it, so the UI can refuse to present a
  -- strong verdict backed by one.
  independent_supporting_domains   INTEGER NOT NULL DEFAULT 0,
  independent_contradicting_domains INTEGER NOT NULL DEFAULT 0,

  -- Reproducibility triple.
  pipeline_version      INTEGER NOT NULL,
  evidence_version      INTEGER NOT NULL,
  model_id              TEXT,                   -- NULL when no model ran (certified only)

  -- Nullable from migration 1 so accounts are additive later (AD-08).
  user_id               TEXT,
  -- Coarse attribution without storing an IP.
  device_hash           TEXT,

  article_id            TEXT REFERENCES articles (id) ON DELETE SET NULL,

  -- Append-only supersession chain.
  superseded_by         TEXT REFERENCES fact_checks (id) ON DELETE SET NULL,

  checked_at            TEXT NOT NULL DEFAULT (datetime('now')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fc_verdict  ON fact_checks (verdict, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_fc_recent   ON fact_checks (checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_fc_norm     ON fact_checks (claim_normalized);
CREATE INDEX IF NOT EXISTS idx_fc_user     ON fact_checks (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fc_article  ON fact_checks (article_id) WHERE article_id IS NOT NULL;
-- Only rows that are still current.
CREATE INDEX IF NOT EXISTS idx_fc_current  ON fact_checks (checked_at DESC) WHERE superseded_by IS NULL;

-- Append-only enforcement. Deletion is blocked outright. Updates are blocked
-- except for superseded_by, which is the one field that must change when a
-- newer check replaces this one.
CREATE TRIGGER IF NOT EXISTS fact_checks_no_delete
BEFORE DELETE ON fact_checks
BEGIN
  SELECT RAISE(ABORT, 'fact_checks is append-only: delete is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS fact_checks_no_update
BEFORE UPDATE OF
  id, claim, claim_normalized, verdict, evidence_strength, basis,
  summary, reasoning, limitations, pipeline_version, evidence_version,
  model_id, checked_at
ON fact_checks
BEGIN
  SELECT RAISE(ABORT, 'fact_checks is append-only: insert a new row and set superseded_by');
END;

-- ---------------------------------------------------------------------------
-- fact_check_evidence — one retrieved source, as it was used.
--
-- Principle 7 lives here. published_at and accessed_at are SEPARATE columns
-- and one is never substituted for the other: published_at NULL means the
-- publication date genuinely could not be determined. Backfilling it with the
-- fetch time would fabricate a date, which is worse than admitting we lack one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fact_check_evidence (
  id                TEXT PRIMARY KEY,
  fact_check_id     TEXT NOT NULL REFERENCES fact_checks (id) ON DELETE CASCADE,
  -- Display order; also the [1] [2] [3] the reasoning text cites.
  position          INTEGER NOT NULL,

  url               TEXT NOT NULL,
  title             TEXT NOT NULL,
  publisher         TEXT NOT NULL,
  source_id         TEXT REFERENCES sources (id) ON DELETE SET NULL,
  -- Snapshot of the tier AT CHECK TIME. A later re-tiering must not silently
  -- rewrite the basis of an already-published verdict.
  tier_at_check     TEXT NOT NULL DEFAULT 'tier3'
                      CHECK (tier_at_check IN ('tier1', 'tier2', 'tier3')),

  published_at      TEXT,                       -- NULL = genuinely unknown
  accessed_at       TEXT NOT NULL DEFAULT (datetime('now')),

  stance            TEXT NOT NULL
                      CHECK (stance IN ('supporting', 'contradicting', 'contextual')),
  relevance         TEXT CHECK (relevance IN ('high', 'medium', 'low')),

  -- The exact text the verdict relied on, so a reader can check our reading.
  quoted_passage    TEXT,
  -- Why this item matters to the claim.
  reason            TEXT,

  -- Whether the page was actually read or only a search snippet was available.
  -- Today the pipeline falls back to snippets silently; the reader is entitled
  -- to know which happened.
  read_method       TEXT NOT NULL DEFAULT 'search_snippet'
                      CHECK (read_method IN ('full_page', 'search_snippet')),

  -- Set when the injection pre-filter matched this passage. Retained rather
  -- than dropped so a poisoned source is auditable after the fact.
  injection_flagged INTEGER NOT NULL DEFAULT 0 CHECK (injection_flagged IN (0, 1)),

  -- The publisher's own rating, on the certified path only.
  publisher_rating  TEXT,

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (fact_check_id, position)
);

CREATE INDEX IF NOT EXISTS idx_evidence_check  ON fact_check_evidence (fact_check_id, position);
CREATE INDEX IF NOT EXISTS idx_evidence_stance ON fact_check_evidence (fact_check_id, stance);

-- ---------------------------------------------------------------------------
-- Full-text search. External-content FTS5 tables stay in sync via triggers.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5 (
  title,
  summary,
  content = 'articles',
  content_rowid = 'rowid',
  -- remove_diacritics 2 is needed for Indic scripts. FTS5's default tokenizer
  -- handles Devanagari/Tamil/Telugu poorly; this must be verified against real
  -- multilingual content before search ships (implementation plan, Phase 7).
  tokenize = "unicode61 remove_diacritics 2"
);

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

CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5 (
  claim,
  summary,
  content = 'fact_checks',
  content_rowid = 'rowid',
  tokenize = "unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS claims_fts_insert AFTER INSERT ON fact_checks BEGIN
  INSERT INTO claims_fts (rowid, claim, summary) VALUES (new.rowid, new.claim, new.summary);
END;

-- No delete/update triggers for claims_fts: fact_checks is append-only, so
-- neither event can occur. Adding them would imply a mutability that the
-- triggers above explicitly forbid.

-- ---------------------------------------------------------------------------
-- Deferred FK: story_clusters.representative_article_id -> articles.id.
--
-- Declared as a comment rather than a constraint because SQLite cannot ALTER
-- TABLE ADD CONSTRAINT, and the two tables reference each other. Enforced in
-- the query layer (src/lib/db/queries/) instead.
-- ---------------------------------------------------------------------------
