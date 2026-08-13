import { describe, it, expect } from 'vitest';
import { parseGoogleClaims } from '../../src/lib/factcheck/google';

const review = (over: Record<string, unknown> = {}) => ({
  publisher: { name: 'Boom Live', site: 'boomlive.in' },
  url: 'https://boomlive.in/x',
  title: 'No, vaccines do not contain microchips',
  textualRating: 'False',
  reviewDate: '2026-08-01T00:00:00Z',
  ...over,
});

describe('parseGoogleClaims', () => {
  it('builds a certified review from a claim review', () => {
    const [r] = parseGoogleClaims({
      claims: [{ text: 'COVID vaccines contain microchips', claimReview: [review()] }],
    });
    expect(r).toMatchObject({
      url: 'https://boomlive.in/x',
      publisher: 'Boom Live',
      rating: 'False',
      verdict: 'false',
      publishedAt: '2026-08-01T00:00:00Z',
    });
  });

  it('returns an empty array when there are no claims', () => {
    expect(parseGoogleClaims({ claims: [] })).toEqual([]);
    expect(parseGoogleClaims({})).toEqual([]);
    expect(parseGoogleClaims(null)).toEqual([]);
  });

  it('skips reviews with no url', () => {
    expect(parseGoogleClaims({ claims: [{ claimReview: [review({ url: undefined })] }] })).toEqual(
      [],
    );
  });

  // ── THE BEHAVIOUR CHANGE PHASE 3F REQUIRED ─────────────────────────────
  // This previously returned a complete verdict built from the FIRST mappable
  // review, and the pipeline returned it immediately — one publisher's rating
  // silently became NewzWale's verdict, with no corroboration.
  describe('returns ALL reviews, so no single one can decide the verdict', () => {
    it('collects several reviews of the same claim', () => {
      const reviews = parseGoogleClaims({
        claims: [
          {
            text: 'Some claim',
            claimReview: [
              review({ url: 'https://a.example/1', publisher: { name: 'A' } }),
              review({ url: 'https://b.example/1', publisher: { name: 'B' } }),
            ],
          },
        ],
      });
      expect(reviews).toHaveLength(2);
      expect(reviews.map((r) => r.publisher)).toEqual(['A', 'B']);
    });

    it('collects reviews across several claims', () => {
      const reviews = parseGoogleClaims({
        claims: [
          { text: 'c1', claimReview: [review({ url: 'https://a.example/1' })] },
          { text: 'c2', claimReview: [review({ url: 'https://b.example/2' })] },
        ],
      });
      expect(reviews).toHaveLength(2);
    });

    // Two IFCN fact-checkers disagreeing is important information the reader
    // must see, not something to resolve by silently taking the first.
    it('preserves disagreement between fact-checkers rather than picking one', () => {
      const reviews = parseGoogleClaims({
        claims: [
          {
            text: 'Some claim',
            claimReview: [
              review({ url: 'https://a.example/1', textualRating: 'False' }),
              review({ url: 'https://b.example/1', textualRating: 'True' }),
            ],
          },
        ],
      });
      expect(reviews.map((r) => r.verdict)).toEqual(['false', 'true']);
    });
  });

  it('keeps the publisher wording verbatim alongside the mapped verdict', () => {
    const [r] = parseGoogleClaims({
      claims: [{ claimReview: [review({ textualRating: 'Pants on Fire' })] }],
    });
    expect(r!.rating).toBe('Pants on Fire');
    expect(r!.verdict).toBe('false');
  });

  // Changed deliberately: an unplaceable rating is no longer dropped, because
  // dropping it hid that a fact-checker had looked at the claim at all. It is
  // carried through as `unverified` so the corroboration layer can see it.
  it('carries an unrecognised rating through as unverified rather than dropping it', () => {
    const [r] = parseGoogleClaims({
      claims: [{ claimReview: [review({ textualRating: 'Spicy' })] }],
    });
    expect(r!.verdict).toBe('unverified');
    expect(r!.rating).toBe('Spicy');
  });

  it('skips a review carrying no rating at all', () => {
    expect(parseGoogleClaims({ claims: [{ claimReview: [review({ textualRating: '' })] }] })).toEqual(
      [],
    );
  });

  it('records a null publishedAt when the API gives no review date', () => {
    const [r] = parseGoogleClaims({
      claims: [{ claimReview: [review({ reviewDate: undefined })] }],
    });
    expect(r!.publishedAt).toBeNull();
  });

  it('falls back through publisher name, then site, then Unknown', () => {
    const [a] = parseGoogleClaims({
      claims: [{ claimReview: [review({ publisher: { site: 'x.example' } })] }],
    });
    expect(a!.publisher).toBe('x.example');

    const [b] = parseGoogleClaims({ claims: [{ claimReview: [review({ publisher: {} })] }] });
    expect(b!.publisher).toBe('Unknown');
  });
});
