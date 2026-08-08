/** Persistence of a completed fact check to D1.
 *
 *  ── D1 IS THE SOURCE OF TRUTH. KV IS A CACHE. ──────────────────────────────
 *
 *  The durable record is the audit trail: what was claimed, what was read,
 *  what each source said, which rules fired, and why. KV holds a copy for
 *  speed and may be evicted at any time without loss.
 *
 *  ── FAILURE POLICY, STATED EXPLICITLY ──────────────────────────────────────
 *
 *  analysis succeeds + persistence fails
 *      The result is STILL RETURNED to the user, and the failure is logged and
 *      surfaced on the result as `persisted: false`. Refusing to answer
 *      because a write failed would take the product down for a bookkeeping
 *      problem. But the result is NOT given a shareable id it cannot honour —
 *      a permalink that 404s is worse than no permalink.
 *
 *  analysis succeeds + persistence succeeds + cache write fails
 *      Harmless. The next identical request recomputes and re-persists; the
 *      insert is idempotent on the primary key.
 *
 *  Nothing here silently swallows a failure. */

import type { Db } from '../db/client';
import { hasDb } from '../db/client';
import {
  FactCheckRepository,
  type EvidenceRecord,
  type FactCheckWithEvidence,
  type SourceTier,
  type StoredVerdict,
} from '../db/repositories/fact-checks';
import type { FactCheckResult } from './types';

export interface PersistOutcome {
  persisted: boolean;
  /** Present only when the write succeeded, so a returned id always resolves. */
  id?: string;
  error?: string;
}

/** Maps a pipeline result onto the durable schema and writes it. */
export async function persistFactCheck(
  db: Db | undefined,
  result: FactCheckResult,
  meta: { id: string; claimNormalized: string; claimSource: 'text' | 'url' | 'image'; originUrl?: string },
): Promise<PersistOutcome> {
  if (!hasDb(db)) {
    // Expected during Phase 3: the D1 binding is not provisioned yet. Not an
    // error, but also not a success — the caller must not hand out an id.
    return { persisted: false, error: 'database not configured' };
  }

  try {
    const repo = new FactCheckRepository(db);

    const evidence: EvidenceRecord[] = result.evidence.map((e, i) => ({
      id: `${meta.id}-e${i + 1}`,
      factCheckId: meta.id,
      position: e.position ?? i + 1,
      url: e.url,
      title: e.title,
      publisher: e.publisher,
      tierAtCheck: (e.tier ?? 'tier3') as SourceTier,
      // NEVER substituted with accessedAt. null means genuinely unknown.
      publishedAt: e.publishedAt ?? null,
      accessedAt: e.accessedAt,
      stance:
        e.stance === 'supports'
          ? 'supporting'
          : e.stance === 'contradicts'
            ? 'contradicting'
            : 'contextual',
      quotedPassage: e.quotedPassage ?? null,
      readMethod: e.readMethod ?? 'search_snippet',
      injectionFlagged: e.injectionFlagged === true,
      publisherRating: e.rating ?? null,
    }));

    const record: FactCheckWithEvidence = {
      factCheck: {
        id: meta.id,
        claim: result.claim ?? '',
        claimNormalized: meta.claimNormalized,
        claimSource: meta.claimSource,
        originUrl: meta.originUrl ?? null,
        verdict: result.verdict as StoredVerdict,
        evidenceStrength: result.evidenceStrength ?? 'none',
        basis: result.basis,
        summary: result.summary ?? result.explanation,
        reasoning: result.reasoning ?? '',
        // The audit field. Every deterministic downgrade is recorded here.
        limitations: (result.limitations ?? []).join('\n') || null,
        independentSupportingDomains: result.independentSupportingDomains ?? 0,
        independentContradictingDomains: result.independentContradictingDomains ?? 0,
        pipelineVersion: result.pipelineVersion ?? 0,
        evidenceVersion: result.evidenceVersion ?? 0,
        modelId: result.modelId ?? null,
        checkedAt: result.checkedAt,
      },
      evidence,
    };

    await repo.create(record);
    return { persisted: true, id: meta.id };
  } catch (err) {
    // Logged loudly. A silent persistence failure would leave verdicts with no
    // audit trail while everything looked healthy.
    console.error('Fact-check persistence failed:', err);
    return {
      persisted: false,
      error: err instanceof Error ? err.message : 'unknown persistence error',
    };
  }
}
