/** Claim extraction and decomposition.
 *
 *  THE PROBLEM THIS FIXES. Previously a URL submission fed up to 4,000
 *  characters of article body in as "the claim". The model was asked to grade
 *  a document rather than a statement, which makes the resulting verdict close
 *  to meaningless — there is no single proposition for it to be about.
 *
 *  THE GOVERNING RULE. Never invent a claim. If a checkable assertion cannot
 *  be identified confidently, `confident` is false and the gate returns
 *  UNVERIFIED. Refusing to check is honest; checking a claim the user did not
 *  make is not.
 *
 *  This module is deliberately RULE-BASED, not model-based. Extraction decides
 *  what gets judged, so a hallucination here poisons everything downstream —
 *  and unlike the verdict itself, extraction has no corroboration step to
 *  catch it. Rules are weaker but auditable. A model may LATER refine the
 *  component split, but only where its output is shown to the user for
 *  confirmation before the check runs. */

import type { ClaimComponent, ExtractedClaim } from './signals';

/** Upper bound on a claim. Anything longer is a document, not a claim. */
export const MAX_CLAIM_CHARS = 2000;
/** Below this there is not enough to check. */
export const MIN_CLAIM_CHARS = 10;

/** Navigation, chrome and legal boilerplate. A submission made mostly of these
 *  contains no assertion, however many words it has. */
const BOILERPLATE_TERMS = [
  'home', 'about', 'contact', 'subscribe', 'newsletter', 'advertise',
  'terms', 'privacy', 'cookie', 'cookies', 'sign in', 'sign up', 'log in',
  'menu', 'search', 'share', 'follow us', 'all rights reserved', 'copyright',
  'read more', 'click here', 'skip to content', 'accept all',
];

/** A sentence needs a verb to assert anything. Crude but effective at
 *  separating "Home About Contact" from "Rates were held at 6.5%".
 *
 *  Two layers, because a closed verb list is the wrong shape for this problem:
 *  any verb not on it makes a real assertion invisible. That was not
 *  hypothetical — "The plant shut in July. The subsidy ended." was read as
 *  containing ONE assertion, so a three-claim submission was silently reduced
 *  to a single verdict. Silently merging claims is exactly what must not
 *  happen, so recall matters more here than precision. */

/** Layer 1: high-signal verbs, including irregular past forms that no
 *  morphological rule will catch. */
const VERB_LIST =
  /\b(is|are|was|were|be|been|being|has|have|had|will|would|can|could|shall|should|may|might|must|said|says|announced|reported|rose|fell|increased|decreased|opened|closed|shut|approved|rejected|launched|banned|found|shows?|showed|declared|passed|failed|spent|cost|paid|held|cut|raised|published|released|appointed|won|lost|killed|died|reached|signed|began|begun|became|brought|built|bought|chose|drove|gave|went|grew|knew|left|made|met|ran|sold|sent|set|took|told|wrote|hit|put|quit|split|spread)\b/i;

/** Layer 2: morphology. A regular past tense (-ed) or third-person present
 *  (-s) in a sentence that already has a noun phrase is almost always an
 *  assertion. Catches "ended", "abolished", "doubled" without enumerating them. */
const VERB_MORPHOLOGY = /\b[a-z]{3,}(?:ed|ied)\b/i;

function hasVerb(sentence: string): boolean {
  return VERB_LIST.test(sentence) || VERB_MORPHOLOGY.test(sentence);
}

/** Hedges and qualifiers. Dropping these changes what was claimed, so they are
 *  captured explicitly rather than normalised away. */
const QUALIFIER_TERMS = [
  'reportedly', 'allegedly', 'apparently', 'approximately', 'about', 'around',
  'nearly', 'almost', 'up to', 'at least', 'more than', 'less than', 'over',
  'under', 'roughly', 'some', 'many', 'most', 'could', 'may', 'might',
  'expected to', 'likely', 'possibly', 'claims', 'suggests',
];

/** Splits on sentence boundaries without breaking decimals or abbreviations.
 *
 *  The lookahead — whitespace then a capital, or end of string — is what
 *  protects decimals: in "6.5 per cent" the period is followed by a digit, so
 *  it never matches.
 *
 *  A `(?<!\d)` lookbehind was here originally, intended to do that same job.
 *  It was redundant given the lookahead AND actively harmful: it blocked every
 *  sentence ending in a year, so "...in March 2026. The plant closed." was
 *  read as ONE assertion. That silently defeated multi-claim detection for
 *  exactly the dated claims this product handles most. Caught by a test. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<![A-Z])[.!?]+(?=\s+[A-Z]|\s*$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Numbers, percentages, currency and magnitudes, as written. */
export function extractQuantities(text: string): string[] {
  const patterns = [
    /\b\d+(?:\.\d+)?\s*(?:per\s*cent|percent|%)/gi,
    /(?:rs\.?|inr|₹|\$|usd|eur|£)\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:crore|lakh|million|billion|trillion|bn|mn|k))?/gi,
    /\b\d[\d,]*(?:\.\d+)?\s*(?:crore|lakh|million|billion|trillion)\b/gi,
    /\b\d[\d,]*(?:\.\d+)?\s*(?:km|kilometres|kilometers|metres|meters|litres|liters|tonnes|tons|kg|people|passengers|votes|seats|deaths|cases)\b/gi,
    /\b\d[\d,]{2,}(?:\.\d+)?\b/g,
  ];

  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.add(m[0].trim());
  }
  return [...found];
}

/** Dates, years, months and relative timeframes, as written. */
export function extractTimeframes(text: string): string[] {
  const patterns = [
    /\b(?:19|20)\d{2}\b/g,
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s*)?(?:19|20)?\d{2,4}\b/gi,
    /\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/gi,
    /\b(?:today|yesterday|tomorrow|last\s+(?:week|month|year|night)|this\s+(?:week|month|year)|next\s+(?:week|month|year)|currently|now|recently|since|until|always|never|ever)\b/gi,
    /\bQ[1-4]\s*(?:FY)?\s*(?:19|20)?\d{2}\b/gi,
    /\bFY\s*(?:19|20)?\d{2}\b/gi,
  ];

  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) found.add(m[0].trim());
  }
  return [...found];
}

/** Capitalised multi-word sequences: people, organisations, places.
 *
 *  Sentence-initial words are excluded unless they continue into another
 *  capital, so "Rates were held" does not yield "Rates". */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  for (const sentence of splitSentences(text)) {
    const re = /\b([A-Z][a-z]+(?:\s+(?:of|the|and|for)\s+)?(?:\s+[A-Z][a-zA-Z]+)+)\b/g;
    for (const m of sentence.matchAll(re)) {
      const candidate = m[1]!.trim();
      if (candidate.split(/\s+/).length >= 2) found.add(candidate);
    }
  }
  return [...found];
}

export function extractQualifiers(text: string): string[] {
  const lower = text.toLowerCase();
  return QUALIFIER_TERMS.filter((q) => new RegExp(`\\b${q}\\b`).test(lower));
}

/** Fraction of tokens that are navigation/legal boilerplate. */
export function boilerplateRatio(text: string): number {
  const lower = text.toLowerCase();
  const tokens = lower.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;

  let hits = 0;
  for (const term of BOILERPLATE_TERMS) {
    const occurrences = lower.split(term).length - 1;
    hits += occurrences * term.split(/\s+/).length;
  }
  return Math.min(1, hits / tokens.length);
}

/** True when a sentence looks like a checkable factual assertion. */
export function isAssertion(sentence: string): boolean {
  if (sentence.trim().length < MIN_CLAIM_CHARS) return false;
  if (!hasVerb(sentence)) return false;
  // A question asks rather than asserts.
  if (/\?\s*$/.test(sentence.trim())) return false;
  return true;
}

/** Classifies what kind of assertion a component makes. */
function classifyComponent(text: string): ClaimComponent['kind'] {
  if (extractQuantities(text).length > 0) return 'quantity';
  if (/\b(said|says|announced|reported|declared|claimed|according to)\b/i.test(text)) {
    return 'attribution';
  }
  if (/\b(because|due to|caused|led to|resulted in|after|following)\b/i.test(text)) return 'causal';
  if (/\b(opened|closed|launched|approved|passed|signed|held|published|released|appointed)\b/i.test(text)) {
    return 'event';
  }
  if (/\b(is|are|was|were|remains|stands)\b/i.test(text)) return 'status';
  return 'other';
}

/** Splits one sentence into components on coordinating conjunctions.
 *
 *  "Spent 500 crore AND the scheme failed" is two assertions in one sentence,
 *  and that split is what makes PARTLY_TRUE reachable — without components
 *  there is nothing to call partly true. Conservative: only splits where both
 *  halves independently look like assertions. */
export function decomposeSentence(sentence: string): string[] {
  const parts = sentence.split(/,?\s+\b(?:and|but|while|whereas|although)\b\s+/i);
  if (parts.length < 2) return [sentence];

  const meaningful = parts.map((p) => p.trim()).filter((p) => p.length >= MIN_CLAIM_CHARS);
  // Both halves must stand alone as assertions, else keep the sentence whole.
  if (meaningful.length >= 2 && meaningful.every(isAssertion)) return meaningful;
  return [sentence];
}

export interface ExtractOptions {
  source?: 'text' | 'url' | 'image';
  originUrl?: string;
}

/** Extracts a checkable claim from a submission. */
export function extractClaim(input: string, options: ExtractOptions = {}): ExtractedClaim {
  const { source = 'text', originUrl } = options;
  const raw = input.trim().replace(/\s+/g, ' ');
  const text = raw.slice(0, MAX_CLAIM_CHARS);

  const base: ExtractedClaim = {
    text,
    components: [],
    entities: [],
    quantities: [],
    timeframes: [],
    qualifiers: [],
    source,
    originUrl,
    confident: false,
    multiClaim: false,
  };

  if (text.length < MIN_CLAIM_CHARS) {
    return { ...base, extractionNote: 'The submission is too short to contain a checkable claim.' };
  }

  // Mostly navigation chrome: there is no assertion here to check.
  if (boilerplateRatio(text) > 0.3) {
    return {
      ...base,
      extractionNote:
        'The submission appears to be navigation or boilerplate text rather than a factual claim.',
    };
  }

  const sentences = splitSentences(text);
  const assertions = sentences.filter(isAssertion);

  if (assertions.length === 0) {
    return {
      ...base,
      extractionNote: 'No checkable factual assertion could be identified in the submission.',
    };
  }

  // Several independent sentences, each asserting something different. These
  // are NOT merged: one verdict cannot honestly describe three findings.
  const multiClaim = assertions.length > 1;

  // The claim we work with is the first assertion; components come from it.
  const primary = assertions[0]!;
  const componentTexts = decomposeSentence(primary);

  const components: ClaimComponent[] = componentTexts.map((t, i) => ({
    id: `c${i + 1}`,
    text: t,
    kind: classifyComponent(t),
    status: 'unassessed',
    evidenceRefs: [],
  }));

  // Sentence splitting drops terminal punctuation. Restore it when the whole
  // submission was that one sentence, so the claim we show back is character-
  // for-character what was submitted. Wording preservation is a promise: a
  // fact check must judge what was said, not a tidied version of it.
  const singleSentenceClaim =
    !multiClaim && text.startsWith(primary) && /^[.!?]*$/.test(text.slice(primary.length))
      ? text
      : primary;

  return {
    text: multiClaim ? text : singleSentenceClaim,
    components,
    entities: extractEntities(primary),
    quantities: extractQuantities(primary),
    timeframes: extractTimeframes(primary),
    qualifiers: extractQualifiers(primary),
    source,
    originUrl,
    confident: true,
    multiClaim,
    extractionNote: multiClaim
      ? `The submission contains ${assertions.length} separate assertions.`
      : undefined,
  };
}
