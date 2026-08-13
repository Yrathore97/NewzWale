import { describe, it, expect, vi, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import MIGRATION_SQL from '../../src/lib/db/migrations/0001_init.sql?raw';
import { factCheckCacheKey, normalizeClaim } from '../../src/lib/cache';
import {
  PIPELINE_VERSION,
  EVIDENCE_VERSION,
  pipelineIdentity,
} from '../../src/lib/factcheck/version';
import { readLegacyVerdict, VERDICTS } from '../../src/lib/factcheck/schema';
import { persistFactCheck } from '../../src/lib/factcheck/persist';
import type { Db } from '../../src/lib/db/client';
import type { FactCheckResult } from '../../src/lib/factcheck/types';

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3N — old four-verdict cache entries must be UNREACHABLE
// ═══════════════════════════════════════════════════════════════════════════
describe('cache versioning across the verdict migration', () => {
  it('the pipeline version was bumped for the six-verdict change', () => {
    // Verdicts cached under version 1 came from a system that could not
    // express partly_true or needs_context and would call a tier-3-only claim
    // "verified". Serving one now would publish a conclusion this system would
    // no longer reach.
    expect(PIPELINE_VERSION).toBeGreaterThanOrEqual(2);
    expect(EVIDENCE_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('a version bump changes the cache key for the same claim', async () => {
    const claim = 'The Board held the rate at 6.5%.';
    const current = await factCheckCacheKey(claim);

    // Recompute by hand under the OLD identity.
    const legacyIdentity = `${normalizeClaim(claim)}|p1|e1|${pipelineIdentity().split('|')[2]}`;
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(legacyIdentity),
    );
    const legacyKey =
      'fc:v2:' +
      Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    expect(current).not.toBe(legacyKey);
  });

  it('the identity string carries the current versions', () => {
    expect(pipelineIdentity()).toContain(`p${PIPELINE_VERSION}`);
    expect(pipelineIdentity()).toContain(`e${EVIDENCE_VERSION}`);
  });
});

describe('legacy verdict interpretation', () => {
  // Deliberately lossy, and the loss is the point: the old enum could not
  // distinguish partly_true from misleading, nor unverified from
  // needs_context, so upgrading a legacy value into those verdicts would
  // invent a judgement nobody made.
  it('maps the four old values into the new vocabulary', () => {
    expect(readLegacyVerdict('verified')).toBe('true');
    expect(readLegacyVerdict('false')).toBe('false');
    expect(readLegacyVerdict('misleading')).toBe('misleading');
    expect(readLegacyVerdict('insufficient_evidence')).toBe('unverified');
  });

  it('never invents partly_true or needs_context from a legacy value', () => {
    const produced = (['verified', 'false', 'misleading', 'insufficient_evidence'] as const).map(
      readLegacyVerdict,
    );
    expect(produced).not.toContain('partly_true');
    expect(produced).not.toContain('needs_context');
  });

  it('only ever yields a canonical verdict', () => {
    for (const legacy of ['verified', 'false', 'misleading', 'insufficient_evidence'] as const) {
      expect(VERDICTS).toContain(readLegacyVerdict(legacy));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3O — persistence, and its failure policy
// ═══════════════════════════════════════════════════════════════════════════
function makeDb(): Db {
  const raw = new DatabaseSync(':memory:');
  raw.exec(MIGRATION_SQL);

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
  } as Db;
}

const result = (over: Partial<FactCheckResult> = {}): FactCheckResult => ({
  verdict: 'true',
  explanation: 'The rate was held.',
  summary: 'The rate was held.',
  reasoning: 'Two independent sources [1][2] report the pause.',
  basis: 'ai_assessment',
  evidenceStrength: 'moderate',
  limitations: ['Only two sources were available.'],
  independentSupportingDomains: 2,
  independentContradictingDomains: 0,
  pipelineVersion: PIPELINE_VERSION,
  evidenceVersion: EVIDENCE_VERSION,
  modelId: '@cf/test',
  checkedAt: '2026-08-08T00:00:00.000Z',
  evidence: [
    {
      position: 1,
      title: 'Rate held',
      url: 'https://thehindu.com/a',
      publisher: 'thehindu.com',
      domain: 'thehindu.com',
      tier: 'tier2',
      stance: 'supports',
      publishedAt: '2026-08-06',
      accessedAt: '2026-08-08T00:00:00.000Z',
      quotedPassage: 'The rate was left unchanged.',
      readMethod: 'full_page',
      injectionFlagged: false,
    },
    {
      position: 2,
      title: 'Policy statement',
      url: 'https://rbi.org.in/press',
      publisher: 'rbi.org.in',
      domain: 'rbi.org.in',
      tier: 'tier1',
      stance: 'supports',
      // Genuinely unknown; must stay null.
      publishedAt: null,
      accessedAt: '2026-08-08T00:00:00.000Z',
      readMethod: 'search_snippet',
      injectionFlagged: false,
    },
  ],
  ...over,
});

const meta = {
  id: 'fc-test-1',
  claimNormalized: 'the board held the rate at 6.5%.',
  claimSource: 'text' as const,
};

describe('persistFactCheck — D1 is the source of truth', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes the audit record and its evidence', async () => {
    const db = makeDb();
    const outcome = await persistFactCheck(db, result({ claim: 'The Board held the rate.' }), meta);

    expect(outcome.persisted).toBe(true);
    expect(outcome.id).toBe('fc-test-1');

    const row = await db.prepare('SELECT * FROM fact_checks WHERE id = ?').bind('fc-test-1').first<any>();
    expect(row.verdict).toBe('true');
    expect(row.evidence_strength).toBe('moderate');
    expect(row.pipeline_version).toBe(PIPELINE_VERSION);

    const ev = await db
      .prepare('SELECT * FROM fact_check_evidence WHERE fact_check_id = ? ORDER BY position')
      .bind('fc-test-1')
      .all<any>();
    expect(ev.results).toHaveLength(2);
  });

  // Principle 7, at the persistence boundary.
  it('never substitutes accessedAt for an unknown publishedAt', async () => {
    const db = makeDb();
    await persistFactCheck(db, result(), meta);

    const rows = await db
      .prepare('SELECT position, published_at, accessed_at FROM fact_check_evidence ORDER BY position')
      .all<any>();

    expect(rows.results[1].published_at).toBeNull();
    expect(rows.results[1].accessed_at).toBeTruthy();
    expect(rows.results[0].published_at).toBe('2026-08-06');
  });

  it('records the gate’s limitations as the audit trail', async () => {
    const db = makeDb();
    await persistFactCheck(
      db,
      result({ limitations: ['Only 1 independent source addressed this claim.', 'A source was compromised.'] }),
      meta,
    );
    const row = await db.prepare('SELECT limitations FROM fact_checks').first<any>();
    expect(row.limitations).toContain('independent source');
    expect(row.limitations).toContain('compromised');
  });

  it('stores every one of the six verdicts', async () => {
    for (const v of VERDICTS) {
      const db = makeDb();
      const outcome = await persistFactCheck(
        db,
        result({ verdict: v, evidenceStrength: 'none' }),
        { ...meta, id: `fc-${v}` },
      );
      expect(outcome.persisted, v).toBe(true);
    }
  });

  it('records injection flags so a poisoned source stays auditable', async () => {
    const db = makeDb();
    const r = result();
    r.evidence[0]!.injectionFlagged = true;
    await persistFactCheck(db, r, meta);

    const row = await db
      .prepare('SELECT injection_flagged FROM fact_check_evidence WHERE position = 1')
      .first<any>();
    expect(row.injection_flagged).toBe(1);
  });

  // ── Failure policy ────────────────────────────────────────────────────
  it('reports not-persisted rather than throwing when the binding is absent', async () => {
    const outcome = await persistFactCheck(undefined, result(), meta);
    expect(outcome.persisted).toBe(false);
    expect(outcome.error).toMatch(/not configured/i);
  });

  it('surfaces and logs a write failure instead of swallowing it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
      batch: async () => [],
    } as unknown as Db;

    const outcome = await persistFactCheck(broken, result(), meta);
    expect(outcome.persisted).toBe(false);
    expect(outcome.error).toContain('D1 unavailable');
    expect(spy).toHaveBeenCalled();
  });

  // A permalink that 404s is worse than no permalink.
  it('returns no id when persistence failed', async () => {
    const outcome = await persistFactCheck(undefined, result(), meta);
    expect(outcome.id).toBeUndefined();
  });

  it('keeps the append-only guarantee after persistence', async () => {
    const db = makeDb();
    await persistFactCheck(db, result(), meta);
    await expect(
      db.prepare("UPDATE fact_checks SET verdict='false' WHERE id='fc-test-1'").run(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to store a verdict outside the canonical six', async () => {
    const db = makeDb();
    const outcome = await persistFactCheck(
      db,
      result({ verdict: 'verified' as never }),
      meta,
    );
    expect(outcome.persisted).toBe(false);
  });
});
