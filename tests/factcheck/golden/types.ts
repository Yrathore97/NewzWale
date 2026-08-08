import type { EvidenceStrength, SourceTier, Stance, Verdict } from '../../../src/lib/factcheck/schema';

/** Types for the golden-set evaluation fixture.
 *
 *  ── WHAT THIS ARTIFACT IS, PRECISELY ───────────────────────────────────────
 *
 *  Each case is SELF-CONTAINED. `expectedVerdict` is the correct answer GIVEN
 *  THE EVIDENCE RECORDED IN THE CASE — not a claim about the world.
 *
 *  This matters for two reasons:
 *
 *  1. HONESTY. No passage here is quoted from a real publisher, and no case
 *     asserts that any real-world statement is true or false. The passages are
 *     written for evaluation. Where a real domain appears (rbi.org.in,
 *     thehindu.com) it is there ONLY to exercise tier lookup and independence
 *     counting, which are properties of the domain. Nothing is attributed to
 *     those organisations.
 *
 *  2. SCOPE. Retrieval is non-deterministic — it depends on a live search API
 *     and live web pages. A golden set that depended on it would fail for
 *     reasons unrelated to reasoning quality. By supplying the evidence, this
 *     set tests exactly what we control: claim decomposition, stance handling,
 *     contradiction detection, temporal and context analysis, and the
 *     deterministic gate. Those are where confidently-wrong verdicts come from.
 *
 *  `modelProposal` is what a model MIGHT return for the case, including
 *  deliberately wrong and adversarial proposals. The point of the harness is
 *  not "does the model agree" but "when the model is wrong, does the gate stop
 *  it". That is the failure this product cannot afford. */

export interface GoldenEvidence {
  /** Domain, used for tier lookup and independence counting. */
  domain: string;
  publisher: string;
  url: string;
  tier: SourceTier;
  /** Relative to the claim. Independent of tier. */
  stance: Stance;
  /** ISO date, or null where the fixture models an undated source. */
  publishedAt: string | null;
  /** Synthetic passage written for evaluation. NOT a quotation. */
  passage: string;
  readMethod?: 'full_page' | 'search_snippet';
  /** Set when the fixture models a poisoned source. */
  injectionPayload?: boolean;
  /** Wire/ownership group; sources sharing one are not independent. */
  syndicationGroup?: string;
}

export interface GoldenCase {
  id: string;
  claim: string;
  expectedVerdict: Verdict;
  /** Why this verdict is correct given the evidence below. Auditable. */
  expectedReason: string;

  evidence: GoldenEvidence[];

  /** What the claim actually asserts, decomposed. */
  keyFacts: string[];
  /** Context a reader needs that the claim omits, where relevant. */
  importantContext?: string;
  /** The specific mistake this case is designed to catch. */
  knownTraps: string[];

  /** Category tags for reporting. */
  tags: (
    | 'numbers'
    | 'named-entities'
    | 'temporal'
    | 'omission'
    | 'mixed-components'
    | 'disagreement'
    | 'insufficient'
    | 'multi-source'
    | 'single-source'
    | 'tier3-only'
    | 'injection'
    | 'wording'
    | 'multi-claim'
    | 'extraction'
  )[];

  /** What a model might propose. Often deliberately wrong. */
  modelProposal: Verdict;
  /** Expected deterministic strength, where the case pins it. */
  expectedStrength?: EvidenceStrength;
  /** True when the fixture models an unconfident claim extraction. */
  extractionUnconfident?: boolean;
  /** True when the submission contains multiple independent assertions. */
  multiClaim?: boolean;
}

/** A confidently-wrong verdict: the system asserted something definite and was
 *  wrong. This is the failure mode the acceptance gate forbids entirely.
 *
 *  Deliberately asymmetric — returning UNVERIFIED when the answer was TRUE is
 *  a miss, not a danger. Returning TRUE when the answer was FALSE is a danger. */
export function isConfidentlyWrong(expected: Verdict, actual: Verdict): boolean {
  if (expected === actual) return false;
  // Asserting anything definite when the truth was different.
  const assertive: Verdict[] = ['true', 'false', 'partly_true', 'misleading', 'needs_context'];
  if (!assertive.includes(actual)) return false;
  // The worst pairs: claiming true when false, or false when true.
  if (actual === 'true' && (expected === 'false' || expected === 'partly_true')) return true;
  if (actual === 'false' && (expected === 'true' || expected === 'needs_context')) return true;
  // Asserting a definite verdict when the evidence could not establish one.
  if (expected === 'unverified') return true;
  return false;
}
