import { describe, it, expect } from 'vitest';
import { GOLDEN_CASES } from './cases';
import { runGoldenSet, formatReport, type Evaluator } from './harness';
import { applyVerdictGuard, type GuardEvidence } from '../../../src/lib/factcheck/guard';
import { readLegacyVerdict, type LegacyVerdict, type Verdict } from '../../../src/lib/factcheck/schema';

/** BASELINE — the golden set run against the PRE-PHASE-3 pipeline.
 *
 *  Recorded before any verdict logic changed, so "the new engine is better" is
 *  a measurement rather than a claim. This file must NOT be updated to make
 *  the old system look good; if it ever needs changing, the baseline has
 *  stopped being a baseline.
 *
 *  The old system had four verdicts, so the six-value fixtures are projected
 *  down and the result projected back up. That projection is itself the point:
 *  it makes visible that the old enum simply could not express two of the six
 *  answers, whatever the evidence showed. */

/** Six-value fixture proposal -> what the four-value model would have said. */
function toLegacyProposal(v: Verdict): LegacyVerdict {
  switch (v) {
    case 'true':
      return 'verified';
    case 'false':
      return 'false';
    // The old enum had no partly_true; such a proposal collapsed into
    // 'misleading', which is exactly the conflation Phase 3 exists to end.
    case 'partly_true':
    case 'misleading':
      return 'misleading';
    // And no needs_context; it collapsed into insufficient_evidence.
    case 'unverified':
    case 'needs_context':
      return 'insufficient_evidence';
  }
}

const baselineEvaluator: Evaluator = (c) => {
  const evidence: GuardEvidence[] = c.evidence.map((e) => ({
    domain: e.domain,
    injectionFlagged: e.injectionPayload === true,
  }));

  const out = applyVerdictGuard({
    proposed: toLegacyProposal(c.modelProposal),
    evidence,
  });

  const independentDomainCount = new Set(
    c.evidence.filter((e) => !e.injectionPayload).map((e) => e.domain),
  ).size;

  return {
    verdict: readLegacyVerdict(out.verdict),
    strength: undefined, // the old pipeline had no evidence-strength concept
    independentDomainCount,
  };
};

describe('GOLDEN SET — baseline against the pre-Phase-3 pipeline', () => {
  const report = runGoldenSet(GOLDEN_CASES, baselineEvaluator);

  it('prints the baseline report', () => {
    // eslint-disable-next-line no-console
    console.log(formatReport('BASELINE — four-verdict pipeline (pre-Phase 3)', report));
    expect(report.total).toBe(GOLDEN_CASES.length);
  });

  // These assertions PIN the old behaviour. They are expected to look bad.
  // Their job is to make any future regression toward it immediately visible.

  it('cannot produce partly_true or needs_context at all', () => {
    expect(report.distribution.partly_true ?? 0).toBe(0);
    expect(report.distribution.needs_context ?? 0).toBe(0);
  });

  it('has cases it answers confidently and wrongly', () => {
    // The baseline is not safe. Recorded, not excused.
    expect(report.confidentlyWrong.length).toBeGreaterThan(0);
  });

  it('fails every case whose correct answer the old enum could not express', () => {
    const inexpressible = report.results.filter(
      (r) => r.expected === 'partly_true' || r.expected === 'needs_context',
    );
    expect(inexpressible.length).toBeGreaterThan(0);
    expect(inexpressible.every((r) => !r.pass)).toBe(true);
  });
});
