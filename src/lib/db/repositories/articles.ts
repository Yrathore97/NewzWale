/** Repositories for sources, articles and story_clusters.
 *
 *  All SQL is parameterised. `canonical_url` is the dedup boundary and carries
 *  a UNIQUE constraint, so ingestion can INSERT OR IGNORE and stay idempotent
 *  - the scheduled job runs every few minutes over overlapping feeds and must
 *  not create duplicates. */

import {
  requireDb,
  nowIso,
  encodeCursor,
  type Cursor,
  type Db,
} from '../client';

/** One page of rows plus the cursor that continues it.
 *
 *  `cursor` is absent (not null) when the page is the last one, so callers can
 *  use `'cursor' in page` and the API envelope can omit the key entirely
 *  rather than serialising a null. */
export interface Page<T> {
  items: T[];
  cursor?: string;
}

/** Turns a user's search words into an FTS5 MATCH expression.
 *
 *  FTS5 MATCH is a query LANGUAGE, not a literal. Binding raw user text as a
 *  parameter stops SQL injection but NOT FTS syntax errors or operator abuse:
 *  a stray `"` throws, and `NEAR`/`*`/`OR`/`-` silently change what was asked.
 *  So each whitespace-separated word is wrapped as a quoted phrase (with `"`
 *  doubled, FTS5's own escape), and the phrases are joined by space — FTS5's
 *  implicit AND.
 *
 *  Result: every operator degrades to a literal word. A search for `NEAR` finds
 *  the word "near". Returns null when nothing survives, which the callers treat
 *  as an empty result rather than running a match on an empty string. */
export function ftsQuery(raw: string): string | null {
  const phrases = raw
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w.replace(/"/g, '""')}"`);
  return phrases.length > 0 ? phrases.join(' ') : null;
}

/** ── Search strategy: FTS5 for Latin, LIKE for everything else ──────────────
 *
 *  The implementation plan (Phase 7) prescribes this exact fallback: "fall back
 *  to LIKE-based matching for scripts FTS handles poorly rather than shipping
 *  search that silently fails for 12 of 13 languages." ICU was never an option
 *  — D1 runs stock SQLite with no loadable extensions.
 *
 *  MEASURED, against real SQLite with the schema's own tokenizer. Full-word
 *  queries actually work in every script; the failure is STEM queries, which
 *  are the normal case in agglutinative Indic languages where the
 *  postposition attaches to the noun:
 *
 *      query        text in headline     FTS5    LIKE
 *      flood        floods               MISS    HIT
 *      बारिश        बारिश से             HIT     HIT
 *      বৃষ্টি        বৃষ্টিতে              HIT     HIT
 *      கனமழை        கனமழையால்            HIT     HIT
 *      வர்షాల       వర్షాలతో             MISS    HIT
 *      కేరళ         కేరళలో               MISS    HIT
 *      بارش         بارش سے              HIT     HIT
 *
 *  The real defect is not "FTS fails on Indic" — it is that FTS is
 *  INCONSISTENT across scripts. Devanagari, Bengali and Tamil get accidental
 *  substring behaviour (the query shatters into the same consonant fragments
 *  as the text and phrase-matches a prefix of them), Telugu does not, and
 *  English gets strict token matching. The same user action means different
 *  things in different languages, which is not a defensible search contract.
 *
 *  LIKE gives ONE semantic — substring — in every script. It is slower
 *  (`%term%` cannot use an index, so it scans), which is why Latin queries
 *  stay on the indexed FTS path where its token semantics are correct and
 *  predictable.
 *
 *  ponytail: full scan on the LIKE path, bounded only by LIMIT. Fine at
 *  current corpus size; if it stops being fine, the upgrade is a normalised
 *  search column plus a trigram index, not a smaller LIMIT. */

/** True when the query contains any character outside Basic/Latin-1 letters.
 *
 *  Deliberately a Latin test rather than a list of "bad scripts". A list would
 *  need extending for every script the product adds, and the failure mode of
 *  forgetting one is silent — that language quietly gets the inconsistent
 *  path. Anything non-Latin takes the uniform path instead; being slower for
 *  a script FTS would have handled is a much cheaper mistake.
 *
 *  Digits and punctuation are ignored: "2026" or "covid-19" must not be enough
 *  to move a query off the fast path. */
export function needsLikeFallback(raw: string): boolean {
  for (const ch of raw) {
    if (/\p{L}/u.test(ch) && !/[A-Za-zÀ-ɏ]/.test(ch)) return true;
  }
  return false;
}

/** LIKE's own escape character. Backslash, declared via ESCAPE in every query
 *  that uses it — SQLite has no default. */
const LIKE_ESCAPE = '\\';

/** Longest term list a LIKE search will build, so one query cannot become
 *  dozens of scans. */
const MAX_LIKE_TERMS = 8;

/** Escapes a term for use inside a `%...%` LIKE pattern.
 *
 *  THIS IS A SECURITY BOUNDARY, not tidiness. `%` and `_` are LIKE wildcards,
 *  so an unescaped query of `%` matches every row — measured: 7 of 7 rows
 *  returned unescaped, 0 escaped. That is a full-table read from a public
 *  endpoint, bounded only by LIMIT. The escape character itself is escaped
 *  first, or escaping would be reversible. */
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (c) => LIKE_ESCAPE + c);
  return `%${escaped}%`;
}

/** Splits a query into bounded, escaped LIKE patterns. Null when empty.
 *
 *  Splits on ANY non-alphanumeric character, not on whitespace. FTS5's
 *  tokenizer strips punctuation internally, so a whitespace-only split made
 *  the two paths disagree: `मानसून, बाढ़` kept the comma, searched for the
 *  literal `%मानसून,%` and found nothing, while the same query in English
 *  matched. Re-introducing an inconsistency between scripts is precisely what
 *  this fallback exists to remove.
 *
 *  `\p{M}` is retained for the reason established in Phase 5B: Devanagari
 *  vowel signs are combining Marks, and dropping them shatters the word.
 *
 *  A side effect worth stating: `%` and `_` are non-alphanumeric, so they are
 *  now split out and can never reach a pattern at all. `likePattern` still
 *  escapes them — defence in depth, and it is independently tested. */
export function likeTerms(raw: string): string[] | null {
  const terms = raw
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, MAX_LIKE_TERMS)
    .map(likePattern);
  return terms.length > 0 ? terms : null;
}

export type SourceTier = 'tier1' | 'tier2' | 'tier3';

export interface SourceRecord {
  id: string;
  domain: string;
  displayName: string;
  country?: string | null;
  tier: SourceTier;
  sourceType?: string | null;
  isPrimarySource?: boolean;
  ifcnSignatory?: boolean;
  lowReliability?: boolean;
  /** Outlets sharing an owner are not independent corroboration. */
  ownerGroup?: string | null;
  /** Wire agencies syndicate one story to many outlets; those outlets are not
   *  independent either. */
  isWireAgency?: boolean;
  notes?: string | null;
}

export interface ArticleRecord {
  id: string;
  slug: string;
  canonicalUrl: string;
  originalUrl: string;
  title: string;
  summary?: string | null;
  imageUrl?: string | null;
  sourceId?: string | null;
  publisherName: string;
  /** OUR category slug, not the upstream provider's value. */
  category: string;
  language: string;
  region?: string | null;
  /** NULL when the publication date genuinely could not be established
   *  (migration 0002). Never a stand-in for ingestion time. */
  publishedAt: string | null;
  clusterId?: string | null;
  readingTimeSeconds?: number | null;
  providerId: string;
}

export class SourceRepository {
  private readonly db: Db;
  constructor(db: Db | undefined) {
    this.db = requireDb(db);
  }

  async upsert(source: SourceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sources (
           id, domain, display_name, country, tier, source_type,
           is_primary_source, ifcn_signatory, low_reliability,
           owner_group, is_wire_agency, notes, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           display_name = excluded.display_name,
           tier = excluded.tier,
           source_type = excluded.source_type,
           is_primary_source = excluded.is_primary_source,
           ifcn_signatory = excluded.ifcn_signatory,
           low_reliability = excluded.low_reliability,
           owner_group = excluded.owner_group,
           is_wire_agency = excluded.is_wire_agency,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .bind(
        source.id,
        source.domain.toLowerCase(),
        source.displayName,
        source.country ?? null,
        source.tier,
        source.sourceType ?? null,
        source.isPrimarySource ? 1 : 0,
        source.ifcnSignatory ? 1 : 0,
        source.lowReliability ? 1 : 0,
        source.ownerGroup ?? null,
        source.isWireAgency ? 1 : 0,
        source.notes ?? null,
        nowIso(),
      )
      .run();
  }

  /** Registers a publisher the first time it is seen, and never touches it again.
   *
   *  INGESTION MUST USE THIS, NOT `upsert`. The two differ on what happens to
   *  an existing row, and the difference is load-bearing:
   *
   *  `upsert` overwrites tier, owner_group, ifcn_signatory and the independence
   *  flags with whatever the caller passed. Ingestion knows none of those — it
   *  can only supply the schema default, `tier3`. So calling `upsert` from a
   *  scheduled run would silently DOWNGRADE a curated tier1 publisher (rbi.org.in,
   *  a court, an IFCN signatory) to tier3 on every pass, and blank out the
   *  owner_group that stops two outlets under one owner counting as independent
   *  corroboration. Verdicts would quietly weaken as a side effect of a news
   *  fetch, with nothing in the logs to show it.
   *
   *  Discovery and curation are different jobs. This one only discovers. */
  async ensureExists(source: SourceRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO sources (id, domain, display_name, tier)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(source.id, source.domain.toLowerCase(), source.displayName, source.tier)
      .run();
  }

  async findByDomain(domain: string): Promise<SourceRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM sources WHERE domain = ?')
      .bind(domain.toLowerCase())
      .first<Record<string, unknown>>();
    return row ? toSource(row) : null;
  }

  async all(): Promise<SourceRecord[]> {
    const rows = await this.db.prepare('SELECT * FROM sources').all<Record<string, unknown>>();
    return rows.results.map(toSource);
  }
}

/** The ordering key for every paginated article query.
 *
 *  Since migration 0002 `published_at` may be NULL, and NULL breaks keyset
 *  pagination outright: `published_at < ?` evaluates to NULL for an undated
 *  row, which is not true, so those rows become unreachable past the first
 *  page — silently dropped from the feed rather than merely mis-sorted.
 *
 *  COALESCE to '' gives a TOTAL order instead. '' sorts below every ISO-8601
 *  timestamp, so undated articles land at the end of a newest-first feed,
 *  which is the honest position for "we do not know when this was published".
 *
 *  This is an ORDERING key only. It never reaches the response: `toArticle`
 *  returns publishedAt as null. Nothing here invents a date.
 *
 *  Used identically in ORDER BY and in the cursor comparison — if the two ever
 *  disagreed, pagination would skip or repeat rows. */
const SORT_KEY = "COALESCE(published_at, '')";

/** The same key qualified for queries that join `articles` as `a`. Both are
 *  fixed literals in this module — no caller-supplied value is ever spliced
 *  into SQL. */
const SORT_KEY_A = "COALESCE(a.published_at, '')";

export class ArticleRepository {
  private readonly db: Db;
  constructor(db: Db | undefined) {
    this.db = requireDb(db);
  }

  /** Idempotent insert.
   *
   *  INSERT OR IGNORE against the UNIQUE canonical_url, so re-ingesting an
   *  overlapping feed is a no-op rather than a duplicate. Deliberately does
   *  NOT update an existing row: a publisher silently rewriting a headline
   *  should not retroactively change what we showed a reader. */
  async insertIfNew(article: ArticleRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO articles (
           id, slug, canonical_url, original_url, title, summary, image_url,
           source_id, publisher_name, category, language, region,
           published_at, ingested_at, cluster_id, reading_time_seconds, provider_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        article.id,
        article.slug,
        article.canonicalUrl,
        article.originalUrl,
        article.title,
        article.summary ?? null,
        article.imageUrl ?? null,
        article.sourceId ?? null,
        article.publisherName,
        article.category,
        article.language,
        article.region ?? null,
        article.publishedAt ?? null,
        nowIso(),
        article.clusterId ?? null,
        article.readingTimeSeconds ?? null,
        article.providerId,
      )
      .run();
  }

  async insertMany(articles: ArticleRecord[]): Promise<void> {
    if (articles.length === 0) return;
    for (const article of articles) {
      await this.insertIfNew(article);
    }
  }

  async findBySlug(slug: string): Promise<ArticleRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM articles WHERE slug = ?')
      .bind(slug)
      .first<Record<string, unknown>>();
    return row ? toArticle(row) : null;
  }

  async findByCanonicalUrl(url: string): Promise<ArticleRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM articles WHERE canonical_url = ?')
      .bind(url)
      .first<Record<string, unknown>>();
    return row ? toArticle(row) : null;
  }

  async listByCategory(category: string, language: string, limit = 24): Promise<ArticleRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .prepare(
        `SELECT * FROM articles
         WHERE category = ? AND language = ?
         ORDER BY published_at DESC
         LIMIT ?`,
      )
      .bind(category, language, bounded)
      .all<Record<string, unknown>>();
    return rows.results.map(toArticle);
  }

  async findById(id: string): Promise<ArticleRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM articles WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    return row ? toArticle(row) : null;
  }

  /** Cursor-paginated category feed.
   *
   *  Ordered by (published_at DESC, id DESC) and continued by keyset rather
   *  than OFFSET — ingestion runs continuously, so an offset would skip or
   *  repeat rows as the feed shifts beneath it.
   *
   *  The comparison is spelled out as `(published_at < ? OR (published_at = ?
   *  AND id < ?))` rather than as an SQLite row-value `(a,b) < (?,?)`. Both
   *  work on current D1, but the expanded form has no version floor, and this
   *  file is the layer that must not surprise anyone at deploy time.
   *
   *  Fetches limit+1 rows to learn whether a further page exists without a
   *  second COUNT query, then trims. */
  async pageByCategory(
    category: string,
    language: string,
    opts: { limit?: number; cursor?: Cursor | null } = {},
  ): Promise<Page<ArticleRecord>> {
    const bounded = Math.min(Math.max(Math.trunc(opts.limit ?? 24), 1), 100);
    const cursor = opts.cursor ?? null;

    const rows = cursor
      ? await this.db
          .prepare(
            `SELECT * FROM articles
             WHERE category = ? AND language = ?
               AND (${SORT_KEY} < ? OR (${SORT_KEY} = ? AND id < ?))
             ORDER BY ${SORT_KEY} DESC, id DESC
             LIMIT ?`,
          )
          .bind(category, language, cursor.sortValue, cursor.sortValue, cursor.id, bounded + 1)
          .all<Record<string, unknown>>()
      : await this.db
          .prepare(
            `SELECT * FROM articles
             WHERE category = ? AND language = ?
             ORDER BY ${SORT_KEY} DESC, id DESC
             LIMIT ?`,
          )
          .bind(category, language, bounded + 1)
          .all<Record<string, unknown>>();

    return toPage(rows.results.map(toArticle), bounded);
  }

  /** Full-text search over headlines and publisher summaries.
   *
   *  Joins articles_fts back to articles by rowid: articles_fts is an
   *  external-content table, so it stores no column data of its own.
   *
   *  Ordered by FTS5 `rank` (relevance), then recency to break ties
   *  deterministically — without the tiebreak, two equally-ranked rows could
   *  swap between calls and a cursor would skip one.
   *
   *  SCRIPT COVERAGE IS NOT ASSUMED. The tokenizer is `unicode61
   *  remove_diacritics 2`, which segments on whitespace and punctuation. That
   *  suits Devanagari, Bengali and Tamil, which space their words. It does NOT
   *  give Urdu or any unspaced script proper segmentation. Measured, not
   *  claimed: see the multilingual cases in tests/db/repositories.test.ts. */
  async search(query: string, limit = 24): Promise<ArticleRecord[]> {
    return (await this.searchPage(query, { limit })).items;
  }

  /** Cursor-paginated full-text search, with optional category/language filters.
   *
   *  ORDERED BY RECENCY, NOT BY RELEVANCE — a deliberate choice, not an
   *  oversight. FTS5 `rank` is BM25, and Phase 5A measured that unicode61
   *  splits Devanagari and Bengali words into consonant fragments: term
   *  frequencies are then computed over fragments rather than words, so the
   *  relevance score is not meaningful in those scripts. Ordering a
   *  multilingual product by a number that is trustworthy in English and
   *  arbitrary in Hindi would be worse than not claiming relevance at all.
   *
   *  Recency is honest, uniform across scripts, and gives a TOTAL order, which
   *  rank does not — and a total order is what keyset pagination requires to
   *  avoid skipping or repeating rows between pages. Same SORT_KEY and cursor
   *  as the category feed, so one pagination mechanism serves both.
   *
   *  Revisit when the tokenizer is fixed, not before. */
  async searchPage(
    query: string,
    opts: {
      category?: string | null;
      language?: string | null;
      limit?: number;
      cursor?: Cursor | null;
    } = {},
  ): Promise<Page<ArticleRecord>> {
    const bounded = Math.min(Math.max(Math.trunc(opts.limit ?? 24), 1), 100);
    const cursor = opts.cursor ?? null;

    // Filters are appended as fixed SQL fragments with bound parameters; the
    // VALUES are always bound, never interpolated.
    const conditions: string[] = [];
    const params: unknown[] = [];

    // Latin queries use the FTS index; everything else takes the LIKE path,
    // for the measured reasons documented on `needsLikeFallback`.
    const useLike = needsLikeFallback(query);

    if (useLike) {
      const terms = likeTerms(query);
      if (!terms) return { items: [] };
      // Every term must appear, in the title or the publisher's summary —
      // the same implicit AND that FTS5 applies, so the two paths agree on
      // what a multi-word query means.
      for (const term of terms) {
        conditions.push(`(a.title LIKE ? ESCAPE '${LIKE_ESCAPE}' OR a.summary LIKE ? ESCAPE '${LIKE_ESCAPE}')`);
        params.push(term, term);
      }
    } else {
      const match = ftsQuery(query);
      if (!match) return { items: [] };
      conditions.push('articles_fts MATCH ?');
      params.push(match);
    }

    if (opts.category) {
      conditions.push('a.category = ?');
      params.push(opts.category);
    }
    if (opts.language) {
      conditions.push('a.language = ?');
      params.push(opts.language);
    }
    if (cursor) {
      conditions.push(`(${SORT_KEY_A} < ? OR (${SORT_KEY_A} = ? AND a.id < ?))`);
      params.push(cursor.sortValue, cursor.sortValue, cursor.id);
    }
    params.push(bounded + 1);

    // The LIKE path queries `articles` directly; joining articles_fts would
    // reintroduce the tokenizer this path exists to avoid.
    const from = useLike
      ? 'articles a'
      : 'articles_fts f JOIN articles a ON a.rowid = f.rowid';

    const rows = await this.db
      .prepare(
        `SELECT a.* FROM ${from}
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${SORT_KEY_A} DESC, a.id DESC
         LIMIT ?`,
      )
      .bind(...params)
      .all<Record<string, unknown>>();

    return toPage(rows.results.map(toArticle), bounded);
  }

  /** Newest persisted headlines, for the ticker.
   *
   *  Reads D1 only — no provider is contacted on a reader's request. */
  async listRecent(limit = 20): Promise<ArticleRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .prepare(
        `SELECT * FROM articles
         ORDER BY ${SORT_KEY} DESC, id DESC
         LIMIT ?`,
      )
      .bind(bounded)
      .all<Record<string, unknown>>();
    return rows.results.map(toArticle);
  }

  /** Attaches an article to a story cluster.
   *
   *  The ONE column ingestion may change on an existing article. Everything
   *  else stays frozen for the reason `insertIfNew` documents: a publisher
   *  quietly rewriting a headline must not retroactively change what a reader
   *  was shown. Cluster membership is our own derived grouping, not the
   *  publisher's content, so revising it as more coverage arrives is correct. */
  async assignCluster(articleId: string, clusterId: string): Promise<void> {
    await this.db
      .prepare('UPDATE articles SET cluster_id = ?, updated_at = ? WHERE id = ?')
      .bind(clusterId, nowIso(), articleId)
      .run();
  }

  /** Other coverage of the same story, for "Also reported by". */
  async listByCluster(clusterId: string, excludeArticleId?: string): Promise<ArticleRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM articles
         WHERE cluster_id = ? AND id != ?
         ORDER BY published_at DESC`,
      )
      .bind(clusterId, excludeArticleId ?? '')
      .all<Record<string, unknown>>();
    return rows.results.map(toArticle);
  }
}

export interface StoryClusterRecord {
  id: string;
  representativeArticleId?: string | null;
  headline: string;
  category: string;
  language: string;
  region?: string | null;
  articleCount: number;
  /** Distinct INDEPENDENT sources, after collapsing wire copy and shared
   *  ownership - not a row count. */
  sourceCount: number;
  trendingScore: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export class StoryClusterRepository {
  private readonly db: Db;
  constructor(db: Db | undefined) {
    this.db = requireDb(db);
  }

  async upsert(cluster: StoryClusterRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO story_clusters (
           id, representative_article_id, headline, category, language, region,
           article_count, source_count, trending_score,
           first_seen_at, last_seen_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           headline = excluded.headline,
           article_count = excluded.article_count,
           source_count = excluded.source_count,
           trending_score = excluded.trending_score,
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        cluster.id,
        cluster.representativeArticleId ?? null,
        cluster.headline,
        cluster.category,
        cluster.language,
        cluster.region ?? null,
        cluster.articleCount,
        cluster.sourceCount,
        cluster.trendingScore,
        cluster.firstSeenAt,
        cluster.lastSeenAt,
        nowIso(),
      )
      .run();
  }

  /** Trending, ranked by the stored transparent score.
   *
   *  source_count >= 2 because a "trending story" covered by one outlet is not
   *  trending - it is one article. Breadth of independent coverage is the
   *  signal, and it is the only one we can honestly measure: we have no click
   *  counts and no social data. */
  async listTrending(limit = 20): Promise<StoryClusterRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .prepare(
        `SELECT * FROM story_clusters
         WHERE source_count >= 2
         ORDER BY trending_score DESC, last_seen_at DESC
         LIMIT ?`,
      )
      .bind(bounded)
      .all<Record<string, unknown>>();
    return rows.results.map(toCluster);
  }

  async findById(id: string): Promise<StoryClusterRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM story_clusters WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();
    return row ? toCluster(row) : null;
  }

  /** Recent clusters, for trending ranking.
   *
   *  Returns candidates ordered by recency and bounded; the SCORE is computed
   *  in the read layer (src/lib/news/read.ts) rather than read from the stored
   *  `trending_score` column. Deliberate: a stored score is only as fresh as
   *  the last job that wrote it, and its recency term decays continuously, so
   *  a persisted number is wrong the moment it is written. Computing at read
   *  time over a bounded candidate set is both cheaper and always current. */
  async listRecentClusters(sinceIso: string, limit = 200): Promise<StoryClusterRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const rows = await this.db
      .prepare(
        `SELECT * FROM story_clusters
         WHERE last_seen_at >= ?
         ORDER BY last_seen_at DESC
         LIMIT ?`,
      )
      .bind(sinceIso, bounded)
      .all<Record<string, unknown>>();
    return rows.results.map(toCluster);
  }

  /** Clusters an incoming article could plausibly join.
   *
   *  Narrowed in SQL to the same category and language and to the clustering
   *  time window, so the similarity comparison runs over a handful of rows
   *  rather than the table. Cross-language clustering is deliberately not
   *  attempted: matching a Hindi headline to an English one is a translation
   *  problem, and lexical overlap would answer it wrongly.
   *
   *  Bounded. An unbounded candidate list would make ingestion cost grow with
   *  corpus size. */
  async findCandidates(
    category: string,
    language: string,
    sinceIso: string,
    limit = 200,
  ): Promise<StoryClusterRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const rows = await this.db
      .prepare(
        `SELECT * FROM story_clusters
         WHERE category = ? AND language = ? AND last_seen_at >= ?
         ORDER BY last_seen_at DESC
         LIMIT ?`,
      )
      .bind(category, language, sinceIso, bounded)
      .all<Record<string, unknown>>();
    return rows.results.map(toCluster);
  }

  /** Recomputes a cluster's counts from the articles actually in it.
   *
   *  Derived rather than incremented. An incremented counter drifts the moment
   *  an ingestion run is retried or partially fails, and this counter is shown
   *  to readers as "also reported by N sources" — a number that must be true.
   *
   *  source_count collapses shared OWNERSHIP: outlets under one owner_group
   *  count once, because they are not independent corroboration. Articles whose
   *  publisher is not yet in `sources` fall back to their own source_id via
   *  COALESCE rather than being dropped.
   *
   *  NOT YET COLLAPSED: wire syndication. Four outlets running identical PTI
   *  copy still count as four here, because detecting that requires comparing
   *  body text we deliberately do not store. The fact-check engine has its own
   *  syndication handling for evidence; this counter does not share it. Stated
   *  so the number is not read as stronger than it is. */
  async recomputeStats(clusterId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE story_clusters SET
           article_count = (
             SELECT COUNT(*) FROM articles WHERE cluster_id = ?1
           ),
           source_count = (
             SELECT COUNT(DISTINCT COALESCE(s.owner_group, a.source_id, a.publisher_name))
             FROM articles a
             LEFT JOIN sources s ON s.id = a.source_id
             WHERE a.cluster_id = ?1
           ),
           -- MAX ignores NULLs, but a cluster whose articles are ALL undated
           -- would yield NULL into a NOT NULL column. COALESCE back to the
           -- current value keeps the row valid without inventing a date.
           last_seen_at = COALESCE(
             (SELECT MAX(published_at) FROM articles WHERE cluster_id = ?1),
             last_seen_at
           ),
           updated_at = ?2
         WHERE id = ?1`,
      )
      .bind(clusterId, nowIso())
      .run();
  }
}

/** Trims an over-fetched result set (limit+1) into a page plus its cursor.
 *
 *  Shared so "is there another page" is decided once. Every row type paged
 *  here sorts by SORT_KEY with id as the tiebreak, matching the ORDER BY. */
function toPage<T extends { id: string; publishedAt: string | null }>(
  rows: T[],
  limit: number,
): Page<T> {
  if (rows.length <= limit) return { items: rows };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  return {
    items,
    // Mirrors SORT_KEY: an undated row's ordering key is '', not null.
    cursor: encodeCursor({ sortValue: last.publishedAt ?? '', id: last.id }),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}
function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

function toSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: str(row.id),
    domain: str(row.domain),
    displayName: str(row.display_name),
    country: nullableStr(row.country),
    tier: str(row.tier) as SourceTier,
    sourceType: nullableStr(row.source_type),
    isPrimarySource: num(row.is_primary_source) === 1,
    ifcnSignatory: num(row.ifcn_signatory) === 1,
    lowReliability: num(row.low_reliability) === 1,
    ownerGroup: nullableStr(row.owner_group),
    isWireAgency: num(row.is_wire_agency) === 1,
    notes: nullableStr(row.notes),
  };
}

function toArticle(row: Record<string, unknown>): ArticleRecord {
  return {
    id: str(row.id),
    slug: str(row.slug),
    canonicalUrl: str(row.canonical_url),
    originalUrl: str(row.original_url),
    title: str(row.title),
    summary: nullableStr(row.summary),
    imageUrl: nullableStr(row.image_url),
    sourceId: nullableStr(row.source_id),
    publisherName: str(row.publisher_name),
    category: str(row.category),
    language: str(row.language),
    region: nullableStr(row.region),
    // Preserved as null. Coercing it to '' or to a date would turn "we do not
    // know when this was published" into a claim about when it was.
    publishedAt:
      row.published_at === null || row.published_at === undefined ? null : str(row.published_at),
    clusterId: nullableStr(row.cluster_id),
    readingTimeSeconds: row.reading_time_seconds === null ? null : num(row.reading_time_seconds),
    providerId: str(row.provider_id),
  };
}

function toCluster(row: Record<string, unknown>): StoryClusterRecord {
  return {
    id: str(row.id),
    representativeArticleId: nullableStr(row.representative_article_id),
    headline: str(row.headline),
    category: str(row.category),
    language: str(row.language),
    region: nullableStr(row.region),
    articleCount: num(row.article_count),
    sourceCount: num(row.source_count),
    trendingScore: num(row.trending_score),
    firstSeenAt: str(row.first_seen_at),
    lastSeenAt: str(row.last_seen_at),
  };
}
