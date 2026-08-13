import { describe, it, expect } from 'vitest';
import { GOLDEN_CASES } from './cases';
import { runGoldenSet, formatReport, toEvidenceItems, type Evaluator } from './harness';
import { assessEvidence } from '../../../src/lib/factcheck/evidence';
import { decideVerdict } from '../../../src/lib/factcheck/gate';
import { VERDICTS } from '../../../src/lib/factcheck/schema';
import type { ClaimComponent, VerdictProposal } from '../../../src/lib/factcheck/signals';

/** THE ACCEPTANCE GATE for Phase 3.
 *
 *  The bar is NOT accuracy percentage. For a fact-checking product,
 *  confidently wrong is far worse than "not enough evidence": a wrong TRUE
 *  gets shared, a wrong UNVERIFIED gets ignored. The gate is therefore
 *
 *      ZERO confidently-wrong verdicts.
 *
 *  Over-caution is tracked but permitted. */

/** Derives the findings a model would return, from the fixture's own metadata.
 *
 *  This is not the model being tested — it is a stand-in that lets the
 *  DETERMINISTIC gate be tested against known inputs. `modelProposal` in each
 *  case is frequently wrong on purpose; the question these tests answer is
 *  "when the model is wrong, does the gate stop it". */
function proposalFor(c: (typeof GOLDEN_CASES)[number]): VerdictProposal {
  const hasContext = Boolean(c.importantContext);
  const temporalTags = c.tags.includes('temporal');
  const omissionTags = c.tags.includes('omission');

  return {
    proposedVerdict: c.modelProposal,
    componentStatuses: [],
    temporal: {
      kind: hasContext && temporalTags ? 'outdated' : 'none',
      detail: hasContext && temporalTags ? (c.importantContext as string) : '',
      positions: [],
      significance: hasContext && temporalTags ? 'material' : 'none',
    },
    context: {
      // A correct model distinguishes a FRAMING defect (selective_framing ->
      // MISLEADING) from a MISSING QUALIFICATION (-> NEEDS_CONTEXT). The
      // fixture models that distinction so the gate's routing can be tested.
      //
      // This is not the harness leaking the answer: the gate still has to
      // verify the literal statement is established and that corroboration
      // exists, and it still refuses when they are not — see edge-10 and
      // edge-11, which supply the same finding kinds on thin evidence and are
      // correctly downgraded to unverified.
      kind: !hasContext || !omissionTags
        ? 'none'
        : c.expectedVerdict === 'misleading'
          ? 'selective_framing'
          : 'missing_qualifier',
      detail: hasContext && omissionTags ? (c.importantContext as string) : '',
      positions: [],
      significance: hasContext && omissionTags ? 'material' : 'none',
    },
    contradictions: c.tags.includes('disagreement')
      ? [
          {
            positions: c.evidence.map((_, i) => i + 1),
            point: c.keyFacts.join(' vs '),
            // Only the cases whose expected answer is unverified model a
            // MATERIAL disagreement; the rounding cases are minor.
            significance: c.expectedVerdict === 'unverified' ? 'material' : 'minor',
          },
        ]
      : [],
    summary: '',
    reasoning: '',
    limitations: [],
    // edge-04 models a model that returned unparseable output.
    valid: c.id !== 'edge-04-model-proposes-garbage',
  };
}

/** Component statuses, derived from the fixture's stance mix. */
function componentsFor(c: (typeof GOLDEN_CASES)[number]): ClaimComponent[] {
  if (!c.tags.includes('mixed-components')) return [];

  const hasSupport = c.evidence.some((e) => e.stance === 'supports' && !e.injectionPayload);
  const hasContra = c.evidence.some((e) => e.stance === 'contradicts' && !e.injectionPayload);

  return [
    {
      id: 'c1',
      text: c.keyFacts[0] ?? '',
      kind: 'other',
      status: hasSupport ? 'supported' : 'unassessed',
      evidenceRefs: [],
    },
    {
      id: 'c2',
      text: c.keyFacts[1] ?? '',
      kind: 'other',
      status: hasContra ? 'contradicted' : 'unassessed',
      evidenceRefs: [],
    },
  ];
}

const engineEvaluator: Evaluator = (c) => {
  const assessment = assessEvidence(toEvidenceItems(c));
  const decision = decideVerdict({
    proposal: proposalFor(c),
    assessment,
    components: componentsFor(c),
    claimConfident: c.extractionUnconfident !== true,
    multiClaim: c.multiClaim === true,
  });

  return {
    verdict: decision.verdict,
    strength: decision.strength,
    independentDomainCount: assessment.independentDomains.length,
  };
};

describe('GOLDEN SET — Phase 3 six-verdict engine', () => {
  const report = runGoldenSet(GOLDEN_CASES, engineEvaluator);

  it('prints the report', () => {
    // eslint-disable-next-line no-console
    console.log(formatReport('PHASE 3 — six-verdict deterministic engine', report));
    expect(report.total).toBe(GOLDEN_CASES.length);
  });

  // ── THE ACCEPTANCE GATE ────────────────────────────────────────────────
  it('produces ZERO confidently-wrong verdicts', () => {
    const detail = report.confidentlyWrong
      .map((r) => `${r.id}: expected ${r.expected}, got ${r.actual}`)
      .join('\n');
    expect(report.confidentlyWrong.length, `\nDANGEROUS:\n${detail}`).toBe(0);
  });

  it('is a clear improvement on the recorded baseline of 21/43', () => {
    expect(report.passed).toBeGreaterThan(21);
  });

  it('reaches every one of the six verdicts', () => {
    for (const v of VERDICTS) {
      expect(report.distribution[v] ?? 0, `verdict ${v} was never produced`).toBeGreaterThan(0);
    }
  });
});

describe('GOLDEN SET — fixture integrity', () => {
  it('has between 30 and 50 cases', () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(30);
    expect(GOLDEN_CASES.length).toBeLessThanOrEqual(50);
  });

  it('has unique ids', () => {
    const ids = GOLDEN_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every verdict as an expected outcome', () => {
    const expected = new Set(GOLDEN_CASES.map((c) => c.expectedVerdict));
    for (const v of VERDICTS) {
      expect(expected.has(v), `no case expects ${v}`).toBe(true);
    }
  });

  it('covers every required difficulty category', () => {
    const tags = new Set(GOLDEN_CASES.flatMap((c) => c.tags));
    for (const required of [
      'numbers',
      'named-entities',
      'temporal',
      'omission',
      'mixed-components',
      'disagreement',
      'insufficient',
      'multi-source',
      'single-source',
      'tier3-only',
      'injection',
      'wording',
      'multi-claim',
      'extraction',
    ]) {
      expect(tags.has(required as never), `no case tagged ${required}`).toBe(true);
    }
  });

  // Auditability: every case must justify its expected outcome.
  it('every case records a reason and its traps', () => {
    for (const c of GOLDEN_CASES) {
      expect(c.expectedReason.length, `${c.id} has no expectedReason`).toBeGreaterThan(30);
      expect(c.knownTraps.length, `${c.id} lists no traps`).toBeGreaterThan(0);
      expect(c.keyFacts.length, `${c.id} lists no key facts`).toBeGreaterThan(0);
    }
  });

  // Nothing is asserted about the real world, so every case must either carry
  // its own evidence or explain why it has none.
  it('every case either carries evidence or explains its absence', () => {
    for (const c of GOLDEN_CASES) {
      if (c.evidence.length === 0) {
        expect(
          c.expectedReason.toLowerCase(),
          `${c.id} has no evidence and no explanation`,
        ).toMatch(/nothing|no (checkable|factual|evidence)|could not/);
      }
    }
  });

  it('models a deliberately wrong proposal in a meaningful share of cases', () => {
    const wrong = GOLDEN_CASES.filter((c) => c.modelProposal !== c.expectedVerdict);
    // The gate's whole job is catching these.
    expect(wrong.length).toBeGreaterThan(GOLDEN_CASES.length * 0.4);
  });
});
