import { NOT_ESTABLISHED, type Verdict } from './schema';
import { normalizeRating } from './verdict';

const ENDPOINT = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';

/** One published fact-checker review of the claim. */
export interface CertifiedReview {
  url: string;
  title: string;
  publisher: string;
  /** The publisher's own wording, e.g. "Pants on Fire". Preserved verbatim. */
  rating: string;
  /** That rating mapped into our vocabulary. */
  verdict: Verdict;
  /** Review date where the API supplies one; null when genuinely unknown. */
  publishedAt: string | null;
}

/** Parses every usable review, NOT just the first.
 *
 *  WHY THIS CHANGED. The previous implementation returned a complete
 *  FactCheckResult built from the FIRST review whose rating mapped cleanly,
 *  and the pipeline returned it immediately. One publisher's rating therefore
 *  became NewzWale's verdict, with no corroboration — a direct violation of
 *  "never trust a single source for important claims", and the more serious
 *  for being invisible.
 *
 *  Two IFCN fact-checkers disagreeing is important information a reader must
 *  see. Returning all of them lets the normal corroboration and contradiction
 *  machinery handle certified reviews like any other evidence — with the tier
 *  advantage they have genuinely earned, but no exemption from the rules. */
export function parseGoogleClaims(raw: unknown): CertifiedReview[] {
  const claims = Array.isArray((raw as { claims?: unknown[] })?.claims)
    ? ((raw as { claims: unknown[] }).claims as Record<string, unknown>[])
    : [];

  const reviews: CertifiedReview[] = [];

  for (const claim of claims) {
    const claimReviews = Array.isArray(claim?.claimReview)
      ? (claim.claimReview as Record<string, unknown>[])
      : [];

    for (const review of claimReviews) {
      const url = typeof review?.url === 'string' ? review.url : '';
      if (!url) continue;

      const rating = typeof review.textualRating === 'string' ? review.textualRating : '';
      const verdict = normalizeRating(rating);

      // A rating we cannot place is not evidence of anything. Skipping it is
      // not the same as calling the claim unverified — other reviews and the
      // web-search path still run.
      if (verdict === NOT_ESTABLISHED && rating.trim() === '') continue;

      const publisher =
        (typeof (review.publisher as Record<string, unknown>)?.name === 'string'
          ? ((review.publisher as Record<string, unknown>).name as string)
          : undefined) ??
        (typeof (review.publisher as Record<string, unknown>)?.site === 'string'
          ? ((review.publisher as Record<string, unknown>).site as string)
          : undefined) ??
        'Unknown';

      reviews.push({
        url,
        title:
          (typeof review.title === 'string' && review.title) ||
          (typeof claim.text === 'string' && claim.text) ||
          'Fact check',
        publisher,
        rating,
        verdict,
        // reviewDate is ISO-8601 where present. Never inferred.
        publishedAt: typeof review.reviewDate === 'string' ? review.reviewDate : null,
      });
    }
  }

  return reviews;
}

export async function searchGoogleFactCheck(
  apiKey: string,
  claim: string,
  languageCode = 'en',
): Promise<CertifiedReview[]> {
  const params = new URLSearchParams({ key: apiKey, query: claim, languageCode });
  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) return [];
  return parseGoogleClaims(await res.json());
}
