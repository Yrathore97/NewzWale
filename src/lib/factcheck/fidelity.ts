/** Numeric, temporal and entity fidelity between a claim and a passage.
 *
 *  ── WHY THIS IS DETERMINISTIC ──────────────────────────────────────────────
 *
 *  A source saying "10 million" does not support a claim of "15 million".
 *  A source saying "introduced in 2020" does not support "introduced in 2024".
 *
 *  These are the errors a language model is most prone to and least reliable
 *  at catching: the passage reads as topically supportive, so the model calls
 *  it support, and a materially different number slides through as
 *  corroboration. Arithmetic is exactly the kind of check that should not be
 *  delegated to a probabilistic system.
 *
 *  This module never decides a verdict. It produces a FIDELITY signal that the
 *  stance layer and the gate consume: a passage that contradicts the claim's
 *  numbers cannot be counted as supporting it, whatever a model says. */

export type FidelityStatus = 'match' | 'mismatch' | 'absent';

export interface NumericFact {
  /** The magnitude, normalised to a base unit (crore -> 10^7, etc.). */
  value: number;
  /** What kind of quantity, for like-with-like comparison. */
  unit: 'percent' | 'currency' | 'count' | 'distance' | 'plain';
  /** As written, for display. */
  raw: string;
  /** True when the claim hedged it ("about", "nearly", "roughly"). */
  approximate: boolean;
  /** Smallest increment the figure distinguishes, in the SAME base unit as
   *  `value`.
   *
   *  Carried explicitly because it cannot be recovered from `value` alone.
   *  "7.4 million" states one decimal of a millions figure, so it
   *  distinguishes 100,000 — it does not distinguish 0.1. Deriving precision
   *  from the expanded value instead of the stated mantissa made
   *  "7.4 million" vs "7.42 million" read as a mismatch, which is rounding,
   *  not disagreement. */
  precision: number;
}

export interface FidelityFinding {
  numbers: FidelityStatus;
  years: FidelityStatus;
  entities: FidelityStatus;
  /** Human-readable, only when something mismatched. */
  detail?: string;
  /** The specific conflicting pairs, for the contradiction engine. */
  conflicts: { kind: 'number' | 'year' | 'entity'; claim: string; passage: string }[];
}

const MULTIPLIERS: Record<string, number> = {
  hundred: 1e2,
  thousand: 1e3,
  k: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  million: 1e6,
  mn: 1e6,
  crore: 1e7,
  crores: 1e7,
  billion: 1e9,
  bn: 1e9,
  trillion: 1e12,
};

const HEDGES =
  /\b(about|around|approximately|roughly|nearly|almost|some|circa|~|up to|at least|more than|over|under|less than)\b/i;

/** Extracts comparable numeric facts from text. */
export function extractNumbers(text: string): NumericFact[] {
  const facts: NumericFact[] = [];
  const seen = new Set<string>();

  /** Precision of a stated mantissa, scaled by its magnitude multiplier.
   *  "7.4" with multiplier 1e6 distinguishes 1e5; "500" with multiplier 1e7
   *  distinguishes 1e7. */
  const precisionOf = (mantissa: string, multiplier: number): number => {
    const decimals = mantissa.match(/\.(\d+)/)?.[1]?.length ?? 0;
    return multiplier / 10 ** decimals;
  };

  const add = (
    value: number,
    unit: NumericFact['unit'],
    raw: string,
    approximate: boolean,
    precision: number,
  ) => {
    if (!Number.isFinite(value)) return;
    const key = `${unit}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    facts.push({ value, unit, raw: raw.trim(), approximate, precision });
  };

  // Percentages.
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:per\s*cent|percent|%)/gi)) {
    const before = text.slice(Math.max(0, m.index! - 24), m.index!);
    add(Number(m[1]!.replace(/,/g, '')), 'percent', m[0]!, HEDGES.test(before), precisionOf(m[1]!, 1));
  }

  // Currency, with or without a magnitude word.
  for (const m of text.matchAll(
    /(?:rs\.?|inr|₹|\$|usd|eur|£)\s*(\d[\d,]*(?:\.\d+)?)\s*(crores?|lakhs?|million|billion|trillion|bn|mn|k)?/gi,
  )) {
    const mult = m[2] ? (MULTIPLIERS[m[2].toLowerCase()] ?? 1) : 1;
    const before = text.slice(Math.max(0, m.index! - 24), m.index!);
    add(
      Number(m[1]!.replace(/,/g, '')) * mult,
      'currency',
      m[0]!,
      HEDGES.test(before),
      precisionOf(m[1]!, mult),
    );
  }

  // Bare magnitudes: "500 crore", "15 million people".
  for (const m of text.matchAll(
    /(\d[\d,]*(?:\.\d+)?)\s*(crores?|lakhs?|million|billion|trillion|thousand|hundred)\b/gi,
  )) {
    const mult = MULTIPLIERS[m[2]!.toLowerCase()] ?? 1;
    const before = text.slice(Math.max(0, m.index! - 24), m.index!);
    add(
      Number(m[1]!.replace(/,/g, '')) * mult,
      'count',
      m[0]!,
      HEDGES.test(before),
      precisionOf(m[1]!, mult),
    );
  }

  // Distances.
  for (const m of text.matchAll(
    /(\d[\d,]*(?:\.\d+)?)\s*(km|kilometres|kilometers|metres|meters|miles)\b/gi,
  )) {
    const before = text.slice(Math.max(0, m.index! - 24), m.index!);
    add(Number(m[1]!.replace(/,/g, '')), 'distance', m[0]!, HEDGES.test(before), precisionOf(m[1]!, 1));
  }

  return facts;
}

/** Four-digit years mentioned in the text. */
export function extractYears(text: string): number[] {
  const years = new Set<number>();
  for (const m of text.matchAll(/\b(19\d{2}|20\d{2})\b/g)) years.add(Number(m[1]));
  return [...years];
}

/** Capitalised multi-word names: organisations, people, places. */
export function extractNamedEntities(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(
    /\b([A-Z][a-z]{2,}(?:\s+(?:of|the|and|for|de|van)\s+)?(?:\s+[A-Z][a-zA-Z]{1,})+)\b/g,
  )) {
    found.add(m[1]!.trim());
  }
  return [...found];
}

/** Tolerance for treating two magnitudes as the same figure.
 *
 *  EXACT unless the claim hedged. "About 3 km" tolerates 3.1; "3.0 km" does
 *  not tolerate 3.5. A blanket percentage tolerance would erase exactly the
 *  material differences this module exists to catch. */
function sameMagnitude(claim: NumericFact, passage: NumericFact): boolean {
  if (claim.value === passage.value) return true;

  // Rounding at the precision the CLAIM was stated to. "7.4 million" carries
  // one decimal of a millions figure, so it distinguishes 100,000 — and
  // 7.42 million rounds onto it.
  const p = claim.precision;
  if (p > 0 && Math.round(claim.value / p) === Math.round(passage.value / p)) return true;

  // A hedged claim tolerates ~5%.
  if (claim.approximate) {
    const spread = Math.abs(claim.value - passage.value) / Math.max(Math.abs(claim.value), 1);
    return spread <= 0.05;
  }

  return false;
}

export interface FidelityOptions {
  /** Entity overlap required before entities count as matching. */
  minEntityOverlap?: number;
}

/** Compares a claim against a passage on numbers, years and named entities. */
export function checkFidelity(
  claimText: string,
  passageText: string,
  options: FidelityOptions = {},
): FidelityFinding {
  const conflicts: FidelityFinding['conflicts'] = [];

  // ── Numbers ────────────────────────────────────────────────────────────
  const claimNumbers = extractNumbers(claimText);
  const passageNumbers = extractNumbers(passageText);

  let numbers: FidelityStatus = 'absent';
  if (claimNumbers.length > 0) {
    if (passageNumbers.length === 0) {
      // The claim makes a quantitative assertion the passage never addresses.
      numbers = 'absent';
    } else {
      let matched = 0;
      for (const cn of claimNumbers) {
        // Compare like with like: a percentage never corroborates a headcount.
        const comparable = passageNumbers.filter((pn) => pn.unit === cn.unit);
        if (comparable.length === 0) continue;

        if (comparable.some((pn) => sameMagnitude(cn, pn))) {
          matched += 1;
        } else {
          const nearest = comparable[0]!;
          conflicts.push({ kind: 'number', claim: cn.raw, passage: nearest.raw });
        }
      }
      numbers = conflicts.some((c) => c.kind === 'number')
        ? 'mismatch'
        : matched > 0
          ? 'match'
          : 'absent';
    }
  }

  // ── Years ──────────────────────────────────────────────────────────────
  const claimYears = extractYears(claimText);
  const passageYears = extractYears(passageText);

  let years: FidelityStatus = 'absent';
  if (claimYears.length > 0) {
    if (passageYears.length === 0) {
      years = 'absent';
    } else if (claimYears.some((y) => passageYears.includes(y))) {
      years = 'match';
    } else {
      years = 'mismatch';
      conflicts.push({
        kind: 'year',
        claim: claimYears.join(', '),
        passage: passageYears.join(', '),
      });
    }
  }

  // ── Entities ───────────────────────────────────────────────────────────
  // Entity OVERLAP is a relevance signal, not a fidelity one: a passage
  // mentioning a different organisation is off-topic rather than
  // contradictory. Recorded as absent, never as mismatch, so it can never on
  // its own turn support into contradiction.
  const claimEntities = extractNamedEntities(claimText).map((e) => e.toLowerCase());
  const passageLower = passageText.toLowerCase();
  const minOverlap = options.minEntityOverlap ?? 1;

  let entities: FidelityStatus = 'absent';
  if (claimEntities.length > 0) {
    const hits = claimEntities.filter((e) => passageLower.includes(e)).length;
    entities = hits >= Math.min(minOverlap, claimEntities.length) ? 'match' : 'absent';
  }

  const detail =
    conflicts.length > 0
      ? conflicts
          .map((c) =>
            c.kind === 'year'
              ? `the claim refers to ${c.claim} but the source refers to ${c.passage}`
              : `the claim states ${c.claim} but the source states ${c.passage}`,
          )
          .join('; ')
      : undefined;

  return { numbers, years, entities, detail, conflicts };
}

/** True when fidelity forbids counting this passage as supporting the claim.
 *
 *  The one-way rule: a fidelity mismatch can DEMOTE support, never CREATE it.
 *  A passage with matching numbers is not thereby supporting — it may be
 *  reporting the same figure while denying the claim around it. */
export function fidelityBlocksSupport(finding: FidelityFinding): boolean {
  return finding.numbers === 'mismatch' || finding.years === 'mismatch';
}
