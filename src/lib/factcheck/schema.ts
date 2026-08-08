/** THE authoritative definition of the NewzWale verdict system.
 *
 *  Every other module imports from here. Nothing else may declare a verdict
 *  string literal, a verdict list, or a verdict meaning. If two files disagree
 *  about what MISLEADING means, the product is lying to someone.
 *
 *  ── THE SIX VERDICTS ────────────────────────────────────────────────────────
 *
 *  The four distinctions below are the entire product. Collapsing any pair
 *  destroys the reason NewzWale exists.
 *
 *  TRUE vs FALSE
 *    Symmetric. Both are ASSERTIONS about the world and both therefore carry
 *    the same evidential burden: corroboration across independent domains.
 *
 *  UNVERIFIED vs NEEDS_CONTEXT   — "how much did we establish?"
 *    UNVERIFIED    we could NOT establish the claim. We found little, or what
 *                  we found does not address it.
 *    NEEDS_CONTEXT we DID establish the substance of the claim, and it is
 *                  materially incomplete without a qualification.
 *    These are near-opposites. UNVERIFIED means "we don't know";
 *    NEEDS_CONTEXT means "we know, and here is what you also need to know".
 *    NEEDS_CONTEXT is NEVER a fallback for uncertainty - that is UNVERIFIED.
 *
 *  PARTLY_TRUE vs MISLEADING     — "where is the defect?"
 *    PARTLY_TRUE   the CLAIM ITSELF mixes materially true and materially false
 *                  components. The defect is in the FACTS.
 *    MISLEADING    every component may be literally true, but the framing,
 *                  omission, timeframe or comparison creates a materially
 *                  false impression. The defect is in the PRESENTATION.
 *
 *  ── THE RULE THAT OVERRIDES EVERY OTHER RULE ───────────────────────────────
 *
 *  ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE.
 *
 *  Finding nothing is UNVERIFIED. It is never FALSE. FALSE requires positive
 *  contradicting evidence, held to the same standard as TRUE. This is the
 *  failure mode a fact-checking product must never have, and it has already
 *  been shipped once here (a "No evidence" rating mapped to FALSE). */

export const VERDICTS = [
  'true',
  'false',
  'partly_true',
  'misleading',
  'unverified',
  'needs_context',
] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Verdicts that assert something definite about the world, and therefore
 *  require corroboration before they may be issued. */
export const ASSERTIVE_VERDICTS: readonly Verdict[] = ['true', 'false'];

/** Where every deterministic downgrade lands.
 *
 *  Always UNVERIFIED, never FALSE. Downgrading to FALSE would let an attacker
 *  discredit any true claim simply by degrading the evidence available for it. */
export const NOT_ESTABLISHED: Verdict = 'unverified';

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === 'string' && (VERDICTS as readonly string[]).includes(value);
}

/** Validates a value that is already supposed to BE a Verdict, e.g. structured
 *  model output. Anything unrecognised becomes UNVERIFIED - never a guess. */
export function coerceVerdict(value: unknown): Verdict {
  return isVerdict(value) ? value : NOT_ESTABLISHED;
}

export interface VerdictDefinition {
  verdict: Verdict;
  /** Reader-facing label. */
  label: string;
  /** One-line reader-facing meaning. */
  short: string;
  /** The precise semantic, for the methodology page and for prompts. */
  definition: string;
  /** What this verdict is most often confused with, and why it is different. */
  notToBeConfusedWith: string;
}

export const VERDICT_DEFINITIONS: Record<Verdict, VerdictDefinition> = {
  true: {
    verdict: 'true',
    label: 'True',
    short: 'Supported by reliable evidence, as stated.',
    definition:
      'The claim is supported by sufficient reliable evidence as stated, from independent sources, with no unrebutted contradicting evidence.',
    notToBeConfusedWith:
      'NEEDS_CONTEXT, where the claim is also supported but is materially incomplete without a qualification.',
  },
  false: {
    verdict: 'false',
    label: 'False',
    short: 'Contradicted by reliable evidence.',
    definition:
      'The claim is contradicted by sufficient reliable evidence from independent sources. Requires positive contradicting evidence, held to the same standard as TRUE.',
    notToBeConfusedWith:
      'UNVERIFIED, where no sufficient evidence was found either way. Finding nothing is never FALSE.',
  },
  partly_true: {
    verdict: 'partly_true',
    label: 'Partly true',
    short: 'Some of it holds; an important part does not.',
    definition:
      'The claim contains a materially true component and a materially incorrect component, and the distinction can be established from evidence. The defect is in the facts of the claim itself.',
    notToBeConfusedWith:
      'MISLEADING, where every component may be literally true but the framing creates a false impression.',
  },
  misleading: {
    verdict: 'misleading',
    label: 'Misleading',
    short: 'Technically defensible, but it creates a false impression.',
    definition:
      'The core statement may contain truth, but its framing, omission, timing, comparison or presentation creates a materially misleading impression. The defect is in the presentation, not the facts.',
    notToBeConfusedWith:
      'PARTLY_TRUE, where the claim itself contains a materially incorrect component.',
  },
  unverified: {
    verdict: 'unverified',
    label: 'Not enough evidence',
    short: 'We could not establish this either way.',
    definition:
      'Available evidence is insufficient to establish the claim as true or false with the required confidence. This is a legitimate analytical outcome, not an error, and it is NOT a statement that the claim is false.',
    notToBeConfusedWith:
      'FALSE, which requires positive contradicting evidence; and NEEDS_CONTEXT, which requires that the substance WAS established.',
  },
  needs_context: {
    verdict: 'needs_context',
    label: 'Needs context',
    short: 'Substantially accurate, but incomplete without context.',
    definition:
      'The claim can be substantially supported as stated, but important context, timeframe, qualification or conditions are necessary to prevent a misleading interpretation.',
    notToBeConfusedWith:
      'UNVERIFIED, where the claim could not be established at all. NEEDS_CONTEXT requires that supporting evidence WAS found.',
  },
};

// ---------------------------------------------------------------------------
// Evidence strength
// ---------------------------------------------------------------------------

export const EVIDENCE_STRENGTHS = ['strong', 'moderate', 'weak', 'none'] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export function isEvidenceStrength(value: unknown): value is EvidenceStrength {
  return typeof value === 'string' && (EVIDENCE_STRENGTHS as readonly string[]).includes(value);
}

/** Strength is computed deterministically from the evidence set. It is NEVER
 *  asked of the model: a model's self-reported confidence is not evidence. */
export const EVIDENCE_STRENGTH_DEFINITIONS: Record<EvidenceStrength, string> = {
  strong:
    'Three or more independent domains agree, at least one at Tier 1, all dated, all read in full.',
  moderate: 'Two or more independent domains agree, at least one at Tier 2 or above.',
  weak: 'A single domain, or sources sharing an owner or wire origin, or undated, or snippets only.',
  none: 'Nothing relevant was retrieved.',
};

/** Strengths at which an assertive verdict may NOT be issued. */
export const INSUFFICIENT_STRENGTHS: readonly EvidenceStrength[] = ['weak', 'none'];

// ---------------------------------------------------------------------------
// Source tiers (public model — three tiers)
// ---------------------------------------------------------------------------

export const SOURCE_TIERS = ['tier1', 'tier2', 'tier3'] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const SOURCE_TIER_DEFINITIONS: Record<SourceTier, string> = {
  tier1:
    'Primary or authoritative: government records, regulators, courts, official statistics, an organisation\'s own release, original research.',
  tier2:
    'High-quality secondary: established newsrooms with corrections policies, academic and professional institutions, reputable specialist publications.',
  tier3:
    'Discovery or contextual: blogs, forums, aggregators, social media, unknown publishers. May supply context; cannot on its own establish a high-confidence verdict.',
};

/** Tiers that can carry an assertive verdict. Tier 3 alone cannot. */
export const CORROBORATING_TIERS: readonly SourceTier[] = ['tier1', 'tier2'];

// ---------------------------------------------------------------------------
// Stance — what a source says about the claim.
//
// Deliberately INDEPENDENT of source reliability. A Tier 1 source can
// contradict a claim; a Tier 3 source can support it. Conflating the two is
// how "trusted source therefore true" creeps in, which is the failure this
// product exists to prevent.
// ---------------------------------------------------------------------------

export const STANCES = ['supports', 'contradicts', 'neutral', 'unclear'] as const;
export type Stance = (typeof STANCES)[number];

export const STANCE_DEFINITIONS: Record<Stance, string> = {
  supports: 'The source asserts the claim, or asserts facts that entail it.',
  contradicts: 'The source asserts the claim is untrue, or asserts facts incompatible with it.',
  neutral:
    'The source is about the same subject but neither supports nor contradicts the claim. Useful for context.',
  unclear: 'The source addresses the claim ambiguously, or the passage is too thin to tell.',
};

export function isStance(value: unknown): value is Stance {
  return typeof value === 'string' && (STANCES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Basis — keeps fact separate from inference.
// ---------------------------------------------------------------------------

export const BASES = ['certified', 'ai_assessment', 'none'] as const;
export type Basis = (typeof BASES)[number];

// ---------------------------------------------------------------------------
// Migration from the retired four-value enum.
// ---------------------------------------------------------------------------

/** The superseded enum, retained ONLY to interpret persisted or cached values
 *  written before this migration. Not part of any current contract. */
export type LegacyVerdict = 'verified' | 'misleading' | 'false' | 'insufficient_evidence';

/** Translates a legacy value for READ purposes.
 *
 *  DELIBERATELY LOSSY, and the loss is the point:
 *
 *    verified              -> true
 *    false                 -> false
 *    misleading            -> misleading   (may actually have been partly_true)
 *    insufficient_evidence -> unverified   (may actually have been needs_context)
 *
 *  The old enum could not distinguish partly_true from misleading, nor
 *  unverified from needs_context, so a legacy value cannot be upgraded into
 *  those verdicts without inventing a judgement nobody made.
 *
 *  This is why the cache is version-bumped rather than migrated: legacy
 *  results are made UNREACHABLE, not re-labelled. This function exists for
 *  interpreting archived rows, and must not be used to serve a live verdict. */
export function readLegacyVerdict(legacy: LegacyVerdict): Verdict {
  switch (legacy) {
    case 'verified':
      return 'true';
    case 'false':
      return 'false';
    case 'misleading':
      return 'misleading';
    case 'insufficient_evidence':
      return 'unverified';
  }
}
