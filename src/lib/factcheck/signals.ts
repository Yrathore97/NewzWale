/** The evidence signal model.
 *
 *  These are the typed structures the deterministic gate reasons over. The
 *  design rule throughout: a signal is either OBSERVED (a date in a meta tag, a
 *  domain in the source table) or CLASSIFIED (stance, contradiction, context)
 *  — and the two are never mixed, because only the first can be trusted
 *  without corroboration.
 *
 *  Nothing here stores a model confidence score. Confidence is derived from
 *  the evidence set by `assessEvidence`, deterministically. A model asserting
 *  it is 95% sure is not evidence of anything. */

import type { EvidenceStrength, SourceTier, Stance, Verdict } from './schema';

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** One atomic factual assertion extracted from a submission.
 *
 *  A claim like "The government spent Rs 500 crore and the scheme failed"
 *  carries TWO components. Splitting them is what makes PARTLY_TRUE
 *  reachable: without components there is nothing to say is partly true. */
export interface ClaimComponent {
  id: string;
  /** The component as stated, in the submitter's own words. Never reworded -
   *  a fact check must judge what was said, not a paraphrase of it. */
  text: string;
  /** What kind of assertion this is; drives which checks matter. */
  kind: 'quantity' | 'event' | 'attribution' | 'causal' | 'status' | 'other';
  /** Resolved against evidence. 'unassessed' until stance analysis runs. */
  status: 'supported' | 'contradicted' | 'unassessed';
  /** Positions of the evidence items that decided this component. */
  evidenceRefs: number[];
}

/** The result of claim extraction. */
export interface ExtractedClaim {
  /** The single checkable statement, preserving the submitter's wording. */
  text: string;
  /** Present when the submission contained more than one assertion. */
  components: ClaimComponent[];
  /** Named people and organisations mentioned. */
  entities: string[];
  /** Numbers and statistics, as written. */
  quantities: string[];
  /** Dates and timeframes, as written. */
  timeframes: string[];
  /** Hedges and qualifiers ("reportedly", "up to", "nearly"). Dropping these
   *  changes the claim, so they are captured explicitly. */
  qualifiers: string[];
  /** How the claim was obtained. */
  source: 'text' | 'url' | 'image';
  originUrl?: string;
  /** False when extraction could not confidently identify a single claim.
   *  An unconfident extraction must yield UNVERIFIED, never a guessed claim. */
  confident: boolean;
  /** Why extraction was unconfident, for the limitations field. */
  extractionNote?: string;
  /** True when the submission contained several independent assertions. These
   *  are never silently merged into one verdict. */
  multiClaim: boolean;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** One retrieved source, as it was actually used. */
export interface EvidenceItem {
  /** 1-based; the number the explanation cites. */
  position: number;
  url: string;
  title: string;
  publisher: string;
  /** Registrable domain after normalisation. Independence is counted on this. */
  domain: string;
  tier: SourceTier;

  /** OBSERVED. Publication date from page metadata or the search API.
   *  null means genuinely unknown, and is never back-filled from accessedAt. */
  publishedAt: string | null;
  /** OBSERVED. When we read it. Always known. */
  accessedAt: string;

  /** CLASSIFIED relative to the claim. Independent of tier. */
  stance: Stance;
  /** The exact text relied on, so a reader can check our reading. */
  quotedPassage?: string;
  /** Whether the page was read in full or only a search snippet was available. */
  readMethod: 'full_page' | 'search_snippet';
  /** True when this passage tripped the injection detector. */
  injectionFlagged: boolean;
  /** Set when this source is a wire copy or shares an owner with another —
   *  it then does not count as independent corroboration. */
  syndicationGroup?: string;
  /** Whether the model actually leaned on this source. Conservative default:
   *  everything retrieved is treated as load-bearing. */
  loadBearing: boolean;

  // ── Phase 4 signals. Optional so pre-Phase-4 callers still typecheck. ──

  /** False when the passage does not materially address the claim. Such an
   *  item is retained for display but excluded from corroboration counting:
   *  topical proximity is not evidence. */
  relevant?: boolean;
  /** How strongly it engages the assertion, for ranking and diagnostics. */
  relevanceLevel?: 'high' | 'medium' | 'low' | 'none';
  /** Result of the deterministic numeric/date fidelity comparison. */
  fidelity?: { numbers: 'match' | 'mismatch' | 'absent'; years: 'match' | 'mismatch' | 'absent' };
  /** Where the publication date came from; 'none' when there is none. */
  dateSource?: string;
  /** True when the page carried conflicting publication dates. */
  dateConflict?: boolean;
  /** What the stance classifier said before deterministic validation. */
  claimedStance?: Stance;
  /** Why validation demoted the claimed stance, if it did. */
  stanceDemotionReasons?: string[];
  /** The sentences the classification rests on. */
  quote?: string;
}

/** Two credible sources materially disagreeing WITH EACH OTHER.
 *
 *  Distinct from stance. Stance asks "does this support the claim?";
 *  contradiction asks "do these two sources disagree?". Source disagreement is
 *  itself a finding the reader must see - it must never be silently averaged. */
export interface ContradictionFinding {
  /** Evidence positions that disagree. */
  positions: number[];
  /** What specifically differs, e.g. "reported figure: 10 million vs 15 million". */
  point: string;
  /** material = changes whether the claim holds. minor = does not. */
  significance: 'material' | 'minor';
}

/** A timing problem: the claim was true once, or describes something superseded. */
export interface TemporalFinding {
  kind: 'outdated' | 'superseded' | 'undated_claim' | 'future_dated' | 'none';
  /** Reader-facing explanation. */
  detail: string;
  /** Evidence positions establishing it. */
  positions: number[];
  /** material = a reader would conclude differently without this. */
  significance: 'material' | 'minor' | 'none';
}

/** A material omission: the claim is defensible but incomplete. */
export interface ContextFinding {
  kind:
    | 'missing_timeframe'
    | 'missing_baseline'
    | 'missing_qualifier'
    | 'missing_condition'
    | 'selective_framing'
    | 'none';
  detail: string;
  positions: number[];
  significance: 'material' | 'minor' | 'none';
}

/** Deterministic aggregate over the evidence set. No model involvement. */
export interface EvidenceAssessment {
  items: EvidenceItem[];

  /** Distinct independent domains, after collapsing syndication and ownership. */
  independentDomains: string[];
  independentSupportingDomains: string[];
  independentContradictingDomains: string[];

  supportingCount: number;
  contradictingCount: number;
  neutralCount: number;
  unclearCount: number;

  /** Highest tier present among SUPPORTING evidence, and among CONTRADICTING.
   *  Tracked separately: a Tier 1 contradiction does not license a TRUE. */
  bestSupportingTier: SourceTier | null;
  bestContradictingTier: SourceTier | null;

  /** Derived from the above. Never model-reported. */
  strength: EvidenceStrength;

  /** Sources that tried to manipulate the assessment. */
  injectionFlaggedPositions: number[];
  /** Sources with no determinable publication date. */
  undatedPositions: number[];
}

// ---------------------------------------------------------------------------
// Model output and final decision
// ---------------------------------------------------------------------------

/** What the model is permitted to propose.
 *
 *  Strictly structured. Free-form prose is never parsed for a verdict: an
 *  unparseable or ambiguous response yields UNVERIFIED, never a guess. */
export interface VerdictProposal {
  proposedVerdict: Verdict;
  /** The model's per-component reading, used for PARTLY_TRUE. */
  componentStatuses: { componentId: string; status: 'supported' | 'contradicted' | 'unassessed' }[];
  temporal: TemporalFinding;
  context: ContextFinding;
  contradictions: ContradictionFinding[];
  /** One-line answer. */
  summary: string;
  /** Why this verdict, citing evidence positions. */
  reasoning: string;
  /** Whatever the model itself could not establish. Merged with the gate's. */
  limitations: string[];
  /** False when the response could not be parsed into this shape. */
  valid: boolean;
}

/** Why the deterministic gate reached its conclusion. The audit record. */
export interface GateReason {
  /** Stable identifier, so a downgrade can be counted and tested. */
  rule: string;
  /** Reader-facing sentence. */
  detail: string;
}

/** The final, authoritative verdict. */
export interface VerdictDecision {
  verdict: Verdict;
  /** What the model proposed, retained for auditability even when overridden. */
  proposedVerdict: Verdict;
  strength: EvidenceStrength;
  /** True when the gate overrode the model. */
  overridden: boolean;
  /** Every rule that fired, in order. Empty when the proposal stood unchanged. */
  reasons: GateReason[];
  /** Reader-facing limitations, including every downgrade explanation. */
  limitations: string[];
}
