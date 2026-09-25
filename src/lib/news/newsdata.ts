import type { Article, NewsPage } from './types';
import { upstreamCategory } from './categories';
import { DEFAULT_LANGUAGE } from './languages';

const ENDPOINT = 'https://newsdata.io/api/1/latest';

/** Tags NewsData attaches broadly. When a story carries one of these AND a
 *  specific tag, the specific one is the honest label: an election result
 *  tagged ['lifestyle', 'politics'] rendered as "Lifestyle". */
const CATCH_ALL = new Set(['top', 'other', 'lifestyle', 'food', 'tourism']);

function pickCategory(tags: unknown): string {
  if (!Array.isArray(tags) || tags.length === 0) return 'top';
  const names = tags.map(String);
  return names.find((t) => !CATCH_ALL.has(t)) ?? names[0] ?? 'top';
}

export function normalizeNewsData(raw: any): Article[] {
  const results = Array.isArray(raw?.results) ? raw.results : [];
  return results
    .filter((r: any) => r?.title && r?.link)
    .map((r: any) => ({
      id: String(r.article_id ?? r.link),
      title: String(r.title),
      url: String(r.link),
      summary: String(r.description ?? ''),
      imageUrl: r.image_url ? String(r.image_url) : null,
      source: String(r.source_id ?? 'unknown'),
      category: pickCategory(r.category),
      publishedAt: String(r.pubDate ?? ''),
    }));
}

/** NewsData paginates with an opaque token. Anything that is not a non-empty
 *  string means "no further page" - never guess a token. */
export function extractNextPage(raw: any): string | null {
  const token = raw?.nextPage;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export interface FetchNewsOptions {
  /** Site category slug (not the upstream name) - mapped internally. */
  category?: string;
  language?: string;
  /** Opaque token from a previous response's nextPage. */
  page?: string;
}

export async function fetchNewsData(
  apiKey: string,
  opts: FetchNewsOptions = {},
): Promise<NewsPage> {
  const params = new URLSearchParams({
    apikey: apiKey,
    country: 'in',
    language: opts.language ?? DEFAULT_LANGUAGE,
  });

  // upstreamCategory returns null for 'top' and for anything unrecognised, so
  // an unvalidated slug can never be forwarded upstream.
  const upstream = upstreamCategory(opts.category);
  if (upstream) params.set('category', upstream);

  if (opts.page) params.set('page', opts.page);

  const res = await fetch(`${ENDPOINT}?${params}`);
  if (!res.ok) throw new Error(`NewsData ${res.status}`);

  const raw = await res.json();
  return { articles: normalizeNewsData(raw), nextPage: extractNextPage(raw) };
}
