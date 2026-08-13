import { describe, it, expect } from 'vitest';
import { normalizeRating, coerceVerdict, unverified, insufficient } from '../../src/lib/factcheck/verdict';
import { VERDICTS } from '../../src/lib/factcheck/schema';

describe('normalizeRating — published fact-checker ratings', () => {
  it('maps refutations to false', () => {
    for (const r of ['False', 'Pants on Fire', 'FAKE', 'Debunked', 'Hoax', 'Fabricated']) {
      expect(normalizeRating(r), r).toBe('false');
    }
  });

  it('maps confirmations to true', () => {
    for (const r of ['True', 'Correct', 'Accurate', 'Confirmed', 'Genuine']) {
      expect(normalizeRating(r), r).toBe('true');
    }
  });

  // Under the four-value enum every one of these collapsed into 'misleading',
  // which is precisely the conflation Phase 3 exists to end.
  it('maps mixed-fact ratings to partly_true, not misleading', () => {
    for (const r of ['Partly true', 'Partially true', 'Half True', 'Mixture', 'Mostly False']) {
      expect(normalizeRating(r), r).toBe('partly_true');
    }
  });

  it('maps framing defects to misleading, not partly_true', () => {
    for (const r of ['Misleading', 'Miscaptioned', 'Exaggerated', 'Out of context']) {
      expect(normalizeRating(r), r).toBe('misleading');
    }
  });

  it('maps context ratings to needs_context', () => {
    for (const r of ['Needs context', 'Missing context', 'True but incomplete', 'Outdated']) {
      expect(normalizeRating(r), r).toBe('needs_context');
    }
  });

  it('never guesses on an unknown rating', () => {
    expect(normalizeRating('Mostly cromulent')).toBe('unverified');
    expect(normalizeRating('')).toBe('unverified');
    expect(normalizeRating('   ')).toBe('unverified');
  });

  // Regression: naked substring matching routed these to the positive branch
  // because "Untrue" contains "true" and "Inaccurate" contains "accurate".
  it('does not read negated ratings as true', () => {
    expect(normalizeRating('Untrue')).toBe('false');
    expect(normalizeRating('Not true')).toBe('false');
    expect(normalizeRating('Inaccurate')).toBe('false');
  });

  it('treats unconfirmed as unproven, not as true or false', () => {
    expect(normalizeRating('Unconfirmed')).toBe('unverified');
  });

  // ── THE CARDINAL REGRESSION ────────────────────────────────────────────
  // 'no evidence' was in FALSE_WORDS, so a rating of "No Evidence" came back
  // as FALSE — asserting a claim was REFUTED when the fact-checker said only
  // that it was UNSUPPORTED. Absence of evidence is not evidence of absence.
  describe('absence of evidence is never treated as refutation', () => {
    for (const rating of [
      'No evidence',
      'No Evidence',
      'NO EVIDENCE',
      'There is no evidence for this claim',
      'No evidence to support',
      'Insufficient evidence',
      'Unproven',
      'Unsubstantiated',
      'Cannot be verified',
    ]) {
      it(`maps "${rating}" to unverified, not false`, () => {
        expect(normalizeRating(rating)).toBe('unverified');
        expect(normalizeRating(rating)).not.toBe('false');
      });
    }

    // Ordering guard: this string contains 'false' AND 'no evidence'. The
    // absence reading must win, or the fix regresses silently.
    it('reads "no evidence to support this false rumour" as unverified', () => {
      expect(normalizeRating('No evidence to support this false rumour')).toBe('unverified');
    });
  });

  // Blast-radius guard for the reordering above.
  it('still maps genuine refutations to false after the reorder', () => {
    for (const r of ['False', 'Mostly cromulent false', 'Debunked', 'Hoax']) {
      expect(normalizeRating(r) === 'false' || normalizeRating(r) === 'partly_true').toBe(true);
    }
    expect(normalizeRating('False')).toBe('false');
  });
});

describe('coerceVerdict — structured model output', () => {
  it('accepts all six canonical values verbatim', () => {
    for (const v of VERDICTS) {
      expect(coerceVerdict(v), v).toBe(v);
    }
  });

  it('rejects anything else, landing on unverified', () => {
    for (const bad of [
      'mostly true',
      'verified',
      'insufficient_evidence',
      '',
      undefined,
      null,
      42,
      { verdict: 'true' },
    ]) {
      expect(coerceVerdict(bad)).toBe('unverified');
    }
  });

  // The retired four-value enum must not sneak back in through model output.
  it('rejects the superseded four-value names', () => {
    expect(coerceVerdict('verified')).toBe('unverified');
    expect(coerceVerdict('insufficient_evidence')).toBe('unverified');
  });
});

describe('unverified()', () => {
  it('carries no evidence, no basis, and records the reason', () => {
    const r = unverified('nothing found');
    expect(r.verdict).toBe('unverified');
    expect(r.evidence).toEqual([]);
    expect(r.basis).toBe('none');
    expect(r.limitations).toContain('nothing found');
  });

  it('is still exported under its former name', () => {
    expect(insufficient('x').verdict).toBe('unverified');
  });
});
