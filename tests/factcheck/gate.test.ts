import { describe, it, expect } from 'vitest';
import { decideVerdict, MIN_INDEPENDENT_DOMAINS } from '../../src/lib/factcheck/gate';
import { assessEvidence } from '../../src/lib/factcheck/evidence';
import type {
  ClaimComponent,
  EvidenceItem,
  VerdictProposal,
} from '../../src/lib/factcheck/signals';
import type { SourceTier, Verdict } from '../../src/lib/factcheck/schema';

/** RULE-LEVEL tests for the deterministic gate.
 *
 *  Distinct in purpose from the golden set. The golden set measures END-TO-END
 *  outcomes on realistic cases; these isolate ONE rule at a time so that rule
 *  is the only thing that could have produced the result.
 *
 *  This file exists because of a mutation check: disabling the tier floor and
 *  disabling the injection exclusion BOTH left the golden set fully green,
 *  because the evidence-strength ladder independently blocked the same cases.
 *  Overlapping defences are good for safety and bad for test signal — a rule
 *  can rot without any test noticing. Each rule below is exercised where the
 *  other rules would otherwise pass. */

let seq = 0;
function ev(over: Partial<EvidenceItem> = {}): EvidenceItem {
  seq += 1;
  return {
    position: seq,
    url: `https://${over.domain ?? 'a.example'}/x`,
    title: 'T',
    publisher: over.domain ?? 'a.example',
    domain: 'a.example',
    tier: 'tier2',
    publishedAt: '2026-08-01',
    accessedAt: '2026-08-08T00:00:00.000Z',
    stance: 'supports',
    readMethod: 'full_page',
    injectionFlagged: false,
    loadBearing: true,
    ...over,
  };
}

/** N independent supporting sources, all dated and fully read. */
function supporters(n: number, tier: SourceTier = 'tier2'): EvidenceItem[] {
  return Array.from({ length: n }, (_, i) =>
    ev({ domain: `s${i}.example`, tier, stance: 'supports' }),
  );
}

function contradictors(n: number, tier: SourceTier = 'tier2'): EvidenceItem[] {
  return Array.from({ length: n }, (_, i) =>
    ev({ domain: `c${i}.example`, tier, stance: 'contradicts' }),
  );
}

function proposal(over: Partial<VerdictProposal> = {}): VerdictProposal {
  return {
    proposedVerdict: 'true',
    componentStatuses: [],
    temporal: { kind: 'none', detail: '', positions: [], significance: 'none' },
    context: { kind: 'none', detail: '', positions: [], significance: 'none' },
    contradictions: [],
    summary: '',
    reasoning: '',
    limitations: [],
    valid: true,
    ...over,
  };
}

function decide(
  items: EvidenceItem[],
  p: Partial<VerdictProposal> = {},
  components: ClaimComponent[] = [],
  opts: { claimConfident?: boolean; multiClaim?: boolean } = {},
) {
  return decideVerdict({
    proposal: proposal(p),
    assessment: assessEvidence(items),
    components,
    claimConfident: opts.claimConfident ?? true,
    multiClaim: opts.multiClaim ?? false,
  });
}

function component(status: ClaimComponent['status'], id = 'c1'): ClaimComponent {
  return { id, text: 't', kind: 'other', status, evidenceRefs: [] };
}

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: absence of evidence is never refutation', () => {
  it('no evidence at all yields unverified, not false', () => {
    const d = decide([], { proposedVerdict: 'false' });
    expect(d.verdict).toBe('unverified');
    expect(d.verdict).not.toBe('false');
  });

  it('a model insisting on false with nothing to show is overridden', () => {
    const d = decide([], { proposedVerdict: 'false' });
    expect(d.overridden).toBe(true);
    // Zero independent sources trips the corroboration rule first, which is
    // the more useful thing to tell a reader than "the evidence is weak".
    expect(d.reasons.map((r) => r.rule)).toContain('insufficient_corroboration');
  });

  // The strength floor is still reachable on its own terms: enough
  // independent tier-2 domains to clear corroboration and tier, but every
  // source snippet-only, so nothing was actually read in full.
  it('the strength floor still fires when corroboration and tier pass', () => {
    const snippetOnly = [
      ev({ domain: 'a.example', tier: 'tier2', readMethod: 'search_snippet' }),
      ev({ domain: 'b.example', tier: 'tier2', readMethod: 'search_snippet' }),
    ];
    const d = decide(snippetOnly);
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('insufficient_strength');
  });

  it('every proposal on an empty evidence set lands on unverified', () => {
    for (const v of ['true', 'false', 'partly_true', 'misleading', 'needs_context'] as Verdict[]) {
      expect(decide([], { proposedVerdict: v }).verdict).toBe('unverified');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: corroboration floor', () => {
  it('one supporting domain cannot establish true', () => {
    expect(decide(supporters(1)).verdict).toBe('unverified');
  });

  it('two independent supporting domains can', () => {
    expect(decide(supporters(2)).verdict).toBe('true');
  });

  it('one contradicting domain cannot establish false', () => {
    expect(decide(contradictors(1), { proposedVerdict: 'false' }).verdict).toBe('unverified');
  });

  it('two independent contradicting domains can', () => {
    expect(decide(contradictors(2), { proposedVerdict: 'false' }).verdict).toBe('false');
  });

  it('the floor is symmetric for true and false', () => {
    expect(MIN_INDEPENDENT_DOMAINS).toBe(2);
    expect(decide(supporters(1)).verdict).toBe('unverified');
    expect(decide(contradictors(1), { proposedVerdict: 'false' }).verdict).toBe('unverified');
  });

  it('two pages from ONE domain are one source', () => {
    const items = [
      ev({ domain: 'same.example', url: 'https://same.example/1' }),
      ev({ domain: 'same.example', url: 'https://same.example/2' }),
    ];
    expect(decide(items).verdict).toBe('unverified');
  });

  it('records why it refused', () => {
    const d = decide(supporters(1));
    expect(d.reasons.map((r) => r.rule)).toContain('insufficient_corroboration');
    expect(d.limitations.join(' ')).toMatch(/independent source/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tier floor, isolated. The golden set could not detect this rule breaking
// because the strength ladder blocked the same cases. Here strength is forced
// to pass (three tier-3 domains, dated, fully read) so ONLY the tier rule can
// produce the refusal.
describe('RULE: tier floor (isolated from the strength ladder)', () => {
  it('tier-3-only support cannot establish true even with three domains', () => {
    const d = decide(supporters(3, 'tier3'));
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toEqual(
      expect.arrayContaining(['tier3_only']),
    );
  });

  it('tier-3-only contradiction cannot establish false', () => {
    const d = decide(contradictors(3, 'tier3'), { proposedVerdict: 'false' });
    expect(d.verdict).toBe('unverified');
  });

  it('one tier-2 source among tier-3 lifts it over the floor', () => {
    const items = [...supporters(2, 'tier3'), ev({ domain: 'good.example', tier: 'tier2' })];
    expect(decide(items).verdict).toBe('true');
  });

  it('tier-1 support passes the floor', () => {
    expect(decide(supporters(2, 'tier1')).verdict).toBe('true');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Injection exclusion, isolated. Same problem: the golden set's injection
// cases were also blocked by the corroboration floor. Here there is ample
// clean corroboration, so ONLY the exclusion rule can change the outcome.
describe('RULE: injection exclusion (isolated from the corroboration floor)', () => {
  it('poisoned sources do not count toward corroboration', () => {
    // Three "supporters", two of which are poisoned -> only one real source.
    const items = [
      ev({ domain: 'clean.example', tier: 'tier2' }),
      ev({ domain: 'evil1.example', tier: 'tier2', injectionFlagged: true }),
      ev({ domain: 'evil2.example', tier: 'tier2', injectionFlagged: true }),
    ];
    const d = decide(items);
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('insufficient_corroboration');
  });

  it('injection cannot force true', () => {
    const items = [ev({ domain: 'evil.example', injectionFlagged: true, tier: 'tier1' })];
    expect(decide(items, { proposedVerdict: 'true' }).verdict).toBe('unverified');
  });

  // Symmetric attack: if injection could produce FALSE, an attacker could
  // discredit any true claim by planting a payload on a page discussing it.
  it('injection cannot force false', () => {
    const items = [
      ev({ domain: 'evil.example', stance: 'contradicts', injectionFlagged: true, tier: 'tier1' }),
    ];
    const d = decide(items, { proposedVerdict: 'false' });
    expect(d.verdict).toBe('unverified');
    expect(d.verdict).not.toBe('false');
  });

  it('clean independent sources still establish a verdict alongside a poisoned one', () => {
    const items = [
      ...supporters(2, 'tier2'),
      ev({ domain: 'evil.example', injectionFlagged: true }),
    ];
    expect(decide(items).verdict).toBe('true');
  });

  it('always discloses injection, even when the verdict is unaffected', () => {
    const items = [
      ...supporters(2, 'tier2'),
      ev({ domain: 'evil.example', injectionFlagged: true }),
    ];
    const d = decide(items);
    expect(d.verdict).toBe('true');
    expect(d.reasons.map((r) => r.rule)).toContain('injection_detected');
    expect(d.limitations.join(' ')).toMatch(/not a judgement that the claim itself is false/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: syndication is not corroboration', () => {
  it('three outlets carrying one wire copy count as one source', () => {
    const items = ['a', 'b', 'c'].map((d) =>
      ev({ domain: `${d}.example`, syndicationGroup: 'wire-1' }),
    );
    expect(decide(items).verdict).toBe('unverified');
  });

  it('two genuinely separate outlets do corroborate', () => {
    const items = [ev({ domain: 'a.example' }), ev({ domain: 'b.example' })];
    expect(decide(items).verdict).toBe('true');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: unrebutted contradiction blocks true', () => {
  it('a single independent contradiction prevents true', () => {
    const items = [...supporters(2), ev({ domain: 'against.example', stance: 'contradicts' })];
    const d = decide(items);
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('unrebutted_contradiction');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: material contradiction between sources', () => {
  it('blocks an assertive verdict and reports the disagreement', () => {
    const d = decide(supporters(3), {
      proposedVerdict: 'true',
      contradictions: [
        { positions: [1, 2], point: 'figure: 10 million vs 15 million', significance: 'material' },
      ],
    });
    expect(d.verdict).toBe('unverified');
    expect(d.limitations.join(' ')).toContain('10 million vs 15 million');
  });

  it('a minor disagreement does not block', () => {
    const d = decide(supporters(3), {
      proposedVerdict: 'true',
      contradictions: [{ positions: [1, 2], point: '3.0 vs 3.1 km', significance: 'minor' }],
    });
    expect(d.verdict).toBe('true');
  });

  // Averaging away a disagreement would hide the most useful thing we found.
  it('never silently resolves a material disagreement', () => {
    const d = decide(supporters(3), {
      proposedVerdict: 'true',
      contradictions: [{ positions: [1, 2], point: 'X vs Y', significance: 'material' }],
    });
    expect(d.reasons.map((r) => r.rule)).toContain('material_contradiction');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: mixed components produce partly_true', () => {
  it('one supported and one contradicted component', () => {
    const items = [...supporters(2), ...contradictors(2)];
    const d = decide(items, { proposedVerdict: 'partly_true' }, [
      component('supported', 'c1'),
      component('contradicted', 'c2'),
    ]);
    expect(d.verdict).toBe('partly_true');
  });

  it('overrides a blanket false, which would erase the true component', () => {
    const items = [...supporters(2), ...contradictors(2)];
    const d = decide(items, { proposedVerdict: 'false' }, [
      component('supported', 'c1'),
      component('contradicted', 'c2'),
    ]);
    expect(d.verdict).toBe('partly_true');
    expect(d.overridden).toBe(true);
  });

  it('all components supported is true, not partly_true', () => {
    const d = decide(supporters(2), { proposedVerdict: 'partly_true' }, [
      component('supported', 'c1'),
      component('supported', 'c2'),
    ]);
    expect(d.verdict).toBe('true');
  });

  it('mixed components on thin evidence is unverified, not partly_true', () => {
    const items = [ev({ domain: 'one.example' })];
    const d = decide(items, { proposedVerdict: 'partly_true' }, [
      component('supported', 'c1'),
      component('contradicted', 'c2'),
    ]);
    expect(d.verdict).toBe('unverified');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: needs_context requires established substance', () => {
  it('is refused when the claim was never established', () => {
    const d = decide(supporters(1), { proposedVerdict: 'needs_context' });
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('context_without_substance');
  });

  it('is refused when no missing context was actually identified', () => {
    const d = decide(supporters(2), { proposedVerdict: 'needs_context' });
    expect(d.verdict).toBe('true');
    expect(d.reasons.map((r) => r.rule)).toContain('no_material_context_identified');
  });

  it('is allowed when substance is established AND context is material', () => {
    const d = decide(supporters(2), {
      proposedVerdict: 'needs_context',
      context: {
        kind: 'missing_qualifier',
        detail: 'Eligibility is limited to first-time buyers.',
        positions: [1],
        significance: 'material',
      },
    });
    expect(d.verdict).toBe('needs_context');
  });

  // Runs EVEN WHEN support is strong — this is what makes the verdict
  // reachable rather than decorative.
  it('redirects a strongly supported true when context is material', () => {
    const d = decide(supporters(3, 'tier1'), {
      proposedVerdict: 'true',
      context: {
        kind: 'missing_qualifier',
        detail: 'The record series only begins in 2019.',
        positions: [1],
        significance: 'material',
      },
    });
    expect(d.verdict).toBe('needs_context');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: misleading requires a supported literal statement', () => {
  it('is refused when nothing supports the literal claim', () => {
    const d = decide([ev({ domain: 'x.example', tier: 'tier3', stance: 'unclear' })], {
      proposedVerdict: 'misleading',
    });
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('misleading_without_support');
  });

  it('is allowed when the literal statement holds and the framing is the defect', () => {
    const items = [
      ev({ domain: 'stats.example', tier: 'tier1', stance: 'supports' }),
      ev({ domain: 'news.example', tier: 'tier2', stance: 'neutral' }),
    ];
    const d = decide(items, {
      proposedVerdict: 'misleading',
      context: {
        kind: 'selective_framing',
        detail: 'The window was selected from a decade-long decline.',
        positions: [2],
        significance: 'material',
      },
    });
    expect(d.verdict).toBe('misleading');
  });

  it('redirects a proposed true when the framing defect is material', () => {
    const items = [
      ev({ domain: 'stats.example', tier: 'tier1', stance: 'supports' }),
      ev({ domain: 'news.example', tier: 'tier2', stance: 'neutral' }),
    ];
    const d = decide(items, {
      proposedVerdict: 'true',
      context: {
        kind: 'selective_framing',
        detail: 'Causation is implied but ruled out by the authority.',
        positions: [2],
        significance: 'material',
      },
    });
    expect(d.verdict).toBe('misleading');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: invalid model output', () => {
  it('yields unverified even when the evidence is strong', () => {
    const d = decide(supporters(3, 'tier1'), { proposedVerdict: 'true', valid: false });
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('invalid_model_output');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: claim extraction gates the whole pipeline', () => {
  it('an unconfident extraction is never verdicted', () => {
    const d = decide(supporters(3, 'tier1'), { proposedVerdict: 'true' }, [], {
      claimConfident: false,
    });
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('claim_not_identified');
  });

  it('a multi-claim submission is never given one verdict', () => {
    const d = decide(supporters(3, 'tier1'), { proposedVerdict: 'true' }, [], {
      multiClaim: true,
    });
    expect(d.verdict).toBe('unverified');
    expect(d.reasons.map((r) => r.rule)).toContain('multiple_claims');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('RULE: evidence can correct an under-confident model', () => {
  it('upgrades unverified to true on strong uncontradicted support', () => {
    const d = decide(supporters(3, 'tier1'), { proposedVerdict: 'unverified' });
    expect(d.verdict).toBe('true');
    expect(d.reasons.map((r) => r.rule)).toContain('strong_support_upgrade');
  });

  it('does NOT upgrade when anything contradicts', () => {
    const items = [...supporters(3, 'tier1'), ev({ domain: 'no.example', stance: 'contradicts' })];
    expect(decide(items, { proposedVerdict: 'unverified' }).verdict).toBe('unverified');
  });

  it('does NOT upgrade on moderate evidence', () => {
    expect(decide(supporters(2, 'tier2'), { proposedVerdict: 'unverified' }).verdict).toBe(
      'unverified',
    );
  });

  // The symmetric path. Its absence was a real asymmetry bug.
  it('corrects a softer proposal to false on corroborated contradiction', () => {
    const d = decide(contradictors(2, 'tier1'), { proposedVerdict: 'needs_context' });
    expect(d.verdict).toBe('false');
    expect(d.reasons.map((r) => r.rule)).toContain('contradiction_established');
  });

  it('does NOT correct to false when anything supports the claim', () => {
    const items = [...contradictors(2, 'tier1'), ev({ domain: 'yes.example', stance: 'supports' })];
    expect(decide(items, { proposedVerdict: 'needs_context' }).verdict).not.toBe('false');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('AUDITABILITY', () => {
  it('every override records at least one machine-readable reason', () => {
    const d = decide(supporters(1), { proposedVerdict: 'true' });
    expect(d.overridden).toBe(true);
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons.every((r) => r.rule.length > 0 && r.detail.length > 0)).toBe(true);
  });

  it('retains what the model proposed even after overriding it', () => {
    const d = decide(supporters(1), { proposedVerdict: 'true' });
    expect(d.proposedVerdict).toBe('true');
    expect(d.verdict).toBe('unverified');
  });

  it('surfaces every reason in reader-facing limitations', () => {
    const d = decide(supporters(1), { proposedVerdict: 'true' });
    for (const r of d.reasons) expect(d.limitations).toContain(r.detail);
  });

  it('reports no override when the proposal stands', () => {
    const d = decide(supporters(2));
    expect(d.overridden).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  // The invariant that outranks every other rule.
  it('NEVER downgrades toward false, only toward unverified', () => {
    const thin = [ev({ domain: 'one.example', tier: 'tier3' })];
    for (const v of ['true', 'false', 'partly_true', 'misleading', 'needs_context'] as Verdict[]) {
      const d = decide(thin, { proposedVerdict: v });
      if (d.overridden) expect(d.verdict).not.toBe('false');
    }
  });
});
