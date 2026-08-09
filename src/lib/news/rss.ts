import type { Article } from './types';
import { isSafeUrl } from '../url';

/** Pulls an image URL out of an RSS <item>.
 *
 *  Every Indian feed in FEEDS below advertises images, and this parser used to
 *  hardcode `imageUrl: null` and discard all of them — so every card fell back
 *  to the placeholder even though the publisher supplied artwork.
 *
 *  Four forms are read, in descending order of how specifically each names the
 *  item's own image:
 *
 *    <media:content url="..."/>    Media RSS. The Hindu, Mint.
 *    <media:thumbnail url="..."/>  Media RSS thumbnail. NDTV.
 *    <enclosure url="..."/>        RSS 2.0. Indian Express.
 *    <image><url>...</url></image> Rare per-item form.
 *
 *  DELIBERATELY NOT a general Media RSS implementation: no <media:group>, no
 *  width/height preference, no srcset. Those exist in the spec but not in these
 *  feeds, and unused parsing is code that can only rot.
 *
 *  <enclosure> is the one form that needs a type check: RSS 2.0 uses it for
 *  podcast audio and PDFs too, so an enclosure is only taken when it declares
 *  an image type, or has no type but an image-like extension. Getting this
 *  wrong would put an MP3 URL into an <img src>.
 *
 *  Every candidate goes through `isSafeUrl`, so a feed cannot inject a
 *  `javascript:` or `data:` URL into an image attribute. Returns null when no
 *  usable image exists — the placeholder path stays intact. */
function attr(block: string, tagName: string, name: string): string | null {
  // Attribute order varies between feeds, so the attribute is matched inside
  // the tag rather than at a fixed position.
  const tagMatch = block.match(new RegExp(`<${tagName}\\b[^>]*>`, 'i'));
  if (!tagMatch) return null;
  const valueMatch = tagMatch[0].match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return valueMatch ? valueMatch[1].trim() : null;
}

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;

export function extractImage(block: string): string | null {
  const candidates: Array<string | null> = [
    attr(block, 'media:content', 'url'),
    attr(block, 'media:thumbnail', 'url'),
  ];

  const enclosure = attr(block, 'enclosure', 'url');
  if (enclosure) {
    const type = attr(block, 'enclosure', 'type');
    // An enclosure without a type is accepted only if the URL looks like an
    // image; with a type, it must actually say image/*.
    const isImage = type ? /^image\//i.test(type) : IMAGE_EXTENSION.test(enclosure);
    if (isImage) candidates.push(enclosure);
  }

  // <image><url>…</url></image>, scoped to the item block by the caller.
  const nested = block.match(/<image\b[^>]*>[\s\S]*?<url>([\s\S]*?)<\/url>[\s\S]*?<\/image>/i);
  if (nested) candidates.push(nested[1].trim());

  for (const candidate of candidates) {
    if (candidate && isSafeUrl(candidate)) return candidate;
  }
  return null;
}

export const FEEDS: Record<string, string> = {
  thehindu: 'https://www.thehindu.com/news/national/feeder/default.rss',
  indianexpress: 'https://indianexpress.com/section/india/feed/',
  ndtv: 'https://feeds.feedburner.com/ndtvnews-india-news',
  mint: 'https://www.livemint.com/rss/news',
};

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function parseRss(xml: string, source: string): Article[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
  return items
    .map((block): Article | null => {
      const title = tag(block, 'title');
      const url = tag(block, 'link');
      if (!title || !url) return null;
      return {
        id: url,
        title,
        url,
        summary: tag(block, 'description').slice(0, 300),
        imageUrl: extractImage(block),
        source,
        category: 'top',
        publishedAt: tag(block, 'pubDate'),
      } satisfies Article;
    })
    .filter((a): a is Article => a !== null);
}

export async function fetchRssFallback(): Promise<Article[]> {
  const settled = await Promise.allSettled(
    Object.entries(FEEDS).map(async ([source, url]) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${source} ${res.status}`);
      return parseRss(await res.text(), source);
    }),
  );
  return settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}
