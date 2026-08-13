/** Does this evidence actually address the claim?
 *
 *  ── THE PROBLEM ────────────────────────────────────────────────────────────
 *
 *  A search engine returns pages that are ABOUT the topic. A fact check needs
 *  pages that address the ASSERTION. Those are different, and the gap is where
 *  false corroboration comes from:
 *
 *    Claim:   "The Reserve Board cut rates in August 2026."
 *    Passage: "The Reserve Board's headquarters was renovated in 2019."
 *
 *  Same organisation, high keyword overlap, top search result — and it
 *  establishes nothing. Counting it toward corroboration would let two such
 *  pages satisfy the two-independent-source floor while proving nothing at all.
 *
 *  ── WHAT DOES NOT COUNT AS RELEVANCE ───────────────────────────────────────
 *
 *  Explicitly, per the product rules: shared person, shared organisation,
 *  keyword similarity, search ranking, or same general topic. Relevance
 *  requires the passage to engage with the FACTUAL ASSERTION — its predicate,
 *  its quantities, its timeframe.
 *
 *  ── DIRECTION OF ERROR ─────────────────────────────────────────────────────
 *
 *  When relevance is uncertain the passage does NOT count toward
 *  corroboration. Excluding a genuinely relevant source costs one downgrade to
 *  UNVERIFIED; including an irrelevant one manufactures corroboration that does
 *  not exist. */

import { extractNamedEntities, extractNumbers, extractYears } from './fidelity';

export type RelevanceLevel = 'high' | 'medium' | 'low' | 'none';

export interface RelevanceFinding {
  level: RelevanceLevel;
  /** 0-1, for ranking. Not shown to readers — a score implies a precision
   *  this does not have. */
  score: number;
  /** What actually matched, for auditability. */
  signals: string[];
  /** True when the passage may be counted toward corroboration. */
  countsTowardCorroboration: boolean;
}

/** Words carrying no topical signal. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has',
  'have', 'had', 'will', 'would', 'can', 'could', 'that', 'this', 'these', 'those',
  'it', 'its', 'their', 'his', 'her', 'they', 'he', 'she', 'we', 'you', 'not',
  'said', 'says', 'also', 'than', 'then', 'there', 'here', 'about', 'into', 'over',
]);

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** The verb-like tokens that carry what is being ASSERTED.
 *
 *  This is the difference between topic and assertion: "renovated" vs "cut".
 *  A passage sharing the claim's subject but none of its predicate is about
 *  the same thing without addressing the same question. */
function predicateTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(
    /\b([a-z]{3,}(?:ed|ing|s)?)\b(?=\s|$|[.,;])/gi,
  )) {
    const w = m[1]!.toLowerCase();
    if (STOPWORDS.has(w)) continue;
    if (/(?:ed|ing)$/.test(w) || /^(rose|fell|held|cut|shut|set|won|lost|paid|made|met|ran|sold)$/.test(w)) {
      out.add(w);
    }
  }
  return out;
}

export interface RelevanceOptions {
  /** Minimum score to count toward corroboration. */
  threshold?: number;
}

/** Scores how far a passage engages with the claim's assertion. */
export function assessRelevance(
  claimText: string,
  passageText: string,
  options: RelevanceOptions = {},
): RelevanceFinding {
  const threshold = options.threshold ?? 0.34;
  const signals: string[] = [];

  if (!passageText.trim()) {
    return { level: 'none', score: 0, signals: ['empty passage'], countsTowardCorroboration: false };
  }

  const claimTokens = contentTokens(claimText);
  const passageTokens = contentTokens(passageText);

  if (claimTokens.size === 0) {
    return { level: 'none', score: 0, signals: ['no content words in claim'], countsTowardCorroboration: false };
  }

  // ── Signal 1: topical overlap. NECESSARY BUT NEVER SUFFICIENT. ──────────
  const shared = [...claimTokens].filter((t) => passageTokens.has(t));
  const topical = shared.length / claimTokens.size;
  if (topical > 0) signals.push(`${shared.length}/${claimTokens.size} content words shared`);

  // ── Signal 2: the claim's SUBJECT appears. ──────────────────────────────
  const claimEntities = extractNamedEntities(claimText);
  const passageLower = passageText.toLowerCase();
  const entityHits = claimEntities.filter((e) => passageLower.includes(e.toLowerCase()));
  if (entityHits.length > 0) signals.push(`mentions ${entityHits.join(', ')}`);

  // ── Signal 3: the claim's PREDICATE appears. ────────────────────────────
  // The discriminating signal. Without it, a passage is about the subject
  // rather than about the assertion.
  const claimPredicates = predicateTokens(claimText);
  const passagePredicates = predicateTokens(passageText);
  const predicateHits = [...claimPredicates].filter((p) => passagePredicates.has(p));
  if (predicateHits.length > 0) signals.push(`addresses ${predicateHits.join(', ')}`);

  // ── Signal 4: the claim's specifics appear. ─────────────────────────────
  const claimNumbers = extractNumbers(claimText);
  const passageNumbers = extractNumbers(passageText);
  const numbersEngaged =
    claimNumbers.length > 0 &&
    passageNumbers.some((pn) => claimNumbers.some((cn) => cn.unit === pn.unit));
  if (numbersEngaged) signals.push('engages the claim’s quantities');

  const claimYears = extractYears(claimText);
  const yearsEngaged =
    claimYears.length > 0 && extractYears(passageText).some((y) => claimYears.includes(y));
  if (yearsEngaged) signals.push('shares the claim’s timeframe');

  // Weighted so that predicate and specifics dominate. Topical overlap alone
  // is capped below the threshold ON PURPOSE: keyword similarity must not be
  // able to buy relevance.
  const score =
    topical * 0.3 +
    (entityHits.length > 0 ? 0.15 : 0) +
    (predicateHits.length > 0 ? 0.3 : 0) +
    (numbersEngaged ? 0.15 : 0) +
    (yearsEngaged ? 0.1 : 0);

  const level: RelevanceLevel =
    score >= 0.6 ? 'high' : score >= threshold ? 'medium' : score > 0.12 ? 'low' : 'none';

  return {
    level,
    score: Number(score.toFixed(3)),
    signals,
    // Only high and medium count. When relevance is uncertain the passage is
    // excluded — the safe direction.
    countsTowardCorroboration: level === 'high' || level === 'medium',
  };
}
