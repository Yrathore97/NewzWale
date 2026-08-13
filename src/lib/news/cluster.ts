/** Deterministic story clustering: "is this the same real-world story?"
 *
 *  DESIGN POSTURE, taken from NEWZWALE_IMPLEMENTATION_PLAN.md Phase 2 risks:
 *  under-merging is a missing feature, over-merging is a FACTUAL ERROR. A
 *  cluster is rendered to readers as "also reported by N sources", and it feeds
 *  the source-breadth signal behind trending. Wrongly merging two stories
 *  therefore tells a reader that outlets corroborated something they never
 *  reported. Every threshold below is set to fail toward separate clusters.
 *
 *  NO EMBEDDINGS, NO MODEL. Clustering runs inside scheduled ingestion over
 *  every article, so a model call would be a per-article inference cost and,
 *  worse, a nondeterministic one — the same two headlines could cluster today
 *  and not tomorrow. Lexical overlap is weaker but reproducible and auditable,
 *  which is what a corroboration count has to be.
 *
 *  THE GENERIC-WORD TRAP. Indian headlines share a large vocabulary of
 *  near-contentless words: India, government, PM, Delhi, minister, today. Plain
 *  token overlap merges "PM inaugurates Delhi metro line" with "PM addresses
 *  Delhi rally" — different events, four shared tokens. Those words are
 *  therefore removed BEFORE similarity is computed, and a match additionally
 *  requires a floor of shared *significant* tokens, so agreement has to come
 *  from the specific words that name the event. */

/** Words carrying too little information to establish that two headlines
 *  describe the same event.
 *
 *  Two groups: ordinary English function words, and the high-frequency
 *  political/geographic filler of Indian news. The second group is the one that
 *  actually matters — it is the documented over-merge vector.
 *
 *  SCOPE LIMIT, stated rather than hidden: this list is English-only. Hindi and
 *  other Indic headlines are clustered on raw token overlap with no stopword
 *  removal, so they are MORE prone to over-merge on their own filler words
 *  (सरकार, भारत, आज). The similarity floor and the significant-token minimum
 *  still apply, but they are a weaker guard without stopwords. Tracked as a
 *  Phase 5 risk; fixing it needs per-language lists measured against real
 *  headlines, not guessed here. */
const STOPWORDS = new Set([
  // English function words
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'will', 'would', 'can', 'could', 'may', 'says', 'said', 'after',
  'before', 'over', 'under', 'into', 'its', 'it', 'this', 'that', 'these', 'those',
  'new', 'more', 'than', 'not', 'no', 'up', 'down', 'out', 'about', 'amid',
  // High-frequency Indian-news filler. Removing these is what stops
  // "PM in Delhi" from clustering with every other story about the PM in Delhi.
  'india', 'indian', 'indias', 'government', 'govt', 'pm', 'minister', 'ministry',
  'delhi', 'centre', 'center', 'state', 'states', 'national', 'country',
  'today', 'yesterday', 'day', 'week', 'year', 'live', 'updates', 'update',
  'news', 'report', 'reports', 'big', 'top', 'latest', 'breaking', 'watch',
]);

/** Similarity a headline pair must reach to be called the same story.
 *
 *  MEASURED, not guessed. Jaccard over significant tokens for a hand-built
 *  sample of paraphrase pairs and near-miss pairs:
 *
 *    SAME STORY                                        jaccard
 *      ISRO launches Chandrayaan-4 / ... lunar mission   0.833
 *      Chennai floods displace thousands / Thousands...  0.625
 *      RBI holds repo rate / RBI keeps repo rate         0.556
 *      SC stays Karnataka hijab verdict / SC stays...    0.444
 *
 *    DIFFERENT STORY                                   jaccard
 *      SC stays Karnataka HIJAB / SC stays Karnataka MINING  0.714  ← !
 *      ISRO Chandrayaan-4 / ISRO Gaganyaan test             0.286
 *      Monsoon floods Kerala / Monsoon session begins       0.143
 *      PM inaugurates metro / PM addresses rally            0.000
 *
 *  THE DISTRIBUTIONS OVERLAP. A genuinely different story scores 0.714 —
 *  higher than three of the four true pairs — because the headlines differ by
 *  exactly one decisive word. No threshold separates these sets, and no amount
 *  of tuning will: telling `hijab` from `mining` needs entity knowledge that
 *  lexical overlap does not have.
 *
 *  So the threshold is set ABOVE the worst false pair, not between the means.
 *  0.75 merges only the clearest paraphrase and under-merges the rest. That is
 *  the deliberate trade the implementation plan prescribes: under-merging is a
 *  missing "also reported by", over-merging is a false claim that outlets
 *  corroborated a story they never covered.
 *
 *  Raising recall means entity-aware comparison, not a smaller number here. */
export const SIMILARITY_THRESHOLD = 0.75;

/** Minimum significant tokens two headlines must share.
 *
 *  Jaccard alone is unsafe on short headlines: two three-word titles sharing
 *  two words score 0.5-0.67 and would pass a ratio test on almost no evidence.
 *  Requiring an absolute floor as well means agreement has to rest on several
 *  specific words, not on one coincidence. */
export const MIN_SHARED_TOKENS = 3;

/** How far apart two articles may be published and still be one story.
 *
 *  Coverage of a genuine event clusters within hours. A long window is what
 *  lets a recurring topic ("RBI policy review") collapse across separate
 *  events months apart, which is the over-merge failure again. */
export const CLUSTER_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Content-bearing tokens of a headline, lowercased and de-duplicated.
 *
 *  Unicode-aware, and `\p{M}` is load-bearing: Devanagari vowel signs are
 *  combining Marks, not Letters, so splitting on `[^\p{L}\p{N}]` would shatter
 *  'मानसून' into म/नस/न. Tokens would then be single consonants, every Hindi
 *  headline would share them, and clustering would merge unrelated stories —
 *  the exact over-merge failure this module is built to avoid. Same defect as
 *  the FTS tokenizer measured in Phase 5A; here it is ours to fix, and fixed.
 *
 *  Single characters are dropped: initials and stray marks, never the word
 *  that identifies an event. */
export function significantTokens(title: string): Set<string> {
  const tokens = title
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Jaccard overlap of two token sets: shared / combined. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function sharedCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** True when two headlines published `aTime`/`bTime` describe one story.
 *
 *  All four conditions must hold. Any one failing means separate clusters,
 *  which is the safe direction. */
export function isSameStory(
  titleA: string,
  titleB: string,
  aTime: number,
  bTime: number,
): boolean {
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return false;
  if (Math.abs(aTime - bTime) > CLUSTER_WINDOW_MS) return false;

  const a = significantTokens(titleA);
  const b = significantTokens(titleB);

  // Headlines made entirely of stopwords carry no evidence of anything.
  if (a.size === 0 || b.size === 0) return false;
  if (sharedCount(a, b) < MIN_SHARED_TOKENS) return false;

  return jaccard(a, b) >= SIMILARITY_THRESHOLD;
}
