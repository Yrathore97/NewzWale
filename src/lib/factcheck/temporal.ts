/** Temporal analysis: does the evidence match the claim's timeframe?
 *
 *  ── THE QUESTION IS MATCH, NOT AGE ─────────────────────────────────────────
 *
 *  Old evidence is not bad evidence. A 2015 source is perfect for a claim
 *  about 2015 and useless for a claim about today. Treating age alone as a
 *  defect would discard exactly the sources that establish historical claims,
 *  and would flatter recent-but-irrelevant ones.
 *
 *  So every finding compares TWO timeframes:
 *      claim_timeframe   what period the claim is about
 *      evidence_timeframe when the evidence describes
 *  and reports the RELATIONSHIP between them.
 *
 *  ── WHERE THIS MATTERS MOST ────────────────────────────────────────────────
 *
 *  A claim in the present tense ("the subsidy IS 7 rupees") asserts something
 *  about now. Evidence from 2024 may have been accurate then and wrong now.
 *  That is not FALSE — the claim may have been true when written — it is
 *  NEEDS_CONTEXT, and detecting it is what makes that verdict reachable. */

import { extractYears } from './fidelity';

export type TemporalRelationship =
  | 'CURRENT'
  | 'HISTORICAL'
  | 'OUTDATED'
  | 'FUTURE'
  | 'TIMEFRAME_UNCLEAR'
  | 'NOT_TIME_SENSITIVE';

export interface TemporalAnalysis {
  /** The period the claim is about, as detected. */
  claimTimeframe: {
    kind: 'present' | 'past' | 'future' | 'explicit_year' | 'unspecified';
    years: number[];
    /** The wording that signalled it. */
    markers: string[];
  };
  /** The period the evidence covers. */
  evidenceTimeframe: {
    /** Publication dates of the supporting evidence. Never inferred. */
    publishedYears: number[];
    /** Years mentioned inside the passages. */
    referencedYears: number[];
    /** True when no supporting source carried a determinable date. */
    undated: boolean;
  };
  relationship: TemporalRelationship;
  materiality: 'material' | 'minor' | 'none';
  detail: string;
}

/** Present-tense assertions about an ongoing state. */
const PRESENT_MARKERS =
  /\b(currently|now|today|at present|as of now|is|are|remains|stands|continues|still)\b/i;

/** Explicitly past-tense or historical framing. */
const PAST_MARKERS =
  /\b(was|were|had been|used to|formerly|previously|in \d{4}|until|since \d{4}|historically|at the time)\b/i;

const FUTURE_MARKERS =
  /\b(will|shall|going to|plans to|expected to|due to|from next|by \d{4}|next year)\b/i;

/** Claims whose truth cannot change with time. */
const TIMELESS_MARKERS = /\b(always|never|ever|any time|by definition)\b/i;

export interface TemporalInput {
  claimText: string;
  /** Supporting evidence only — contradicting evidence answers a different
   *  question and would muddy the timeframe reading. */
  supporting: { publishedAt: string | null; passage: string }[];
  /** Reference point for "current". Injected so tests are deterministic. */
  now?: Date;
}

/** How many years before "now" a present-tense claim's evidence may be before
 *  it is treated as potentially stale.
 *
 *  Two years, not one: policy and statistics genuinely persist across a year,
 *  and flagging everything older than 12 months would make the finding noise. */
const STALENESS_YEARS = 2;

export function analyseTemporal({
  claimText,
  supporting,
  now = new Date(),
}: TemporalInput): TemporalAnalysis {
  const nowYear = now.getUTCFullYear();

  const claimYears = extractYears(claimText);
  const markers: string[] = [];

  let kind: TemporalAnalysis['claimTimeframe']['kind'] = 'unspecified';

  // ORDER MATTERS. Tense outranks the presence of a year: "will be abolished
  // in 2028" carries a year but is a claim about the future, and reading it
  // as a dated historical claim would look for evidence of something that has
  // not happened.
  if (TIMELESS_MARKERS.test(claimText)) {
    markers.push('universal quantifier');
    kind = 'unspecified';
  } else if (FUTURE_MARKERS.test(claimText)) {
    kind = 'future';
    markers.push('future tense');
  } else if (claimYears.length > 0) {
    kind = 'explicit_year';
    markers.push(`explicit year ${claimYears.join(', ')}`);
  } else if (PAST_MARKERS.test(claimText) && !PRESENT_MARKERS.test(claimText)) {
    kind = 'past';
    markers.push('past tense');
  } else if (PRESENT_MARKERS.test(claimText)) {
    kind = 'present';
    markers.push('present tense');
  }

  const publishedYears = supporting
    .map((s) => (s.publishedAt ? new Date(s.publishedAt).getUTCFullYear() : null))
    .filter((y): y is number => y !== null && Number.isFinite(y));

  const referencedYears = [...new Set(supporting.flatMap((s) => extractYears(s.passage)))];
  const undated = supporting.length > 0 && publishedYears.length === 0;

  const evidenceTimeframe = { publishedYears, referencedYears, undated };
  const claimTimeframe = { kind, years: claimYears, markers };

  const base = { claimTimeframe, evidenceTimeframe };

  // No supporting evidence: nothing to compare.
  if (supporting.length === 0) {
    return {
      ...base,
      relationship: 'TIMEFRAME_UNCLEAR',
      materiality: 'none',
      detail: 'No supporting evidence was available to establish a timeframe.',
    };
  }

  // ── Claim about a specific year ────────────────────────────────────────
  if (kind === 'explicit_year') {
    const claimYear = Math.max(...claimYears);
    const covered =
      referencedYears.includes(claimYear) || publishedYears.some((y) => y >= claimYear);

    if (!covered && (referencedYears.length > 0 || publishedYears.length > 0)) {
      const evidenceLatest = Math.max(...[...referencedYears, ...publishedYears]);
      return {
        ...base,
        // Evidence predating the claim's year cannot describe it.
        relationship: evidenceLatest < claimYear ? 'HISTORICAL' : 'TIMEFRAME_UNCLEAR',
        materiality: 'material',
        detail: `The claim concerns ${claimYear}, but the supporting evidence covers ${evidenceLatest}. It may not describe the period the claim is about.`,
      };
    }

    return {
      ...base,
      relationship: 'HISTORICAL',
      materiality: 'none',
      detail: `The claim concerns ${claimYear} and the evidence covers that period.`,
    };
  }

  // ── Present-tense claim: staleness matters ─────────────────────────────
  if (kind === 'present') {
    if (undated) {
      return {
        ...base,
        relationship: 'TIMEFRAME_UNCLEAR',
        materiality: 'material',
        detail:
          'The claim describes the present, but no supporting source carried a determinable publication date, so it cannot be confirmed as current.',
      };
    }

    const newest = Math.max(...publishedYears);
    const age = nowYear - newest;

    if (age > STALENESS_YEARS) {
      return {
        ...base,
        relationship: 'OUTDATED',
        materiality: 'material',
        detail: `The claim is stated in the present tense, but the most recent supporting source is from ${newest}. It may describe a situation that has since changed.`,
      };
    }

    return {
      ...base,
      relationship: 'CURRENT',
      materiality: 'none',
      detail: `Supporting evidence is from ${newest} and matches the claim's present-tense framing.`,
    };
  }

  // ── Future claim: evidence describes a plan, not an outcome ────────────
  if (kind === 'future') {
    return {
      ...base,
      relationship: 'FUTURE',
      materiality: 'material',
      detail:
        'The claim concerns something that has not happened yet. Evidence can show that it is planned or expected, but not that it occurred.',
    };
  }

  // ── Past-tense claim: old evidence is appropriate ──────────────────────
  if (kind === 'past') {
    return {
      ...base,
      relationship: 'HISTORICAL',
      materiality: 'none',
      detail: 'The claim is about a past event and the evidence is read as historical.',
    };
  }

  return {
    ...base,
    relationship: 'NOT_TIME_SENSITIVE',
    materiality: 'none',
    detail: 'The claim does not appear to depend on a particular timeframe.',
  };
}

/** Maps a temporal analysis onto the finding shape the gate consumes. */
export function toTemporalFinding(analysis: TemporalAnalysis): {
  kind: 'outdated' | 'superseded' | 'undated_claim' | 'future_dated' | 'none';
  detail: string;
  positions: number[];
  significance: 'material' | 'minor' | 'none';
} {
  const kind =
    analysis.relationship === 'OUTDATED'
      ? 'outdated'
      : analysis.relationship === 'FUTURE'
        ? 'future_dated'
        : analysis.relationship === 'TIMEFRAME_UNCLEAR' && analysis.materiality === 'material'
          ? 'undated_claim'
          : analysis.relationship === 'HISTORICAL' && analysis.materiality === 'material'
            ? 'superseded'
            : 'none';

  return {
    kind,
    detail: kind === 'none' ? '' : analysis.detail,
    positions: [],
    significance: kind === 'none' ? 'none' : analysis.materiality,
  };
}
