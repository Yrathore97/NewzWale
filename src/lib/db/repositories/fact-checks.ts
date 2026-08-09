/** Repository for fact_checks and fact_check_evidence.
 *
 *  APPEND-ONLY. There is no update() and no delete() here, and that is not an
 *  omission: the table's triggers reject both, so exposing such a method would
 *  only produce a runtime error at a call site that thought it was allowed.
 *  A verdict a reader has seen and shared must keep saying what they saw.
 *  Re-checking a claim inserts a NEW row and points the old one at it.
 *
 *  Every statement is parameterised. No caller-supplied value is ever
 *  concatenated into SQL. */

import { requireDb, nowIso, type Db } from '../client';
import { ftsQuery } from './articles';

/** The six canonical verdicts. Mirrors the CHECK constraint in migration 0001. */
export type StoredVerdict =
  | 'true'
  | 'false'
  | 'partly_true'
  | 'misleading'
  | 'unverified'
  | 'needs_context';

export type EvidenceStrength = 'strong' | 'moderate' | 'weak' | 'none';
export type EvidenceStance = 'supporting' | 'contradicting' | 'contextual';
export type ReadMethod = 'full_page' | 'search_snippet';
export type SourceTier = 'tier1' | 'tier2' | 'tier3';

export interface FactCheckRecord {
  id: string;
  claim: string;
  claimNormalized: string;
  claimSource: 'text' | 'url' | 'image';
  originUrl?: string | null;
  claimTopic?: string | null;

  verdict: StoredVerdict;
  evidenceStrength: EvidenceStrength;
  basis: 'certified' | 'ai_assessment' | 'none';

  summary: string;
  reasoning: string;
  limitations?: string | null;

  independentSupportingDomains: number;
  independentContradictingDomains: number;

  pipelineVersion: number;
  evidenceVersion: number;
  modelId?: string | null;

  /** Null until accounts exist. Present from migration 1 so adding them later
   *  is additive rather than a destructive migration. */
  userId?: string | null;
  deviceHash?: string | null;
  articleId?: string | null;

  checkedAt?: string;
}

export interface EvidenceRecord {
  id: string;
  factCheckId: string;
  /** Display order, and the [1] [2] [3] the reasoning cites. */
  position: number;

  url: string;
  title: string;
  publisher: string;
  sourceId?: string | null;
  tierAtCheck: SourceTier;

  /** Publication date. NULL means genuinely unknown.
   *  NEVER set this from accessedAt - a fabricated date is worse than an
   *  absent one, and the two answer different questions. */
  publishedAt?: string | null;
  /** When NewzWale read the source. Always known. */
  accessedAt?: string;

  stance: EvidenceStance;
  relevance?: 'high' | 'medium' | 'low' | null;
  quotedPassage?: string | null;
  reason?: string | null;
  readMethod: ReadMethod;
  injectionFlagged: boolean;
  publisherRating?: string | null;
}

export interface FactCheckWithEvidence {
  factCheck: FactCheckRecord;
  evidence: EvidenceRecord[];
}

const INSERT_CHECK = `
  INSERT INTO fact_checks (
    id, claim, claim_normalized, claim_source, origin_url, claim_topic,
    verdict, evidence_strength, basis,
    summary, reasoning, limitations,
    independent_supporting_domains, independent_contradicting_domains,
    pipeline_version, evidence_version, model_id,
    user_id, device_hash, article_id, checked_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_EVIDENCE = `
  INSERT INTO fact_check_evidence (
    id, fact_check_id, position, url, title, publisher, source_id, tier_at_check,
    published_at, accessed_at, stance, relevance, quoted_passage, reason,
    read_method, injection_flagged, publisher_rating
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export class FactCheckRepository {
  private readonly db: Db;

  constructor(db: Db | undefined) {
    this.db = requireDb(db);
  }

  /** Inserts a check and its evidence as one batch.
   *
   *  Batched so a check can never be persisted without the evidence that
   *  justifies it. A verdict row with no citations would be exactly the
   *  unsupported assertion this product exists to avoid. */
  async create({ factCheck, evidence }: FactCheckWithEvidence): Promise<void> {
    const checkedAt = factCheck.checkedAt ?? nowIso();

    const statements = [
      this.db
        .prepare(INSERT_CHECK)
        .bind(
          factCheck.id,
          factCheck.claim,
          factCheck.claimNormalized,
          factCheck.claimSource,
          factCheck.originUrl ?? null,
          factCheck.claimTopic ?? null,
          factCheck.verdict,
          factCheck.evidenceStrength,
          factCheck.basis,
          factCheck.summary,
          factCheck.reasoning,
          factCheck.limitations ?? null,
          factCheck.independentSupportingDomains,
          factCheck.independentContradictingDomains,
          factCheck.pipelineVersion,
          factCheck.evidenceVersion,
          factCheck.modelId ?? null,
          factCheck.userId ?? null,
          factCheck.deviceHash ?? null,
          factCheck.articleId ?? null,
          checkedAt,
        ),
      ...evidence.map((e) =>
        this.db
          .prepare(INSERT_EVIDENCE)
          .bind(
            e.id,
            factCheck.id,
            e.position,
            e.url,
            e.title,
            e.publisher,
            e.sourceId ?? null,
            e.tierAtCheck,
            // Explicitly null rather than defaulted: an unknown publication
            // date must stay unknown.
            e.publishedAt ?? null,
            e.accessedAt ?? nowIso(),
            e.stance,
            e.relevance ?? null,
            e.quotedPassage ?? null,
            e.reason ?? null,
            e.readMethod,
            e.injectionFlagged ? 1 : 0,
            e.publisherRating ?? null,
          ),
      ),
    ];

    await this.db.batch(statements);
  }

  /** Fetches one check with its evidence in citation order. */
  async findById(id: string): Promise<FactCheckWithEvidence | null> {
    const row = await this.db
      .prepare('SELECT * FROM fact_checks WHERE id = ?')
      .bind(id)
      .first<Record<string, unknown>>();

    if (!row) return null;

    const evidence = await this.db
      .prepare('SELECT * FROM fact_check_evidence WHERE fact_check_id = ? ORDER BY position ASC')
      .bind(id)
      .all<Record<string, unknown>>();

    return {
      factCheck: toFactCheck(row),
      evidence: evidence.results.map(toEvidence),
    };
  }

  /** Most recent checks that have not been superseded.
   *
   *  `superseded_by IS NULL` matters: a re-checked claim would otherwise
   *  appear twice, once with methodology nobody uses any more. */
  async listRecent(limit = 20): Promise<FactCheckRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .prepare(
        `SELECT * FROM fact_checks
         WHERE superseded_by IS NULL
         ORDER BY checked_at DESC
         LIMIT ?`,
      )
      .bind(bounded)
      .all<Record<string, unknown>>();

    return rows.results.map(toFactCheck);
  }

  /** Recent checks filtered to one verdict, for /fact-check/history. */
  async listByVerdict(verdict: StoredVerdict, limit = 20): Promise<FactCheckRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .prepare(
        `SELECT * FROM fact_checks
         WHERE verdict = ? AND superseded_by IS NULL
         ORDER BY checked_at DESC
         LIMIT ?`,
      )
      .bind(verdict, bounded)
      .all<Record<string, unknown>>();

    return rows.results.map(toFactCheck);
  }

  /** Checked claims linked to one article, for the `/news/[slug]` fact-check
   *  panel (AD-09). `article_id` is set only when a check was submitted from
   *  that story's URL, so most articles will have none — an empty array is
   *  the normal case, not an error. */
  async listByArticle(articleId: string, limit = 10): Promise<FactCheckRecord[]> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50);
    const rows = await this.db
      .prepare(
        `SELECT * FROM fact_checks
         WHERE article_id = ? AND superseded_by IS NULL
         ORDER BY checked_at DESC
         LIMIT ?`,
      )
      .bind(articleId, bounded)
      .all<Record<string, unknown>>();

    return rows.results.map(toFactCheck);
  }

  /** Full-text search over checked claims and their one-line summaries.
   *
   *  `superseded_by IS NULL` for the same reason listRecent has it: a
   *  superseded verdict was produced by methodology this system no longer
   *  uses, and surfacing it in search would republish a conclusion we have
   *  already retracted.
   *
   *  Shares `ftsQuery` with article search so both sanitise FTS5 operators
   *  identically — one escaping rule, not two that can drift apart. */
  async search(query: string, limit = 20): Promise<FactCheckRecord[]> {
    const match = ftsQuery(query);
    if (!match) return [];
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
      .prepare(
        `SELECT c.* FROM claims_fts f
         JOIN fact_checks c ON c.rowid = f.rowid
         WHERE claims_fts MATCH ? AND c.superseded_by IS NULL
         ORDER BY f.rank, c.checked_at DESC
         LIMIT ?`,
      )
      .bind(match, bounded)
      .all<Record<string, unknown>>();
    return rows.results.map(toFactCheck);
  }

  /** Marks an older check as replaced by a newer one.
   *
   *  The ONLY permitted mutation on this table - the trigger rejects every
   *  other column. Supersession is how a re-check under new methodology
   *  happens without rewriting what a reader already saw. */
  async supersede(oldId: string, newId: string): Promise<void> {
    await this.db
      .prepare('UPDATE fact_checks SET superseded_by = ? WHERE id = ?')
      .bind(newId, oldId)
      .run();
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

function toFactCheck(row: Record<string, unknown>): FactCheckRecord {
  return {
    id: str(row.id),
    claim: str(row.claim),
    claimNormalized: str(row.claim_normalized),
    claimSource: str(row.claim_source) as FactCheckRecord['claimSource'],
    originUrl: nullableStr(row.origin_url),
    claimTopic: nullableStr(row.claim_topic),
    verdict: str(row.verdict) as StoredVerdict,
    evidenceStrength: str(row.evidence_strength) as EvidenceStrength,
    basis: str(row.basis) as FactCheckRecord['basis'],
    summary: str(row.summary),
    reasoning: str(row.reasoning),
    limitations: nullableStr(row.limitations),
    independentSupportingDomains: num(row.independent_supporting_domains),
    independentContradictingDomains: num(row.independent_contradicting_domains),
    pipelineVersion: num(row.pipeline_version),
    evidenceVersion: num(row.evidence_version),
    modelId: nullableStr(row.model_id),
    userId: nullableStr(row.user_id),
    deviceHash: nullableStr(row.device_hash),
    articleId: nullableStr(row.article_id),
    checkedAt: str(row.checked_at),
  };
}

function toEvidence(row: Record<string, unknown>): EvidenceRecord {
  return {
    id: str(row.id),
    factCheckId: str(row.fact_check_id),
    position: num(row.position),
    url: str(row.url),
    title: str(row.title),
    publisher: str(row.publisher),
    sourceId: nullableStr(row.source_id),
    tierAtCheck: str(row.tier_at_check) as SourceTier,
    // Preserved as null, never coerced to a date or to accessedAt.
    publishedAt: row.published_at === null || row.published_at === undefined
      ? null
      : str(row.published_at),
    accessedAt: str(row.accessed_at),
    stance: str(row.stance) as EvidenceStance,
    relevance: (nullableStr(row.relevance) as EvidenceRecord['relevance']) ?? null,
    quotedPassage: nullableStr(row.quoted_passage),
    reason: nullableStr(row.reason),
    readMethod: str(row.read_method) as ReadMethod,
    injectionFlagged: num(row.injection_flagged) === 1,
    publisherRating: nullableStr(row.publisher_rating),
  };
}
