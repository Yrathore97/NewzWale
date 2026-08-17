/** Contradiction between SOURCES — distinct from stance against the claim.
 *
 *  Stance asks:        "does this source support the claim?"
 *  Contradiction asks: "do these two sources disagree with each other?"
 *
 *  Two reputable outlets reporting 10 million and 15 million is a finding the
 *  reader must see. The failure mode this prevents is silent resolution: an
 *  averaged figure, or the higher-tier source quietly winning, presented as
 *  though the sources agreed. That hides the single most useful thing the
 *  check found.
 *
 *  Detection over NUMBERS and DATES is deterministic — it is arithmetic, and
 *  arithmetic should not be delegated to a model. Detection over prose
 *  assertions is left to the model and validated here. */

import { extractNumbers, extractYears, type NumericFact } from './fidelity';
import type { EvidenceItem } from './signals';

export type ConflictType = 'number' | 'date' | 'entity' | 'status' | 'causal' | 'policy';

export interface SourceConflict {
  /** The two evidence positions that disagree. */
  evidenceA: number;
  evidenceB: number;
  conflictType: ConflictType;
  /** What specifically differs, in reader-facing words. */
  point: string;
  /** material = changes whether the claim holds. minor = does not. */
  materiality: 'material' | 'minor';
  /** Never 'resolved' by us — we report disagreement, we do not adjudicate it. */
  resolutionStatus: 'unresolved' | 'explained';
  /** The raw values, for display. */
  valueA: string;
  valueB: string;
}

/** Relative difference above which two figures of the same unit are a
 *  material disagreement rather than rounding.
 *
 *  5%: "7.4 million vs 7.42 million" is rounding; "10 million vs 15 million"
 *  is a different claim about the world. */
const MATERIAL_DIFFERENCE = 0.05;

function relativeDifference(a: number, b: number): number {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale;
}

/** Compares two numeric facts of the same unit. */
function numberConflict(
  a: NumericFact,
  b: NumericFact,
): { materiality: 'material' | 'minor' } | null {
  if (a.unit !== b.unit) return null;
  if (a.value === b.value) return null;

  const diff = relativeDifference(a.value, b.value);
  if (diff === 0) return null;

  // A hedged figure ("about 3 km") tolerates more before it is a disagreement.
  const tolerance = a.approximate || b.approximate ? 0.1 : MATERIAL_DIFFERENCE;
  return { materiality: diff > tolerance ? 'material' : 'minor' };
}

export interface DetectConflictsOptions {
  /** Only compare sources that actually engage the claim. */
  relevantPositions?: Set<number>;
  /** Positions that cleared the CORROBORATION relevance bar.
   *
   *  Deliberately a SECOND, stricter set than `relevantPositions`. Conflict
   *  DETECTION keeps the wide net documented in pipeline.ts - a source that
   *  scored only 'low' because it paraphrased the claim's verb must still be
   *  able to disagree with a source that counts. What this set governs is
   *  MATERIALITY, which is a different question: whether a disagreement is
   *  strong enough to forbid any verdict at all.
   *
   *  When BOTH sides of a numeric disagreement failed the corroboration bar,
   *  we are comparing figures from two pages we do not trust to be about the
   *  claim in the first place. Their disagreement is evidence about them, not
   *  about the claim.
   *
   *  MEASURED, not hypothetical. On a live check of "the Agra-Lucknow
   *  Expressway was built by the state government of UP", all three numeric
   *  conflicts were between sources that ALL scored 'low' and none of which
   *  counted: 302 km (the expressway) vs 8.3 km vs 49.96 km (a different 2025
   *  corridor project). Three pages measuring three different things were
   *  reported to the reader as credible sources materially disagreeing, and
   *  the gate's RULE 2 - which runs BEFORE the corroboration floors - vetoed
   *  the verdict on it. Noise outranked signal.
   *
   *  Omitted entirely: every conflict keeps the materiality it computes, i.e.
   *  the previous behaviour. */
  corroboratingPositions?: Set<number>;
}

/** Finds disagreements between evidence passages.
 *
 *  Only compares sources that are BOTH usable: a poisoned source disagreeing
 *  with a clean one is not a source conflict, it is a poisoned source, and
 *  reporting it as disagreement would let an attacker manufacture doubt. */
export function detectSourceConflicts(
  items: EvidenceItem[],
  options: DetectConflictsOptions = {},
): SourceConflict[] {
  const usable = items.filter(
    (i) =>
      !i.injectionFlagged &&
      i.quotedPassage &&
      (!options.relevantPositions || options.relevantPositions.has(i.position)),
  );

  const conflicts: SourceConflict[] = [];

  /** True when NEITHER side cleared the corroboration bar. See the option's
   *  own note: such a pair disagrees about pages, not about the claim. Can
   *  only ever DEMOTE - it never promotes a minor conflict to material. */
  const bothBelowCorroborationBar = (posA: number, posB: number): boolean =>
    options.corroboratingPositions !== undefined &&
    !options.corroboratingPositions.has(posA) &&
    !options.corroboratingPositions.has(posB);

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i]!;
      const b = usable[j]!;

      // Two pages from one publisher restating the same figure is not a
      // disagreement between sources.
      if (a.domain && a.domain === b.domain) continue;

      const aText = a.quotedPassage ?? '';
      const bText = b.quotedPassage ?? '';

      // ── Numbers ──────────────────────────────────────────────────────
      const aNumbers = extractNumbers(aText);
      const bNumbers = extractNumbers(bText);

      for (const an of aNumbers) {
        for (const bn of bNumbers) {
          const conflict = numberConflict(an, bn);
          if (!conflict) continue;
          conflicts.push({
            evidenceA: a.position,
            evidenceB: b.position,
            conflictType: 'number',
            point: `${a.publisher} reports ${an.raw} where ${b.publisher} reports ${bn.raw}`,
            materiality: bothBelowCorroborationBar(a.position, b.position)
              ? 'minor'
              : conflict.materiality,
            resolutionStatus: 'unresolved',
            valueA: an.raw,
            valueB: bn.raw,
          });
        }
      }

      // ── Dates ────────────────────────────────────────────────────────
      const aYears = extractYears(aText);
      const bYears = extractYears(bText);
      if (aYears.length > 0 && bYears.length > 0) {
        const overlap = aYears.some((y) => bYears.includes(y));
        if (!overlap) {
          conflicts.push({
            evidenceA: a.position,
            evidenceB: b.position,
            conflictType: 'date',
            point: `${a.publisher} refers to ${aYears.join(', ')} where ${b.publisher} refers to ${bYears.join(', ')}`,
            // Different years in two passages is often two sources covering
            // different periods, not a disagreement — minor unless something
            // else corroborates the conflict.
            materiality: 'minor',
            resolutionStatus: 'unresolved',
            valueA: aYears.join(', '),
            valueB: bYears.join(', '),
          });
        }
      }
    }
  }

  // Deduplicate: the same pair can conflict on several figures.
  const seen = new Set<string>();
  return conflicts.filter((c) => {
    const key = `${c.evidenceA}-${c.evidenceB}-${c.conflictType}-${c.valueA}-${c.valueB}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True when a material, unresolved disagreement exists between credible
 *  sources — the condition under which no assertive verdict may be issued. */
export function hasMaterialConflict(conflicts: SourceConflict[]): boolean {
  return conflicts.some((c) => c.materiality === 'material' && c.resolutionStatus === 'unresolved');
}
