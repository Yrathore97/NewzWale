import type { Article } from './types';
import { isSafeUrl } from '../url';

/** Feed URLs are rendered straight into href, so only http(s) links are kept.
 *
 *  Re-exported from ../url.ts rather than reimplemented. This module used to
 *  own a second copy of the scheme check, which is how a security rule ends up
 *  fixed in one place and stale in another - the fact-check evidence list had
 *  no check at all while this one did. One implementation, several importers. */
export { isSafeUrl } from '../url';

/** Unparseable dates sort last rather than throwing. */
function time(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/** Filter to renderable articles, drop duplicates, sort newest first so a
 *  single source cannot monopolise the top of the feed, then optionally cap.
 *  Deduplication matters once several categories are merged on the homepage:
 *  the same story often appears in more than one category feed. */
export function prepareArticles(articles: Article[], limit?: number): Article[] {
  if (!Array.isArray(articles)) return [];

  const seen = new Set<string>();
  const out = articles
    .filter((a) => a?.url && a?.title && isSafeUrl(a.url))
    .filter((a) => {
      if (seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    })
    .sort((a, b) => time(b.publishedAt) - time(a.publishedAt));

  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

export function formatPublished(value: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return '';
  // floor, not round: elapsed time should never be reported as MORE than it
  // is. Math.round called a 90-second-old article "2m ago" and a 30-second-old
  // one "1m ago" instead of "just now".
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(t).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' });
}
