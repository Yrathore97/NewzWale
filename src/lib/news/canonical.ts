/** Stable identity for a persisted article: canonical URL, id, slug, source.
 *
 *  Everything here is DETERMINISTIC and content-derived. Re-ingesting the same
 *  article a week later must produce byte-identical values, because those
 *  values are the primary key and the dedup boundary — a nondeterministic slug
 *  would create a second row for a story we already have, and a reader's
 *  permalink would rot.
 *
 *  Canonicalisation itself is NOT reimplemented here. `canonicalizeUrl` in
 *  ../url.ts already strips tracking parameters, drops the fragment, lowercases
 *  and de-`www`s the host, sorts the query and trims the trailing slash — and
 *  it returns null for anything unsafe, so an unsafe URL can never become a
 *  database key. This module composes it rather than owning a second copy. */

import { canonicalizeUrl } from '../url';
import { contentId } from '../db/client';

/** Registrable-ish domain for a URL: lowercased host without `www.`.
 *
 *  Deliberately NOT a public-suffix parse. A PSL would be a dependency and a
 *  data file to keep current, and the only thing this value has to do is be
 *  the same string every time for the same publisher. `timesofindia.indiatimes.com`
 *  staying distinct from `indiatimes.com` is acceptable — they are different
 *  publications in practice.
 *
 *  Returns null when the URL is unusable, so callers cannot invent a source. */
export function sourceDomain(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  return host.length > 0 ? host : null;
}

/** Source primary key: sha256 of the domain.
 *
 *  Derived from the domain rather than from a provider name on purpose. The
 *  same publisher reaches us through several providers (The Hindu arrives via
 *  both NewsData and its own RSS feed); keying on the provider would create one
 *  `sources` row per provider per publisher, and "how many independent sources
 *  back this claim" — the number the fact-check engine relies on — would be
 *  inflated by an ingestion detail. */
export function sourceId(domain: string): Promise<string> {
  return contentId(`source:${domain}`);
}

/** Article primary key: sha256 of the canonical URL, matching the schema
 *  comment on `articles.id`. */
export function articleId(canonicalUrl: string): Promise<string> {
  return contentId(canonicalUrl);
}

/** Maximum slug length before the disambiguating suffix. Long enough to stay
 *  readable, short enough to keep URLs manageable. */
const SLUG_MAX = 72;

/** URL-safe slug from a headline.
 *
 *  NON-LATIN SCRIPTS. A Devanagari or Tamil headline contains no ASCII, so a
 *  strict `[a-z0-9]` filter would reduce it to an empty string and every Hindi
 *  article would collide on the same slug. Unicode letters and digits are
 *  therefore KEPT.
 *
 *  `\p{M}` (combining marks) is in the class as well, and is NOT optional.
 *  Devanagari vowel signs — the ू in मानसून — are Marks, not Letters, so
 *  `[\p{L}\p{N}]` alone treats them as separators and shatters the word:
 *  'मानसून की बारिश' becomes 'म-नस-न-क-ब-र-श'. That is the same defect measured
 *  in the FTS tokenizer during Phase 5A, reproduced here in a regex. Verified
 *  by test rather than assumed.
 *
 *  Returns '' when the title has no usable characters at all, which the caller
 *  must handle rather than persist. */
export function slugify(title: string): string {
  const base = title
    .normalize('NFC')
    .toLowerCase()
    // Anything that is not a letter, number or combining mark is a separator.
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

  if (base.length <= SLUG_MAX) return base;
  // Cut on a separator so the slug does not end mid-word.
  const cut = base.slice(0, SLUG_MAX);
  const lastDash = cut.lastIndexOf('-');
  return (lastDash > SLUG_MAX / 2 ? cut.slice(0, lastDash) : cut).replace(/-+$/, '');
}

/** Slug plus a deterministic suffix that makes it unique.
 *
 *  `articles.slug` is UNIQUE, and headlines genuinely repeat — wire copy runs
 *  under one headline at four outlets, and "Budget 2026: what changed" recurs
 *  annually. Suffixing with the first 8 hex characters of the article id keeps
 *  the slug readable, unique, and above all STABLE: it is a function of the
 *  canonical URL, so re-ingesting produces the same slug rather than a second
 *  row. A random or counter-based suffix would not.
 *
 *  Falls back to the bare id when the title yields no slug at all (a headline
 *  of pure punctuation, or an emoji), so persistence never fails on a title we
 *  could not transliterate. */
export function articleSlug(title: string, id: string): string {
  const base = slugify(title);
  const suffix = id.slice(0, 8);
  return base ? `${base}-${suffix}` : suffix;
}

export interface CanonicalArticle {
  id: string;
  slug: string;
  canonicalUrl: string;
  originalUrl: string;
  domain: string;
  sourceId: string;
}

/** Resolves an incoming URL + headline into the identity the database uses.
 *
 *  Returns null when the URL is unsafe or unparseable. Callers treat that as
 *  "skip this article", never as "store it with a placeholder". */
export async function canonicalIdentity(
  rawUrl: string,
  title: string,
): Promise<CanonicalArticle | null> {
  const canonicalUrl = canonicalizeUrl(rawUrl);
  if (!canonicalUrl) return null;

  const domain = sourceDomain(canonicalUrl);
  if (!domain) return null;

  const id = await articleId(canonicalUrl);

  return {
    id,
    slug: articleSlug(title, id),
    canonicalUrl,
    originalUrl: rawUrl,
    domain,
    sourceId: await sourceId(domain),
  };
}
