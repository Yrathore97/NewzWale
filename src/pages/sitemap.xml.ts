import type { APIRoute } from 'astro';
import { CATEGORIES } from '../lib/news/categories';

/** Generated sitemap, replacing the hand-maintained public/sitemap.xml.
 *
 *  P5 (NEWZWALE_IMPLEMENTATION_PLAN.md): "public/sitemap.xml → generated,
 *  not hand-maintained." No dependency is added for this — the route set is
 *  static and small enough that a plain XML template is the smaller,
 *  architecture-consistent choice; @astrojs/sitemap would add a build-time
 *  dependency to solve a problem eleven `<url>` entries don't have.
 *
 *  NO FAKE LASTMOD. The old file hand-wrote `2026-08-07` on every entry,
 *  static pages included — a value nobody was updating, which is worse than
 *  absent per the audit's own finding. `<lastmod>` is simply omitted: the
 *  sitemap spec makes it optional, and an absent date cannot mislead a
 *  crawler the way a stale one can.
 *
 *  `/verify` IS REMOVED. D8: it 301s now, and a sitemap should not point
 *  crawlers at a redirect when the destination is known.
 *
 *  NOT INCLUDED: per-article `/news/[slug]` or per-check `/fact-check/[id]`
 *  entries. Nothing in the P5 documentation specifies a dynamic sitemap
 *  covering persisted content, and inventing one — with what update
 *  frequency, capped at how many entries — is exactly the kind of
 *  undocumented requirement this pass must not invent. Static and
 *  category routes only, matching what the hand-maintained file already
 *  covered. */
const SITE = 'https://www.newzwale.com';

interface SitemapEntry {
  path: string;
  changefreq: 'always' | 'monthly' | 'yearly';
  priority: string;
}

const STATIC_ENTRIES: SitemapEntry[] = [
  { path: '/', changefreq: 'always', priority: '1.0' },
  { path: '/news', changefreq: 'always', priority: '0.8' },
  { path: '/trending', changefreq: 'always', priority: '0.7' },
  { path: '/search', changefreq: 'monthly', priority: '0.5' },
  { path: '/fact-check', changefreq: 'always', priority: '0.9' },
  { path: '/methodology', changefreq: 'monthly', priority: '0.5' },
  { path: '/about', changefreq: 'monthly', priority: '0.5' },
  { path: '/contact', changefreq: 'monthly', priority: '0.5' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
];

function entries(): SitemapEntry[] {
  const categoryEntries: SitemapEntry[] = CATEGORIES.map((c) => ({
    path: `/category/${c.slug}`,
    changefreq: 'always',
    priority: c.slug === 'top' ? '0.8' : '0.7',
  }));
  return [...STATIC_ENTRIES, ...categoryEntries];
}

function toXml(list: SitemapEntry[]): string {
  const urls = list
    .map(
      (e) => `  <url>
    <loc>${SITE}${e.path}</loc>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const prerender = true;

export const GET: APIRoute = () =>
  new Response(toXml(entries()), {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
