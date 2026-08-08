/** Repositories for sources, articles and story_clusters.
 *
 *  All SQL is parameterised. `canonical_url` is the dedup boundary and carries
 *  a UNIQUE constraint, so ingestion can INSERT OR IGNORE and stay idempotent
 *  - the scheduled job runs every few minutes over overlapping feeds and must
 *  not create duplicates. */

import { requireDb, nowIso, type Db } from '../client';

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
  publishedAt: string;
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
        article.publishedAt,
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
    publishedAt: str(row.published_at),
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
