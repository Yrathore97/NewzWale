/** Versioning identity for the fact-check pipeline.
 *
 *  These four values ARE the cache identity (see `factCheckCacheKey` in
 *  ../cache.ts). They live together in one module so a methodology change
 *  cannot land without the person making it seeing the version constant they
 *  are obliged to bump.
 *
 *  Why this matters more here than in a normal cache: a fact-check result is a
 *  claim about the world. Serving a verdict produced by superseded methodology
 *  is not a stale-cache annoyance, it is publishing a conclusion the current
 *  system would no longer reach. Bumping a version below makes every affected
 *  entry unreachable immediately - there is no window in which two
 *  methodologies are both live, and no manual purge step to forget.
 *
 *  BUMP RULES
 *
 *  PIPELINE_VERSION - bump when the sequence of stages, the verdict enum, the
 *    verdict-gating rules, or the system prompt changes. Anything that could
 *    make the same evidence yield a different verdict.
 *
 *  EVIDENCE_VERSION - bump when what we retrieve or how we characterise it
 *    changes: source count, extraction, dates, source tiers, stance
 *    classification, corroboration. Anything that could make the same claim
 *    yield a different evidence set.
 *
 *  MODEL - bump implicitly by changing the id. A different model can reach a
 *    different verdict on identical evidence, so it belongs in the identity. */

/** Stage sequence + verdict enum + gating rules + prompt.
 *
 *  1 = the shipped 3-stage pipeline with the 4-value verdict enum.
 *  2 = Phase 3. Six canonical verdicts; claim decomposition; certified and web
 *      retrieval run in parallel instead of short-circuiting; deterministic
 *      gate with corroboration, tier, contradiction, temporal and context
 *      rules; structured model output.
 *  3 = Phase 3, claim-extraction corrections. Sentence splitting no longer
 *      breaks on a year ("...March 2026. The plant..."), and verb detection
 *      gained a morphological fallback. Both changed which submissions are
 *      recognised as MULTI-CLAIM, and a multi-claim submission returns a
 *      different verdict from a single-claim one — so by this file's own rule
 *      the version had to move.
 *
 *      This one was caught the hard way: after the fix, the endpoint kept
 *      returning the pre-fix answer because the cache key had not changed.
 *      Exactly the failure the versioning scheme exists to prevent, on a
 *      smaller scale. Bump the version when behaviour changes, not only when
 *      the enum does.
 *  4 = Phase 4. Deterministic temporal analysis and source-conflict detection
 *      now OVERRIDE the model's own findings, and per-passage stance
 *      classification feeds corroboration. The same claim and the same pages
 *      can therefore reach a different verdict than under version 3.
 *
 *  The bump is MANDATORY, not cosmetic. Verdicts cached under version 1 were
 *  produced by a system that could not express partly_true or needs_context
 *  and would call a tier-3-only claim "verified". Serving one today would
 *  publish a conclusion this system would no longer reach. */
export const PIPELINE_VERSION = 4;

/** Retrieval and evidence characterisation.
 *
 *  1 = Google Fact Check -> Tavily -> unbounded page fetch; no dates, no
 *      tiers, no stance, no independence counting.
 *  2 = Phase 3. Bounded fetch; three-tier source model; independence counting
 *      with syndication and ownership collapse; injection flags per item.
 *      Publication dates were declared but never actually extracted.
 *  3 = Phase 4. Publication dates genuinely extracted from JSON-LD, meta tags
 *      and time elements; claim-relevance filtering; numeric and date fidelity;
 *      block-level passage selection instead of the first N characters;
 *      deduplication before counting. The evidence SET for a given claim is
 *      materially different, so entries from version 2 must not be served.
 *
 *  Same rule as PIPELINE_VERSION: bumping makes affected entries unreachable
 *  rather than re-labelling them. */
export const EVIDENCE_VERSION = 3;

/** Workers AI model backing stage 3.
 *
 *  The task originally specified '@cf/meta/llama-3.1-8b-instruct', but the
 *  live binding answers that id with `AiError: 5028: This model was deprecated
 *  on 2026-05-30` (verified via wrangler dev). Using it would make stage 3
 *  throw on every request, so every claim would come back
 *  insufficient_evidence no matter how good the evidence was. This is the same
 *  model, family and size, on the id that is still served. */
export const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';

/** The version triple as it appears in a cache key and in a persisted
 *  fact_checks row. Stable string form so the two can never disagree. */
export function pipelineIdentity(): string {
  return `p${PIPELINE_VERSION}|e${EVIDENCE_VERSION}|${MODEL}`;
}
