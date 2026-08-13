/** Deterministic evidence assessment.
 *
 *  Pure functions over the evidence set. NO model is consulted here, and that
 *  is the whole point: evidence strength and corroboration are the signals the
 *  gate uses to overrule a model, so deriving them FROM a model would make the
 *  check circular.
 *
 *  Every rule in this file is exhaustively unit-tested, because these are the
 *  numbers that decide whether NewzWale is allowed to assert anything. */

import {
  CORROBORATING_TIERS,
  type EvidenceStrength,
  type SourceTier,
} from './schema';
import type { EvidenceAssessment, EvidenceItem } from './signals';
import { independenceKey } from './sources';

const TIER_RANK: Record<SourceTier, number> = { tier1: 3, tier2: 2, tier3: 1 };

function bestTier(items: EvidenceItem[]): SourceTier | null {
  if (items.length === 0) return null;
  return items.reduce<SourceTier>(
    (best, item) => (TIER_RANK[item.tier] > TIER_RANK[best] ? item.tier : best),
    'tier3',
  );
}

/** Distinct independence keys, mapped back to readable domains for display. */
function independentDomainsOf(items: EvidenceItem[]): string[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    const key = independenceKey(item);
    if (!seen.has(key)) seen.set(key, item.domain);
  }
  return [...seen.values()];
}

/** Evidence that may contribute to a verdict.
 *
 *  Excluded, and why each:
 *
 *  - INJECTION-FLAGGED. A source that tried to manipulate the assessment has
 *    forfeited its evidential value. Note it is EXCLUDED, not treated as
 *    contradicting: treating manipulation as refutation would let an attacker
 *    discredit any claim by planting a payload on a page discussing it.
 *
 *  - NO DOMAIN. Nothing to count independence on.
 *
 *  - IRRELEVANT (Phase 4). A passage that does not engage the assertion cannot
 *    corroborate it, however topical it looks. This is the rule that stops two
 *    pages about the right organisation from satisfying the two-source floor
 *    while establishing nothing. `relevant` is undefined on items that predate
 *    relevance scoring, and undefined is treated as usable so older callers
 *    are unaffected. */
function usable(items: EvidenceItem[]): EvidenceItem[] {
  return items.filter((i) => !i.injectionFlagged && i.domain !== '' && i.relevant !== false);
}

/** Derives evidence strength from the evidence set alone.
 *
 *  Strength answers "how well is this established?", entirely separately from
 *  "what does it say?". A claim can be FALSE on strong evidence.
 *
 *  The ladder is deliberately strict about READ METHOD and DATES:
 *   - a search snippet can be truncated mid-qualifier, so snippet-only
 *     evidence never rises above weak;
 *   - an undated source cannot settle a time-dependent claim, and we cannot
 *     tell from here which claims those are, so undated evidence is capped too. */
export function deriveStrength(
  supporting: EvidenceItem[],
  independentSupportingCount: number,
): EvidenceStrength {
  if (supporting.length === 0 || independentSupportingCount === 0) return 'none';

  const best = bestTier(supporting);
  const allDated = supporting.every((i) => i.publishedAt !== null);
  const anyDated = supporting.some((i) => i.publishedAt !== null);
  const allFullPage = supporting.every((i) => i.readMethod === 'full_page');
  const anyFullPage = supporting.some((i) => i.readMethod === 'full_page');

  // Snippet-only or entirely undated support is weak regardless of count.
  if (!anyFullPage || !anyDated) return 'weak';

  if (
    independentSupportingCount >= 3 &&
    best === 'tier1' &&
    allDated &&
    allFullPage
  ) {
    return 'strong';
  }

  // Three independent domains with a tier-1 present, but some gap in dating or
  // reading, still reads as strong: breadth is the dominant signal.
  if (independentSupportingCount >= 3 && best === 'tier1') return 'strong';

  if (
    independentSupportingCount >= 2 &&
    best !== null &&
    (CORROBORATING_TIERS as readonly SourceTier[]).includes(best)
  ) {
    return 'moderate';
  }

  return 'weak';
}

/** Builds the full deterministic assessment. */
export function assessEvidence(items: EvidenceItem[]): EvidenceAssessment {
  const clean = usable(items);

  const supporting = clean.filter((i) => i.stance === 'supports');
  const contradicting = clean.filter((i) => i.stance === 'contradicts');
  const neutral = clean.filter((i) => i.stance === 'neutral');
  const unclear = clean.filter((i) => i.stance === 'unclear');

  const independentSupportingDomains = independentDomainsOf(supporting);
  const independentContradictingDomains = independentDomainsOf(contradicting);

  return {
    items,
    independentDomains: independentDomainsOf(clean),
    independentSupportingDomains,
    independentContradictingDomains,

    supportingCount: supporting.length,
    contradictingCount: contradicting.length,
    neutralCount: neutral.length,
    unclearCount: unclear.length,

    bestSupportingTier: bestTier(supporting),
    bestContradictingTier: bestTier(contradicting),

    strength: deriveStrength(supporting, independentSupportingDomains.length),

    injectionFlaggedPositions: items.filter((i) => i.injectionFlagged).map((i) => i.position),
    undatedPositions: clean.filter((i) => i.publishedAt === null).map((i) => i.position),
  };
}

/** Strength of the CONTRADICTING side, for symmetry.
 *
 *  FALSE carries the same evidential burden as TRUE. Without this, a claim
 *  could be refuted on evidence too thin to have confirmed it - which is the
 *  "absence of evidence is evidence of absence" error wearing a better suit. */
export function contradictingStrength(assessment: EvidenceAssessment): EvidenceStrength {
  const contradicting = usable(assessment.items).filter((i) => i.stance === 'contradicts');
  return deriveStrength(contradicting, assessment.independentContradictingDomains.length);
}

/** True when the supporting evidence includes at least one tier-1 or tier-2
 *  source. Tier-3-only support cannot establish an assertive verdict. */
export function hasCorroboratingTier(tier: SourceTier | null): boolean {
  return tier !== null && (CORROBORATING_TIERS as readonly SourceTier[]).includes(tier);
}
