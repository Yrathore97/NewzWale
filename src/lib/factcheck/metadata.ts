/** Deterministic publication-date extraction from a fetched page.
 *
 *  ── THE GOVERNING RULE ─────────────────────────────────────────────────────
 *
 *  A date is EXTRACTED or it is NULL. It is never inferred.
 *
 *  Specifically forbidden as sources of a publication date:
 *    - the fetch time (that is accessedAt, a different fact)
 *    - the URL path (/2024/03/ is a convention, not a statement)
 *    - the filename
 *    - search-result ordering
 *    - body text, unless inside an element explicitly marked as publication
 *      metadata
 *
 *  Why so strict: a claim's truth is often time-dependent ("the subsidy IS 7
 *  rupees"), so a wrong date does not merely mislabel evidence — it can flip a
 *  verdict. A NULL date costs us a downgrade to weaker evidence, which is the
 *  safe direction to be wrong in.
 *
 *  ── CONFLICTS ──────────────────────────────────────────────────────────────
 *
 *  When several fields disagree, we do NOT silently pick one. The precedence
 *  order below is documented and applied deterministically, AND the conflict
 *  is recorded so the reader can see it. */

export type DateSource =
  | 'json_ld'
  | 'meta_article_published'
  | 'meta_og_published'
  | 'meta_generic_date'
  | 'time_element'
  | 'rss'
  | 'provider'
  | 'none';

export interface DateCandidate {
  /** ISO-8601, normalised to UTC. */
  iso: string;
  source: DateSource;
  /** Exactly as it appeared, for auditability. */
  raw: string;
}

export interface PublicationDateResult {
  /** ISO-8601, or null when no date could be established. NEVER inferred. */
  publishedAt: string | null;
  /** Which field it came from. 'none' when null. */
  source: DateSource;
  /** Every distinct date found, in precedence order. */
  candidates: DateCandidate[];
  /** True when candidates disagree by more than the tolerance. Surfaced to the
   *  reader rather than resolved silently. */
  conflict: boolean;
  /** Human-readable note when there was a conflict. */
  conflictNote?: string;
}

/** PRECEDENCE, most to least authoritative.
 *
 *  Structured metadata beats unstructured. Publisher-declared beats
 *  aggregator-declared: a provider's own date field is a third party's opinion
 *  about when the publisher published, so it ranks below the publisher's own
 *  markup. */
const PRECEDENCE: DateSource[] = [
  'json_ld',
  'meta_article_published',
  'meta_og_published',
  'time_element',
  'meta_generic_date',
  'rss',
  'provider',
];

/** Two candidates within this many milliseconds are the same publication
 *  moment expressed differently (timezone rendering, second-level rounding).
 *  Wider than a day would let a genuine "republished next morning" difference
 *  hide. */
const CONFLICT_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Parses a date string into ISO-8601 UTC, or null.
 *
 *  Accepts ISO-8601, RFC 2822 (RSS), and a few common publisher formats.
 *  Deliberately REFUSES bare years and ambiguous numeric forms like
 *  "03/04/2026", which is March 4th or April 3rd depending on locale — a
 *  coin-flip is not extraction. */
export function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  // A bare year is not a publication date.
  if (/^\d{4}$/.test(value)) return null;
  // Ambiguous day/month ordering: refuse rather than guess.
  if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(value)) return null;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;

  // Sanity window. A 1970 epoch-zero or a far-future date is a parsing
  // artefact, not a publication date.
  const year = new Date(parsed).getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 2) return null;

  return new Date(parsed).toISOString();
}

function push(into: DateCandidate[], iso: string | null, source: DateSource, raw: string): void {
  if (!iso) return;
  if (into.some((c) => c.iso === iso && c.source === source)) return;
  into.push({ iso, source, raw: raw.slice(0, 120) });
}

/** Walks a JSON-LD object graph for publication dates.
 *
 *  Schema.org nests these arbitrarily (@graph, arrays, nested Article nodes),
 *  so a recursive walk is more reliable than guessing the shape. Depth-bounded
 *  because the JSON comes from an untrusted page. */
function collectJsonLd(node: unknown, out: DateCandidate[], depth = 0): void {
  if (depth > 6 || !node) return;

  if (Array.isArray(node)) {
    for (const child of node.slice(0, 50)) collectJsonLd(child, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const obj = node as Record<string, unknown>;

  // datePublished is the publication moment. dateModified is NOT: an article
  // edited today was not published today, and treating it as such would make
  // stale evidence look current.
  for (const key of ['datePublished', 'dateCreated', 'uploadDate']) {
    if (typeof obj[key] === 'string') push(out, parseDate(obj[key]), 'json_ld', obj[key] as string);
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') collectJsonLd(value, out, depth + 1);
  }
}

/** Extracts every JSON-LD block from HTML. */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re =
    /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  let count = 0;
  while ((match = re.exec(html)) !== null && count < 20) {
    count += 1;
    try {
      blocks.push(JSON.parse(match[1]!.trim()));
    } catch {
      // A malformed JSON-LD block is common and not an error worth failing on.
    }
  }
  return blocks;
}

/** Reads a meta tag's content, handling either attribute order. */
function metaContent(html: string, attr: string, value: string): string | null {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+${attr}\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*${attr}\\s*=\\s*["']${escaped}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

export interface ExtractDateOptions {
  /** A date supplied by the search/news provider. Ranked lowest: it is a third
   *  party's assertion about the publisher's date, not the publisher's own. */
  providerDate?: string | null;
  /** A date from an RSS <pubDate>. */
  rssDate?: string | null;
}

/** Extracts a publication date from page HTML plus any out-of-band dates. */
export function extractPublicationDate(
  html: string,
  options: ExtractDateOptions = {},
): PublicationDateResult {
  const candidates: DateCandidate[] = [];

  // 1. JSON-LD — the most structured and least ambiguous.
  for (const block of extractJsonLdBlocks(html)) collectJsonLd(block, candidates);

  // 2. Article/OpenGraph publication metadata.
  for (const [attr, name, source] of [
    ['property', 'article:published_time', 'meta_article_published'],
    ['name', 'article:published_time', 'meta_article_published'],
    ['property', 'og:published_time', 'meta_og_published'],
    ['property', 'og:article:published_time', 'meta_og_published'],
    ['name', 'publish-date', 'meta_generic_date'],
    ['name', 'publication_date', 'meta_generic_date'],
    ['name', 'date', 'meta_generic_date'],
    ['name', 'DC.date.issued', 'meta_generic_date'],
    ['itemprop', 'datePublished', 'meta_generic_date'],
  ] as const) {
    const raw = metaContent(html, attr, name);
    if (raw) push(candidates, parseDate(raw), source, raw);
  }

  // 3. <time datetime="..."> — only when marked as publication metadata.
  //    A bare <time> can be an event date inside the article body, which is a
  //    different fact entirely.
  const timeRe = /<time[^>]*datetime\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let tm: RegExpExecArray | null;
  let seen = 0;
  while ((tm = timeRe.exec(html)) !== null && seen < 10) {
    seen += 1;
    const tag = tm[0];
    const isPublication =
      /pubdate|published|datePublished|entry-date|post-date|article__date/i.test(tag);
    if (isPublication) push(candidates, parseDate(tm[1]), 'time_element', tm[1]!);
  }

  // 4. Out-of-band dates, ranked lowest.
  if (options.rssDate) push(candidates, parseDate(options.rssDate), 'rss', options.rssDate);
  if (options.providerDate) {
    push(candidates, parseDate(options.providerDate), 'provider', options.providerDate);
  }

  if (candidates.length === 0) {
    // NULL, not the fetch time. This is the whole point.
    return { publishedAt: null, source: 'none', candidates: [], conflict: false };
  }

  // Order by documented precedence, then by earliest — an article's FIRST
  // publication is the fact we want; a later timestamp is usually a re-render.
  const ordered = [...candidates].sort((a, b) => {
    const rank = PRECEDENCE.indexOf(a.source) - PRECEDENCE.indexOf(b.source);
    if (rank !== 0) return rank;
    return Date.parse(a.iso) - Date.parse(b.iso);
  });

  const chosen = ordered[0]!;

  // Conflict detection across ALL candidates, not just the top two: a page can
  // carry three different dates.
  const times = ordered.map((c) => Date.parse(c.iso));
  const spread = Math.max(...times) - Math.min(...times);
  const conflict = spread > CONFLICT_TOLERANCE_MS;

  return {
    publishedAt: chosen.iso,
    source: chosen.source,
    candidates: ordered,
    conflict,
    conflictNote: conflict
      ? `This page carries ${ordered.length} different publication dates (${ordered
          .map((c) => `${c.iso.slice(0, 10)} from ${c.source}`)
          .join('; ')}). The most authoritative was used.`
      : undefined,
  };
}
