/** THE DETERMINISTIC VERDICT GATE.
 *
 *  MODEL PROPOSES. RULES DISPOSE.
 *
 *  Nothing in this file consults a model. Every decision is a pure function of
 *  the evidence assessment and the findings, so it can be exhaustively tested
 *  and cannot be talked out of its position by a well-written web page.
 *
 *  This is the difference between a prompt and a guarantee. A prompt is a
 *  request the model may decline; a function is not.
 *
 *  ── THE INVARIANT THAT OUTRANKS EVERY RULE ─────────────────────────────────
 *
 *  Every downgrade lands on UNVERIFIED. Never on FALSE.
 *
 *  Degrading the evidence available for a claim must never be a route to
 *  refuting it, or an attacker could discredit any true statement by poisoning
 *  or thinning its evidence. FALSE requires positive, corroborated
 *  contradiction - exactly the burden TRUE carries.
 *
 *  Every rule that fires records a GateReason. An unexplained downgrade is a
 *  verdict a reader cannot audit, which defeats the point of the product. */

import {
  ASSERTIVE_VERDICTS,
  INSUFFICIENT_STRENGTHS,
  NOT_ESTABLISHED,
  type Verdict,
} from './schema';
import { contradictingStrength, hasCorroboratingTier } from './evidence';
import type {
  EvidenceAssessment,
  GateReason,
  VerdictDecision,
  VerdictProposal,
  ClaimComponent,
} from './signals';

/** Independent domains required before an assertive verdict may be issued.
 *
 *  Two, not one. "Never trust a single source for important claims" is a
 *  product principle; this constant is where it stops being a slogan. */
export const MIN_INDEPENDENT_DOMAINS = 2;

export interface GateInput {
  proposal: VerdictProposal;
  assessment: EvidenceAssessment;
  components: ClaimComponent[];
  /** False when claim extraction could not confidently identify a claim. */
  claimConfident: boolean;
  /** True when the submission contained several independent assertions. */
  multiClaim: boolean;
}

function reason(rule: string, detail: string): GateReason {
  return { rule, detail };
}

/** Independent domains that ADDRESS the claim — supporting or contextual.
 *
 *  MISLEADING and NEEDS_CONTEXT rest on a different evidential base from
 *  TRUE/FALSE, and conflating them was a real modelling error caught by the
 *  golden set.
 *
 *  For TRUE we need independent sources that AGREE WITH the claim.
 *  For MISLEADING and NEEDS_CONTEXT we need (a) the literal statement
 *  established by a credible source, and (b) independent evidence of the
 *  context that is missing. That second part is usually carried by NEUTRAL
 *  sources — the statistics office publishing the ten-year trend, the health
 *  authority attributing a rise to something else. Those sources do not
 *  support the claim; they are what make it misleading.
 *
 *  Requiring two SUPPORTING domains here made both verdicts unreachable in
 *  exactly the situations they exist for. */
function domainsAddressingClaim(assessment: EvidenceAssessment): number {
  const keys = new Set<string>([
    ...assessment.independentSupportingDomains,
    // Neutral sources are counted from the items, since the assessment only
    // pre-computes supporting and contradicting independence.
    ...assessment.items
      .filter((i) => !i.injectionFlagged && i.stance === 'neutral' && i.domain !== '')
      .map((i) => i.domain),
  ]);
  return keys.size;
}

/** The literal statement is established well enough to talk about its framing.
 *
 *  One credible (tier 1 or 2) supporting source, plus independent corroboration
 *  from somewhere — supporting or contextual. Weaker than the TRUE bar, and
 *  deliberately so: MISLEADING does not assert the claim is true. */
function literalStatementEstablished(assessment: EvidenceAssessment): boolean {
  return (
    assessment.independentSupportingDomains.length >= 1 &&
    hasCorroboratingTier(assessment.bestSupportingTier) &&
    domainsAddressingClaim(assessment) >= MIN_INDEPENDENT_DOMAINS
  );
}

/** Whether the evidence set on its own corroborates a refutation.
 *
 *  The symmetric counterpart to the strong-support correction in Rule 8. Its
 *  absence was an asymmetry bug: an under-confident or mis-specified proposal
 *  could be corrected UP toward TRUE but never toward FALSE, so a claim with
 *  two independent tier-1 contradictions came back "not enough evidence".
 *
 *  Carries exactly the burden TRUE carries — strength floor, two independent
 *  domains, tier floor — plus a requirement that NOTHING supports the claim,
 *  so a mixed picture routes to PARTLY_TRUE instead. */
function contradictionEstablished(assessment: EvidenceAssessment): boolean {
  const strength = contradictingStrength(assessment);
  return (
    !(INSUFFICIENT_STRENGTHS as readonly string[]).includes(strength) &&
    assessment.independentContradictingDomains.length >= MIN_INDEPENDENT_DOMAINS &&
    hasCorroboratingTier(assessment.bestContradictingTier) &&
    assessment.independentSupportingDomains.length === 0
  );
}

/** Applies every gating rule in priority order. */
export function decideVerdict({
  proposal,
  assessment,
  components,
  claimConfident,
  multiClaim,
}: GateInput): VerdictDecision {
  const reasons: GateReason[] = [];
  const proposed = proposal.proposedVerdict;

  const settle = (verdict: Verdict): VerdictDecision => ({
    verdict,
    proposedVerdict: proposed,
    strength: assessment.strength,
    overridden: verdict !== proposed,
    reasons,
    limitations: [...proposal.limitations, ...reasons.map((r) => r.detail)],
  });

  // ── Disclosure. Always recorded, whether or not it changes the outcome. ──
  if (assessment.injectionFlaggedPositions.length > 0) {
    const n = assessment.injectionFlaggedPositions.length;
    // NAME the sources. "One source was compromised" is not auditable; a
    // reader cannot tell which citation to discount, and cannot check our
    // reading of it. Naming them is the whole point of disclosure.
    const names = [
      ...new Set(
        assessment.items.filter((i) => i.injectionFlagged).map((i) => i.domain || i.publisher),
      ),
    ]
      .filter(Boolean)
      .join(', ');

    reasons.push(
      reason(
        'injection_detected',
        `${n} retrieved source${n === 1 ? '' : 's'}${names ? ` (${names})` : ''} contained text attempting to override this system's instructions and ${n === 1 ? 'was' : 'were'} excluded from the assessment. This is not a judgement that the claim itself is false.`,
      ),
    );
  }

  // ── RULE 0. Nothing checkable. ───────────────────────────────────────────
  // An unconfident extraction must never be verdicted: inventing the claim is
  // worse than declining to check it.
  if (!claimConfident) {
    reasons.push(
      reason(
        'claim_not_identified',
        'No single checkable factual claim could be identified in the submission, so nothing was assessed.',
      ),
    );
    return settle(NOT_ESTABLISHED);
  }

  // Several independent assertions cannot honestly share one verdict.
  if (multiClaim) {
    reasons.push(
      reason(
        'multiple_claims',
        'The submission contains more than one independent factual assertion. These must be checked separately; a single verdict cannot describe them all.',
      ),
    );
    return settle(NOT_ESTABLISHED);
  }

  // ── RULE 1. Invalid model output is never a verdict. ─────────────────────
  if (!proposal.valid) {
    reasons.push(
      reason(
        'invalid_model_output',
        'The assessment step did not return a usable result, so no verdict could be established.',
      ),
    );
    return settle(NOT_ESTABLISHED);
  }

  // ── RULE 2. Material contradiction between credible sources. ─────────────
  // Checked BEFORE the assertive rules: if credible sources disagree
  // materially, neither TRUE nor FALSE is available regardless of counts.
  const materialConflicts = proposal.contradictions.filter((c) => c.significance === 'material');
  if (materialConflicts.length > 0 && (ASSERTIVE_VERDICTS as readonly Verdict[]).includes(proposed)) {
    for (const conflict of materialConflicts) {
      reasons.push(
        reason(
          'material_contradiction',
          `Credible sources materially disagree (${conflict.point}). This disagreement is reported rather than resolved.`,
        ),
      );
    }
    return settle(NOT_ESTABLISHED);
  }

  // ── RULE 3. Mixed component statuses => PARTLY_TRUE. ─────────────────────
  // Runs before the assertive gates so a blanket TRUE/FALSE cannot erase a
  // component that went the other way.
  const supported = components.filter((c) => c.status === 'supported');
  const contradicted = components.filter((c) => c.status === 'contradicted');

  if (supported.length > 0 && contradicted.length > 0) {
    // Still requires real corroboration - a mixed reading built on thin
    // evidence is not PARTLY_TRUE, it is unestablished.
    if (
      assessment.independentSupportingDomains.length >= MIN_INDEPENDENT_DOMAINS ||
      assessment.independentContradictingDomains.length >= MIN_INDEPENDENT_DOMAINS
    ) {
      if (proposed !== 'partly_true') {
        reasons.push(
          reason(
            'mixed_components',
            'The claim contains both a supported and a contradicted component, so it is neither wholly accurate nor wholly inaccurate.',
          ),
        );
      }
      return settle('partly_true');
    }

    reasons.push(
      reason(
        'mixed_components_uncorroborated',
        'The claim appears to mix accurate and inaccurate elements, but the evidence is too thin to establish which is which.',
      ),
    );
    return settle(NOT_ESTABLISHED);
  }

  // ── RULE 4. Assertive verdicts require corroborated evidence. ────────────
  if ((ASSERTIVE_VERDICTS as readonly Verdict[]).includes(proposed)) {
    const isTrue = proposed === 'true';

    // 4-pre. A MATERIAL context or temporal finding redirects an assertive
    // proposal BEFORE the corroboration floors are applied.
    //
    // Why before: those floors exist to stop us ASSERTING the claim. Once a
    // material qualification is present we are no longer asserting it — we are
    // reporting that it is incomplete or misframed, which is a weaker and
    // safer statement resting on a different evidential base
    // (literalStatementEstablished).
    //
    // Ordering this after the floors made both verdicts unreachable whenever
    // support was thin-but-credible, which is precisely the situation a
    // misleading claim produces: one authoritative source for the literal
    // fact, and separate sources supplying the context that undermines it.
    const materialContext = proposal.context.significance === 'material';
    const materialTemporal = proposal.temporal.significance === 'material';

    if ((materialContext || materialTemporal) && literalStatementEstablished(assessment)) {
      // Framing defects are MISLEADING; missing qualifications are
      // NEEDS_CONTEXT. The distinction is the kind of finding, not its weight.
      const framingDefect = proposal.context.kind === 'selective_framing';

      reasons.push(
        reason(
          framingDefect ? 'misleading_framing' : 'context_qualification',
          materialContext ? proposal.context.detail : proposal.temporal.detail,
        ),
      );
      return settle(framingDefect ? 'misleading' : 'needs_context');
    }

    const independent = isTrue
      ? assessment.independentSupportingDomains
      : assessment.independentContradictingDomains;
    const tier = isTrue ? assessment.bestSupportingTier : assessment.bestContradictingTier;
    const strength = isTrue ? assessment.strength : contradictingStrength(assessment);

    // ORDERING NOTE. The SPECIFIC checks run before the general one.
    //
    // deriveStrength already folds in domain count and tier, so putting the
    // strength floor first made the corroboration and tier rules unreachable
    // — dead code that no test could detect, since the outcome was identical.
    // A mutation check found exactly that: disabling the tier floor left every
    // test green.
    //
    // Specific-first also gives the reader a far better explanation. "Only one
    // independent source addressed this claim" is actionable; "the evidence is
    // too weak" is not.

    // 4a. Independent corroboration floor.
    if (independent.length < MIN_INDEPENDENT_DOMAINS) {
      reasons.push(
        reason(
          'insufficient_corroboration',
          independent.length === 0
            ? 'No independent source established this claim either way.'
            : `Only ${independent.length} independent source addressed this claim. At least ${MIN_INDEPENDENT_DOMAINS} are required before stating that a claim is true or false.`,
        ),
      );
      return settle(NOT_ESTABLISHED);
    }

    // 4b. Tier floor. Tier-3-only evidence cannot carry an assertion.
    if (!hasCorroboratingTier(tier)) {
      reasons.push(
        reason(
          'tier3_only',
          'The only sources addressing this claim are lower-reliability ones. They can provide context but cannot establish a definite verdict.',
        ),
      );
      return settle(NOT_ESTABLISHED);
    }

    // 4c. Evidence strength floor — the catch-all, after the specific checks.
    // Symmetric for TRUE and FALSE: a claim must not be refutable on evidence
    // too thin to have confirmed it. Still reachable on its own terms, e.g.
    // enough independent tier-2 domains but all snippet-only or all undated.
    if ((INSUFFICIENT_STRENGTHS as readonly string[]).includes(strength)) {
      reasons.push(
        reason(
          'insufficient_strength',
          `The available evidence is too ${strength === 'none' ? 'sparse' : 'weak'} to state that the claim is ${isTrue ? 'true' : 'false'}.`,
        ),
      );
      return settle(NOT_ESTABLISHED);
    }

    // 4d. An unrebutted contradiction blocks TRUE.
    if (isTrue && assessment.independentContradictingDomains.length > 0) {
      reasons.push(
        reason(
          'unrebutted_contradiction',
          `${assessment.independentContradictingDomains.length} independent source contradicts this claim, so it cannot be stated as true.`,
        ),
      );
      return settle(NOT_ESTABLISHED);
    }

    // 4e. Material temporal problem => NEEDS_CONTEXT rather than TRUE.
    // Runs EVEN THOUGH support is strong - which is what makes
    // NEEDS_CONTEXT reachable rather than a decorative enum member.
    if (isTrue && proposal.temporal.significance === 'material') {
      reasons.push(reason('temporal_qualification', proposal.temporal.detail));
      return settle('needs_context');
    }

    // 4f. Material omission => NEEDS_CONTEXT rather than TRUE.
    if (isTrue && proposal.context.significance === 'material') {
      reasons.push(reason('context_qualification', proposal.context.detail));
      return settle('needs_context');
    }

    return settle(proposed);
  }

  // ── RULE 5. NEEDS_CONTEXT requires established substance. ────────────────
  // Without this it becomes a soft-sounding fallback for uncertainty, which is
  // UNVERIFIED wearing a friendlier label.
  if (proposed === 'needs_context') {
    // The evidence may refute the claim outright even though the model
    // proposed a softer verdict. Checked first: "always 20 rupees" contradicted
    // by two dated records is FALSE, not context.
    if (contradictionEstablished(assessment)) {
      reasons.push(
        reason(
          'contradiction_established',
          'Independent sources contradict the claim rather than merely qualifying it.',
        ),
      );
      return settle('false');
    }

    const established = literalStatementEstablished(assessment);

    if (!established) {
      reasons.push(
        reason(
          'context_without_substance',
          'The claim could not be substantiated well enough to say that it merely needs context.',
        ),
      );
      return settle(NOT_ESTABLISHED);
    }

    // And it must actually identify what context is missing.
    if (
      proposal.context.significance !== 'material' &&
      proposal.temporal.significance !== 'material'
    ) {
      reasons.push(
        reason(
          'no_material_context_identified',
          'No specific missing context was identified, so the claim is reported as supported rather than as needing context.',
        ),
      );
      return settle('true');
    }

    return settle(proposed);
  }

  // ── RULE 6. MISLEADING requires a supported literal statement. ───────────
  // The defect must be in the framing. With nothing supporting the literal
  // claim there is nothing for the framing to distort, and MISLEADING would
  // become a hedge for unsupported assertions.
  if (proposed === 'misleading') {
    const literalSupported = literalStatementEstablished(assessment);

    if (!literalSupported) {
      reasons.push(
        reason(
          'misleading_without_support',
          'The underlying statement is not established well enough to assess how it is framed.',
        ),
      );
      return settle(NOT_ESTABLISHED);
    }
    return settle(proposed);
  }

  // ── RULE 7. PARTLY_TRUE proposed without mixed components. ───────────────
  if (proposed === 'partly_true') {
    if (contradicted.length === 0) {
      // The evidence may refute the whole claim rather than part of it — the
      // "slashed rates" case, where the wording asserts a cut and two
      // independent sources say it was held.
      if (contradictionEstablished(assessment)) {
        reasons.push(
          reason(
            'contradiction_established',
            'Independent sources contradict the claim as stated, rather than only part of it.',
          ),
        );
        return settle('false');
      }

      // Nothing is actually contradicted. If support clears the bar this is
      // simply TRUE; otherwise it is unestablished.
      const supportedEnough =
        assessment.independentSupportingDomains.length >= MIN_INDEPENDENT_DOMAINS &&
        hasCorroboratingTier(assessment.bestSupportingTier) &&
        !(INSUFFICIENT_STRENGTHS as readonly string[]).includes(assessment.strength);

      reasons.push(
        reason(
          'no_contradicted_component',
          supportedEnough
            ? 'No part of the claim was contradicted by the evidence.'
            : 'No part of the claim was contradicted, and support was too thin to establish it.',
        ),
      );
      return settle(supportedEnough ? 'true' : NOT_ESTABLISHED);
    }
    return settle(proposed);
  }

  // ── RULE 8. UNVERIFIED proposed. ─────────────────────────────────────────
  // Accepted as-is, with one exception: if the evidence is genuinely strong
  // and nothing contradicts, an under-confident model should not suppress a
  // finding the evidence supports.
  if (proposed === 'unverified') {
    const strongSupport =
      assessment.strength === 'strong' &&
      assessment.independentSupportingDomains.length >= MIN_INDEPENDENT_DOMAINS &&
      hasCorroboratingTier(assessment.bestSupportingTier) &&
      assessment.independentContradictingDomains.length === 0 &&
      contradicted.length === 0 &&
      proposal.temporal.significance !== 'material' &&
      proposal.context.significance !== 'material';

    if (strongSupport && proposal.valid) {
      reasons.push(
        reason(
          'strong_support_upgrade',
          'Multiple independent sources, including an authoritative one, support this claim.',
        ),
      );
      return settle('true');
    }
    return settle(proposed);
  }

  return settle(proposed);
}
