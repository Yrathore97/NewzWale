import { describe, it, expect } from 'vitest';
import {
  significantTokens,
  jaccard,
  isSameStory,
  CLUSTER_WINDOW_MS,
} from '../../src/lib/news/cluster';

const T0 = Date.parse('2026-08-08T10:00:00Z');
const hours = (n: number) => T0 + n * 60 * 60 * 1000;

describe('significantTokens', () => {
  it('drops English function words', () => {
    expect([...significantTokens('The rate was held by the bank')]).toEqual(['rate', 'held', 'bank']);
  });

  // The documented over-merge vector: these words appear in a large share of
  // Indian headlines and carry almost no evidence of WHICH story it is.
  it('drops high-frequency Indian-news filler', () => {
    expect([...significantTokens('PM in Delhi today: government update')]).toEqual([]);
  });

  it('keeps Devanagari words whole rather than shattering on matras', () => {
    // If \p{M} were missing from the split class this would be म/नस/न/...
    expect([...significantTokens('मानसून की बारिश')]).toContain('मानसून');
  });

  it('drops single characters', () => {
    expect([...significantTokens('A B rainfall')]).toEqual(['rainfall']);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('is 0 when either side is empty', () => {
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });
});

describe('isSameStory', () => {
  it('merges the same event reported by two outlets', () => {
    expect(
      isSameStory(
        'ISRO launches Chandrayaan-4 mission successfully',
        'ISRO successfully launches Chandrayaan-4 lunar mission',
        T0,
        hours(2),
      ),
    ).toBe(true);
  });

  /** The cost of the conservative threshold, asserted rather than hidden.
   *
   *  These pairs ARE the same story and are NOT merged (jaccard 0.556 and
   *  0.444, threshold 0.75). Recorded as tests so the trade-off is visible and
   *  so a future entity-aware implementation has a ready target: these should
   *  flip to true, while the near-miss cases below must stay false. */
  it('under-merges genuine paraphrase — known cost of the safe threshold', () => {
    expect(
      isSameStory(
        'RBI holds repo rate at 6.5% for fourth straight review',
        'RBI keeps repo rate unchanged at 6.5% in fourth review',
        T0,
        hours(2),
      ),
    ).toBe(false);

    expect(
      isSameStory(
        'Supreme Court stays Karnataka hijab verdict',
        'SC stays Karnataka hijab verdict, issues notice',
        T0,
        hours(2),
      ),
    ).toBe(false);
  });

  // Why the threshold sits at 0.75 and not lower: this pair scores 0.714 and
  // is two DIFFERENT cases. Any threshold that merged the paraphrase above
  // would merge this too, and claim corroboration that does not exist.
  it('does NOT merge headlines differing by one decisive word', () => {
    expect(
      isSameStory(
        'Supreme Court stays Karnataka hijab verdict',
        'Supreme Court stays Karnataka mining verdict',
        T0,
        hours(1),
      ),
    ).toBe(false);
  });

  it('separates clearly unrelated stories', () => {
    expect(
      isSameStory('RBI holds repo rate at 6.5%', 'Chennai floods displace thousands', T0, hours(1)),
    ).toBe(false);
  });

  // THE critical guard. These headlines share four words and describe two
  // different events; merging them would tell a reader that outlets
  // corroborated something they never reported.
  it('does NOT merge different events that share only generic words', () => {
    expect(
      isSameStory(
        'PM inaugurates Delhi metro line today',
        'PM addresses Delhi rally today',
        T0,
        hours(1),
      ),
    ).toBe(false);
  });

  it('does not merge on a single shared significant word', () => {
    expect(
      isSameStory('Monsoon floods Kerala villages', 'Monsoon session of parliament begins', T0, hours(1)),
    ).toBe(false);
  });

  // A recurring topic must not collapse across separate events months apart.
  it('refuses to merge outside the time window', () => {
    const sameHeadline = 'RBI holds repo rate at 6.5% for fourth straight review';
    expect(isSameStory(sameHeadline, sameHeadline, T0, T0 + CLUSTER_WINDOW_MS + 1)).toBe(false);
    expect(isSameStory(sameHeadline, sameHeadline, T0, T0 + CLUSTER_WINDOW_MS - 1)).toBe(true);
  });

  it('refuses when a date is unparseable rather than guessing', () => {
    const h = 'RBI holds repo rate at 6.5% for fourth straight review';
    expect(isSameStory(h, h, T0, Number.NaN)).toBe(false);
  });

  it('merges an article with itself inside the window', () => {
    const h = 'Chennai floods displace thousands as rains continue';
    expect(isSameStory(h, h, T0, hours(1))).toBe(true);
  });

  it('refuses when a headline is entirely generic', () => {
    expect(isSameStory('India government today', 'India government today', T0, T0)).toBe(false);
  });
});
