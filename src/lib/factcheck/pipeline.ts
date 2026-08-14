/** The fact-check pipeline orchestrator.
 *
 *  Lifted out of the route so the sequence is testable and the route is only
 *  transport. Structure:
 *
 *    extract claim  ->  retrieve (certified ∥ web)  ->  build evidence
 *      ->  assess deterministically  ->  model proposes  ->  GATE disposes
 *
 *  Two properties are load-bearing and easy to lose in a refactor:
 *
 *  1. Certified reviews and web search run in PARALLEL and are merged. The old
 *     pipeline returned the first certified review immediately, so one
 *     publisher's rating became the verdict with no corroboration.
 *
 *  2. The GATE has the last word. `decideVerdict` consults no model. */

import { assessEvidence } from './evidence';
import { decideVerdict } from './gate';
import { dedupeEvidence } from './dedupe';
import { assessRelevance } from './relevance';
import { checkFidelity } from './fidelity';
import { buildStancePrompt, parseStance, validateStance } from './stance';
import { analyseTemporal, toTemporalFinding } from './temporal';
import { detectSourceConflicts } from './contradiction';
import { buildFactCheckPrompt } from './prompt';
import { parseProposal, invalidProposal } from './parse';
import { profileFor, normalizeDomain, detectSyndication } from './sources';
import { extractClaim, searchQuery } from './claim';
import { EVIDENCE_VERSION, MODEL, PIPELINE_VERSION } from './version';
import type { CertifiedReview } from './google';
import type { SearchHit } from './search';
import type { EvidenceItem, ExtractedClaim, VerdictProposal } from './signals';
import type { Evidence, FactCheckResult } from './types';
import { isSafeUrl } from '../url';

export const MAX_SOURCES = 6;
export const PASSAGE_CHARS = 1500;
/** Search APIs take a query, not a document. */
export const QUERY_CHARS = 300;

export interface FetchedPassage {
  hit: SearchHit;
  text: string;
  readMethod: 'full_page' | 'search_snippet';
  /** NULL means genuinely unknown. Never the fetch time. */
  publishedAt: string | null;
  /** Which metadata field the date came from, for auditability. */
  dateSource?: string;
  /** True when the page carried conflicting publication dates. */
  dateConflict?: boolean;
}

export interface PipelineDeps {
  /** Certified fact-checker reviews. Returns [] when unconfigured. */
  certified: (query: string) => Promise<CertifiedReview[]>;
  /** Web search plus page fetch. Returns [] when unconfigured. */
  passages: (query: string) => Promise<FetchedPassage[]>;
  /** Runs the model over a built prompt. */
  runModel: (system: string, user: string) => Promise<unknown>;
  /** Classifies ONE passage against the claim.
   *
   *  A SEPARATE call from `runModel`, and that separation is the whole point:
   *  it sees one passage and the claim, never the proposed verdict, never the
   *  other passages, never the running corroboration count. Deriving stance
   *  from the verdict would make the gate validate itself.
   *
   *  Optional — when absent, web passages keep the honest 'unclear' default
   *  and simply do not corroborate. */
  classifyStance?: (system: string, user: string) => Promise<unknown>;
  now?: () => Date;
}

/** Builds the evidence set from both retrieval paths.
 *
 *  Certified reviews carry a real tier advantage, but NO exemption from the
 *  corroboration rules — they are evidence, not verdicts. */
export function buildEvidence(
  reviews: CertifiedReview[],
  passages: FetchedPassage[],
  injectionFlags: Map<number, boolean>,
  accessedAt: string,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  let position = 0;

  for (const review of reviews) {
    if (!isSafeUrl(review.url)) continue;
    position += 1;
    const domain = normalizeDomain(review.url);
    items.push({
      position,
      url: review.url,
      title: review.title,
      publisher: review.publisher,
      domain,
      tier: profileFor(domain).tier,
      publishedAt: review.publishedAt,
      accessedAt,
      // A published review's own rating IS its stance on the claim.
      stance:
        review.verdict === 'true'
          ? 'supports'
          : review.verdict === 'false'
            ? 'contradicts'
            : review.verdict === 'unverified'
              ? 'unclear'
              : 'neutral',
      quotedPassage: review.rating ? `Rated "${review.rating}" by ${review.publisher}.` : undefined,
      readMethod: 'full_page',
      injectionFlagged: false,
      loadBearing: true,
    });
  }

  for (const p of passages) {
    if (!isSafeUrl(p.hit.url)) continue;
    position += 1;
    const domain = normalizeDomain(p.hit.url);
    items.push({
      position,
      url: p.hit.url,
      title: p.hit.title,
      publisher: domain || 'Unknown',
      domain,
      tier: profileFor(domain).tier,
      publishedAt: p.publishedAt,
      accessedAt,
      // Stance is refined by the model; 'unclear' is the honest default
      // before anything has classified it.
      stance: 'unclear',
      quotedPassage: p.text.slice(0, 400),
      readMethod: p.readMethod,
      injectionFlagged: injectionFlags.get(position) ?? false,
      loadBearing: true,
      dateSource: p.dateSource,
      dateConflict: p.dateConflict,
    });
  }

  // Collapse wire syndication: three outlets running one agency copy are one
  // source, and counting them as three is how a single-sourced claim launders
  // itself as corroborated.
  const groups = detectSyndication(
    items.map((i) => ({ position: i.position, domain: i.domain, text: i.quotedPassage ?? '' })),
  );
  for (const item of items) {
    const group = groups.get(item.position);
    if (group) item.syndicationGroup = group;
  }

  return items;
}

/** STANCE CLASSIFICATION — implemented in Phase 4, non-circularly.
 *
 *  Phase 3 left web passages at 'unclear' because the only available signal
 *  was the proposed verdict, and stance derived from the verdict would make
 *  the gate validate itself.
 *
 *  The resolution is `deps.classifyStance`: a SEPARATE model call per passage
 *  that sees only (claim, one passage). It never sees the proposed verdict,
 *  the other passages, or the corroboration count. Its output is then
 *  validated by `validateStance`, which can only DEMOTE — deterministic
 *  checks (relevance, numeric fidelity, injection, quote presence) remove
 *  support, never manufacture it.
 *
 *  When `classifyStance` is absent the old behaviour stands: web passages stay
 *  'unclear' and do not corroborate. Under-claiming, not over-claiming. */

export interface PipelineResult extends FactCheckResult {
  extracted: ExtractedClaim;
}

const NO_EVIDENCE =
  'No published fact-check and no supporting sources could be retrieved for this claim, so it cannot be assessed. That is not a judgement that the claim is false - only that there is nothing to check it against.';

export async function runFactCheck(
  input: string,
  deps: PipelineDeps,
  options: { source?: 'text' | 'url' | 'image'; originUrl?: string } = {},
): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date());
  const accessedAt = now().toISOString();

  // ── Stage 1. Extract a checkable claim. ────────────────────────────────
  const extracted = extractClaim(input, options);

  const base = {
    id: undefined,
    claim: extracted.text,
    pipelineVersion: PIPELINE_VERSION,
    evidenceVersion: EVIDENCE_VERSION,
    modelId: MODEL,
    checkedAt: accessedAt,
    extracted,
  };

  // Nothing checkable: stop before spending any retrieval budget.
  if (!extracted.confident || extracted.multiClaim) {
    const decision = decideVerdict({
      proposal: invalidProposal(''),
      assessment: assessEvidence([]),
      components: extracted.components,
      claimConfident: extracted.confident,
      multiClaim: extracted.multiClaim,
    });
    const explanation = decision.limitations.join(' ') || NO_EVIDENCE;
    return {
      ...base,
      verdict: decision.verdict,
      explanation,
      summary: explanation,
      reasoning: '',
      evidence: [],
      basis: 'none',
      evidenceStrength: 'none',
      limitations: decision.limitations,
      proposedVerdict: decision.proposedVerdict,
      gateOverrode: decision.overridden,
      gateRules: decision.reasons.map((r) => r.rule),
      independentSupportingDomains: 0,
      independentContradictingDomains: 0,
    };
  }

  // Retrieval-only. `extracted.text` remains the claim everything downstream
  // is judged against — see the note on `searchQuery`.
  const query = searchQuery(extracted.text, QUERY_CHARS);

  // ── Stage 2. Retrieval — BOTH paths, in parallel. ──────────────────────
  const [reviewsResult, passagesResult] = await Promise.allSettled([
    deps.certified(query),
    deps.passages(query),
  ]);

  const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : [];
  const passages = (passagesResult.status === 'fulfilled' ? passagesResult.value : []).slice(
    0,
    MAX_SOURCES,
  );

  if (reviews.length === 0 && passages.length === 0) {
    return {
      ...base,
      verdict: 'unverified',
      explanation: NO_EVIDENCE,
      summary: NO_EVIDENCE,
      reasoning: '',
      evidence: [],
      basis: 'none',
      evidenceStrength: 'none',
      limitations: [NO_EVIDENCE],
      proposedVerdict: 'unverified',
      gateOverrode: false,
      gateRules: [],
      independentSupportingDomains: 0,
      independentContradictingDomains: 0,
    };
  }

  // ── Stage 3. Build the prompt; injection flags come out of it. ─────────
  const prompt = buildFactCheckPrompt({
    claim: extracted.text,
    passages: passages.map((p) => ({
      publisher: normalizeDomain(p.hit.url) || 'Unknown',
      url: p.hit.url,
      publishedAt: p.publishedAt,
      readMethod: p.readMethod,
      text: p.text.slice(0, PASSAGE_CHARS),
    })),
  });

  // Prompt positions are 1-based over PASSAGES only; evidence positions put
  // certified reviews first, so shift by the review count.
  const injectionFlags = new Map<number, boolean>();
  for (const [passageIndex, signal] of prompt.signals) {
    injectionFlags.set(passageIndex + reviews.length, signal.flagged);
  }

  const rawItems = buildEvidence(reviews, passages, injectionFlags, accessedAt);

  // ── Stage 3b. Deduplicate BEFORE anything is counted. ──────────────────
  // A duplicate is not an inefficiency here, it is a fabricated second source:
  // corroboration is counted over items, so two results for one article would
  // satisfy the two-source floor while proving what one source proved.
  const deduped = dedupeEvidence(rawItems);
  const items = deduped.kept;

  // ── Stage 3c. Deterministic per-item signals. ─────────────────────────
  // Relevance and fidelity are computed BEFORE any classification, so the
  // stance validator has them to overrule the classifier with.
  for (const item of items) {
    const passageText = item.quotedPassage ?? '';
    const relevance = assessRelevance(extracted.text, passageText);
    const fidelity = checkFidelity(extracted.text, passageText);

    item.relevanceLevel = relevance.level;
    item.fidelity = { numbers: fidelity.numbers, years: fidelity.years };

    // Certified reviews are exempt from the relevance gate: they were
    // retrieved BY the claim, and their passage is a rating rather than
    // reporting, so prose-overlap scoring says nothing useful about them.
    const isCertifiedReview = item.position <= reviews.length;
    item.relevant = isCertifiedReview || relevance.countsTowardCorroboration;
  }

  // ── Stage 3d. Stance classification — one passage at a time. ───────────
  if (deps.classifyStance) {
    const stanceFence = prompt.fence;

    await Promise.all(
      items
        // Certified reviews already carry a stance from their own published
        // rating; re-classifying them would discard the publisher's judgement.
        .filter((item) => item.position > reviews.length)
        .map(async (item) => {
          const passageText = item.quotedPassage ?? '';
          if (!passageText) return;

          let candidate;
          try {
            const { system, user } = buildStancePrompt(
              extracted.text,
              { position: item.position, publisher: item.publisher, text: passageText },
              stanceFence,
            );
            candidate = parseStance(await deps.classifyStance!(system, user), item.position);
          } catch {
            // A classifier failure leaves the passage unclassified, which
            // simply means it does not corroborate. Never a guessed stance.
            candidate = { position: item.position, stance: 'unclear' as const, quote: '', rationale: '' };
          }

          const validation = validateStance({
            candidate,
            passageText,
            relevance: assessRelevance(extracted.text, passageText),
            fidelity: checkFidelity(extracted.text, passageText),
            injectionFlagged: item.injectionFlagged,
          });

          item.claimedStance = validation.claimed;
          item.stance = validation.stance;
          item.stanceDemotionReasons = validation.reasons;
          item.quote = candidate.quote;
        }),
    );
  }

  // ── Stage 4. Model proposes an overall verdict. ────────────────────────
  let proposal: VerdictProposal;
  try {
    const raw = await deps.runModel(prompt.system, prompt.user);
    proposal = parseProposal(raw);
  } catch {
    // A model or binding failure is never grounds for a verdict.
    proposal = invalidProposal('The assessment step was unavailable.');
  }

  // ── Stage 5. Deterministic assessment. ────────────────────────────────
  const assessment = assessEvidence(items);

  // ── Stage 5b. Evidence-derived temporal and contradiction findings. ────
  // These OVERRIDE the model's own findings where the deterministic check has
  // something to say. The model may still contribute context analysis, which
  // is genuinely a judgement rather than a computation.
  const supportingForTemporal = items
    .filter((i) => i.stance === 'supports' && !i.injectionFlagged && i.relevant !== false)
    .map((i) => ({ publishedAt: i.publishedAt, passage: i.quotedPassage ?? '' }));

  const temporal = toTemporalFinding(
    analyseTemporal({
      claimText: extracted.text,
      supporting: supportingForTemporal,
      now: now(),
    }),
  );

  // DELIBERATE ASYMMETRY: contradiction detection uses a LOWER relevance bar
  // than corroboration.
  //
  // Excluding a weakly-relevant source from COUNTING toward a verdict is safe
  // — at worst we under-claim. Excluding it from CONFLICT DETECTION hides
  // evidence, which is the opposite kind of error and a far worse one.
  //
  // This was not hypothetical: a source reporting a different figure scored
  // only 'low' relevance because it paraphrased the claim's verb ("totalled"
  // vs "distributed"), so the disagreement was never detected and the reader
  // would have seen a clean verdict over a contested figure. Anything that
  // engages the claim at all is eligible to conflict with another source.
  const conflictEligible = new Set(
    items.filter((i) => (i.relevanceLevel ?? 'none') !== 'none').map((i) => i.position),
  );
  // The stricter set that governs MATERIALITY rather than detection: a
  // disagreement between two sources that both failed the corroboration bar
  // is a fact about those pages, not about the claim. See the option's note
  // in contradiction.ts for the live case this was measured on.
  const corroborationEligible = new Set(
    items.filter((i) => i.relevant !== false).map((i) => i.position),
  );
  const sourceConflicts = detectSourceConflicts(items, {
    relevantPositions: conflictEligible,
    corroboratingPositions: corroborationEligible,
  });

  const gateProposal: VerdictProposal = {
    ...proposal,
    // Deterministic temporal beats the model's, when it found something.
    temporal: temporal.kind !== 'none' ? temporal : proposal.temporal,
    // Arithmetic disagreements are computed, not asked for. Model-reported
    // contradictions are appended, not trusted over these.
    contradictions: [
      ...sourceConflicts.map((c) => ({
        positions: [c.evidenceA, c.evidenceB],
        point: c.point,
        significance: c.materiality,
      })),
      ...proposal.contradictions,
    ],
  };

  const decision = decideVerdict({
    proposal: gateProposal,
    assessment,
    components: extracted.components,
    claimConfident: true,
    multiClaim: false,
  });

  const evidence: Evidence[] = items.map((i) => ({
    position: i.position,
    title: i.title,
    url: i.url,
    publisher: i.publisher,
    domain: i.domain,
    tier: i.tier,
    stance: i.stance,
    publishedAt: i.publishedAt,
    accessedAt: i.accessedAt,
    quotedPassage: i.quotedPassage,
    readMethod: i.readMethod,
    injectionFlagged: i.injectionFlagged,
    relevant: i.relevant,
    relevanceLevel: i.relevanceLevel,
    claimedStance: i.claimedStance,
    stanceDemoted: (i.stanceDemotionReasons?.length ?? 0) > 0,
  }));

  const summary = proposal.summary || decision.limitations[0] || '';
  const explanation = [summary, ...decision.limitations].filter(Boolean).join(' ');

  return {
    ...base,
    verdict: decision.verdict,
    explanation,
    summary,
    reasoning: proposal.reasoning,
    evidence,
    basis:
      decision.verdict === 'unverified'
        ? 'none'
        : reviews.length > 0
          ? 'certified'
          : 'ai_assessment',
    evidenceStrength: decision.strength,
    limitations: decision.limitations,
    proposedVerdict: decision.proposedVerdict,
    gateOverrode: decision.overridden,
    gateRules: decision.reasons.map((r) => r.rule),
    disagreements: proposal.contradictions,
    independentSupportingDomains: assessment.independentSupportingDomains.length,
    independentContradictingDomains: assessment.independentContradictingDomains.length,
  };
}
