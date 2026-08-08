/** SUPERSEDED by ./gate.ts. RETAINED DELIBERATELY.
 *
 *  This is the Phase 1/2 four-value gate. It is no longer on any production
 *  path — src/lib/factcheck/gate.ts replaced it in Phase 3.
 *
 *  It is kept, and typed against LegacyVerdict, for ONE reason: it is what
 *  tests/factcheck/golden/baseline.test.ts runs to record how the old system
 *  behaved on the golden set (21/43, with 12 confidently-wrong verdicts).
 *  Deleting it would delete the measurement that makes "the new engine is
 *  better" a fact rather than a claim.
 *
 *  Do not import this from application code. Do not extend it.
 */

/** Deterministic verdict gating. The model proposes; these rules dispose.
 *
 *  Layer 4 of the injection defence, and the enforcement point for the
 *  product's corroboration principle. Nothing here calls a model. Every rule
 *  is a pure function over the evidence set, so it can be exhaustively tested
 *  and cannot be argued out of its position by a cleverly worded web page.
 *
 *  WHY DETERMINISTIC. A prompt is a request; a function is a guarantee.
 *  Layers 1-3 all reduce to "we asked the model nicely" or "we matched a
 *  pattern we thought of in advance". Both fail open against an attacker who
 *  is better at prompting than we were, or who writes a payload we did not
 *  anticipate. This layer fails closed.
 *
 *  THE DOWNGRADE IS ALWAYS TO "NOT ENOUGH EVIDENCE", NEVER TO "FALSE".
 *  A poisoned source is a reason we cannot establish a claim. It is not
 *  evidence that the claim is untrue. Downgrading to FALSE would let an
 *  attacker discredit any true claim by planting an injection on a page that
 *  happens to discuss it. */

import type { LegacyVerdict } from './schema';

/** Verdicts that assert something definite about the world and therefore
 *  require corroboration. Phase 3 renames these to 'true'/'false'; the set
 *  membership is what matters, not the spelling. */
const ASSERTIVE: LegacyVerdict[] = ['verified', 'false'];

/** Where a blocked assertion lands. Ancestor of the six-verdict UNVERIFIED. */
const NOT_ESTABLISHED: LegacyVerdict = 'insufficient_evidence';

export interface GuardEvidence {
  /** Registrable domain, already normalised. Used for independence counting. */
  domain: string;
  /** True when this passage tripped the injection detector. */
  injectionFlagged: boolean;
  /** Whether the model actually relied on this source. Until stance analysis
   *  lands (Phase 4) every retrieved passage is treated as load-bearing,
   *  which is the conservative reading. */
  loadBearing?: boolean;
}

export interface GuardInput {
  proposed: LegacyVerdict;
  evidence: GuardEvidence[];
  /** Minimum independent clean domains required for an assertive verdict. */
  minIndependentDomains?: number;
}

export interface GuardOutput {
  verdict: LegacyVerdict;
  /** Empty when nothing was downgraded. Each entry is reader-facing text
   *  explaining what the system could not establish and why. */
  limitations: string[];
  /** True when the proposed verdict was overridden. */
  downgraded: boolean;
}

/** Distinct domains among evidence that did NOT trip the detector. */
export function cleanIndependentDomains(evidence: GuardEvidence[]): string[] {
  return [
    ...new Set(
      evidence.filter((e) => !e.injectionFlagged && e.domain).map((e) => e.domain.toLowerCase()),
    ),
  ];
}

/** Applies every gating rule, in order, to a proposed verdict. */
export function applyVerdictGuard({
  proposed,
  evidence,
  minIndependentDomains = 2,
}: GuardInput): GuardOutput {
  const limitations: string[] = [];

  const poisoned = evidence.filter((e) => e.injectionFlagged);
  const clean = cleanIndependentDomains(evidence);

  // Always disclosed, whether or not it changed the outcome. A reader is
  // entitled to know a source tried to manipulate the assessment even when
  // the verdict was unaffected.
  if (poisoned.length > 0) {
    const names = [...new Set(poisoned.map((e) => e.domain))].join(', ');
    limitations.push(
      `${poisoned.length} of ${evidence.length} retrieved sources contained text that tried to override this system's instructions (${names}). Such sources are treated as unreliable for adjudication. This is not a judgement that the claim itself is false.`,
    );
  }

  if (!ASSERTIVE.includes(proposed)) {
    // Non-assertive verdicts make no definite claim, so corroboration rules do
    // not apply. Disclosure above still stands.
    return { verdict: proposed, limitations, downgraded: false };
  }

  // RULE 1 — a poisoned source may not contribute to an assertive verdict.
  // The claim can still be established if enough CLEAN independent sources
  // remain, which is what stops one hostile page from silencing a real answer.
  if (poisoned.length > 0 && clean.length < minIndependentDomains) {
    limitations.push(
      `After setting aside the compromised source${poisoned.length === 1 ? '' : 's'}, only ${clean.length} independent source${clean.length === 1 ? '' : 's'} remained - fewer than the ${minIndependentDomains} required to state a definite verdict.`,
    );
    return { verdict: NOT_ESTABLISHED, limitations, downgraded: true };
  }

  // RULE 2 — corroboration. An assertive verdict needs agreement across
  // independent domains. This is the product principle "never trust a single
  // source for important claims", enforced rather than requested.
  if (clean.length < minIndependentDomains) {
    limitations.push(
      clean.length === 0
        ? 'No usable independent source addressed this claim, so no definite verdict can be stated.'
        : `Only ${clean.length} independent source${clean.length === 1 ? '' : 's'} addressed this claim. At least ${minIndependentDomains} are required before stating that a claim is true or false.`,
    );
    return { verdict: NOT_ESTABLISHED, limitations, downgraded: true };
  }

  return { verdict: proposed, limitations, downgraded: false };
}

/** Registrable-ish domain for independence counting.
 *
 *  Deliberately simple: strips www. and lowercases. It does NOT yet collapse
 *  wire syndication (three outlets running the same PTI copy) or shared
 *  ownership - that needs the source table and lands in Phase 4. Until then
 *  this over-counts independence, so `minIndependentDomains` is a floor, not a
 *  guarantee of genuine independence. Recorded here so the limitation is not
 *  mistaken for a completed control. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}
