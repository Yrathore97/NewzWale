import { NOT_ESTABLISHED, coerceVerdict, type Verdict } from './schema';
import type { FactCheckResult } from './types';

export { coerceVerdict };

/** Translates a human-readable rating published by a fact-checker into our
 *  verdict vocabulary.
 *
 *  Distinct from `coerceVerdict`, which validates a value that is already
 *  meant to BE a Verdict (structured model output). Do not substitute one for
 *  the other: normalizeRating('true') is meaningful, but a model returning the
 *  literal string 'true' should go through coerceVerdict.
 *
 *  ORDER MATTERS and is deliberate. Each list is checked in the order below,
 *  because real ratings compose ("Mostly false", "Partly true", "No evidence").
 *  Every reordering needs a test. */

/** Absence of evidence. Checked FIRST, and this ordering is load-bearing.
 *
 *  'no evidence' was previously in FALSE_WORDS, so a published rating of
 *  "No Evidence" came back as FALSE — asserting a claim was REFUTED when the
 *  fact-checker had said only that it was UNSUPPORTED. That is the exact
 *  conflation this product exists to prevent, and it shipped.
 *
 *  Checked before the others because "no evidence to support this false
 *  rumour" contains 'false' too, and the absence reading is the correct one. */
const UNVERIFIED_WORDS = [
  'no evidence',
  'insufficient evidence',
  'unproven',
  'unverified',
  'unsubstantiated',
  'unconfirmed',
  'cannot be verified',
  'not enough evidence',
  'research in progress',
];

/** Missing context, not a factual error. */
const NEEDS_CONTEXT_WORDS = [
  'needs context',
  'missing context',
  'lacks context',
  'context needed',
  'true but',
  'correct but',
  'outdated',
  'no longer accurate',
];

/** The claim mixes true and false components — the defect is in the FACTS. */
const PARTLY_TRUE_WORDS = [
  'partly true',
  'partially true',
  'part true',
  'half true',
  'half-true',
  'mixture',
  'mixed',
  'partly false',
  'partially false',
  'mostly true',
  'mostly false',
];

/** The framing distorts — the defect is in the PRESENTATION. */
const MISLEADING_WORDS = [
  'misleading',
  'miscaptioned',
  'exaggerated',
  'out of context',
  'cherry-picked',
  'distorted',
  'spin',
];

/** Positive refutation. */
const FALSE_WORDS = [
  'false',
  'fake',
  'pants on fire',
  'incorrect',
  'debunked',
  'hoax',
  'untrue',
  'not true',
  'inaccurate',
  'not accurate',
  'fabricated',
  'scam',
];

/** Positive confirmation. */
const TRUE_WORDS = ['true', 'correct', 'accurate', 'confirmed', 'verified', 'genuine'];

export function normalizeRating(rating: string): Verdict {
  const r = (rating ?? '').trim().toLowerCase();
  if (!r) return NOT_ESTABLISHED;

  // Absence of evidence first — see the comment on UNVERIFIED_WORDS.
  if (UNVERIFIED_WORDS.some((w) => r.includes(w))) return NOT_ESTABLISHED;

  // Then the two "partly wrong" families, before the absolutes: "Partly false"
  // contains 'false', and "Mostly true" contains 'true'.
  if (PARTLY_TRUE_WORDS.some((w) => r.includes(w))) return 'partly_true';
  if (MISLEADING_WORDS.some((w) => r.includes(w))) return 'misleading';
  if (NEEDS_CONTEXT_WORDS.some((w) => r.includes(w))) return 'needs_context';

  if (FALSE_WORDS.some((w) => r.includes(w))) return 'false';

  // Word-boundary matched, so "unconfirmed" cannot match "confirmed".
  // Anything we cannot place stays unverified — never a guess.
  if (TRUE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(r))) return 'true';

  return NOT_ESTABLISHED;
}

/** A result carrying no verdict, for the paths where nothing was established. */
export function unverified(explanation: string): FactCheckResult {
  return {
    verdict: NOT_ESTABLISHED,
    explanation,
    evidence: [],
    basis: 'none',
    limitations: [explanation],
  };
}

/** Former name of `unverified`, kept so existing call sites and tests continue
 *  to work. The four-value enum called this state `insufficient_evidence`. */
export const insufficient = unverified;
