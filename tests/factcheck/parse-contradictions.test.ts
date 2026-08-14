import { describe, it, expect } from 'vitest';
import { parseProposal } from '../../src/lib/factcheck/parse';

/** A 'material' contradiction is the strongest thing the model can emit:
 *  gate.ts RULE 2 forbids any assertive verdict on one, ahead of every
 *  corroboration floor. These tests pin the deterministic validation that
 *  keeps that veto tied to actual evidence of disagreement. */

/** Wrapped in `{ response: ... }` because parseProposal unwraps a Workers AI
 *  envelope before parsing - see payloadFromAi. */
function proposalWith(contradictions: unknown) {
  return parseProposal({
    response: {
      verdict: 'false',
      summary: 'S',
      reasoning: 'R',
      contradictions,
    },
  });
}

describe('parseContradictions: a source disagreement requires two sources', () => {
  it('demotes a material contradiction citing only ONE position', () => {
    // Observed live on the Agra-Lucknow claim: the model returned exactly
    // this shape - one position, and a point that SUPPORTS the claim - and
    // it was enough on its own to veto the verdict.
    const p = proposalWith([
      {
        positions: [2],
        point: 'The state government of Uttar Pradesh developed the project.',
        significance: 'material',
      },
    ]);

    // Still present - the finding is carried, not hidden.
    expect(p.contradictions).toHaveLength(1);
    expect(p.contradictions[0]!.point).toMatch(/state government/);
    // But it cannot exercise a veto it has no evidence for.
    expect(p.contradictions[0]!.significance).toBe('minor');
  });

  it('demotes a material contradiction citing NO positions', () => {
    const p = proposalWith([
      { positions: [], point: 'Sources disagree somehow.', significance: 'material' },
    ]);
    expect(p.contradictions[0]!.significance).toBe('minor');
  });

  it('demotes when the same position is cited twice', () => {
    // [3,3] is one source, not two.
    const p = proposalWith([
      { positions: [3, 3], point: 'A page disagreeing with itself.', significance: 'material' },
    ]);
    expect(p.contradictions[0]!.significance).toBe('minor');
  });

  it('KEEPS material when two distinct sources are cited', () => {
    const p = proposalWith([
      {
        positions: [1, 4],
        point: 'a.example reports 10 million where b.example reports 15 million',
        significance: 'material',
      },
    ]);
    expect(p.contradictions[0]!.significance).toBe('material');
  });

  it('never promotes a minor contradiction, however many sources it cites', () => {
    const p = proposalWith([
      { positions: [1, 2, 3], point: 'A slight difference in phrasing.', significance: 'minor' },
    ]);
    expect(p.contradictions[0]!.significance).toBe('minor');
  });
});
