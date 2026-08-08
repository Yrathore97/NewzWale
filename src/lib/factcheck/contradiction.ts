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
            materiality: conflict.materiality,
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
