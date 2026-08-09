import { describe, it, expect } from 'vitest';
import {
  slugify,
  articleSlug,
  sourceDomain,
  sourceId,
  articleId,
  canonicalIdentity,
} from '../../src/lib/news/canonical';
import { canonicalizeUrl } from '../../src/lib/url';

describe('canonical URL normalization', () => {
  // Each rule that collapses two URLs into one article, asserted separately —
  // these are the rules that decide whether the feed shows a story once or
  // four times.
  const same: Array<[string, string, string]> = [
    ['utm parameters', 'https://x.com/a?utm_source=twitter&utm_medium=social', 'https://x.com/a'],
    ['fbclid', 'https://x.com/a?fbclid=abc123', 'https://x.com/a'],
    ['gclid', 'https://x.com/a?gclid=abc123', 'https://x.com/a'],
    ['fragment', 'https://x.com/a#section-2', 'https://x.com/a'],
    ['trailing slash', 'https://x.com/a/', 'https://x.com/a'],
    ['www prefix', 'https://www.x.com/a', 'https://x.com/a'],
    ['host case', 'https://X.COM/a', 'https://x.com/a'],
    ['default https port', 'https://x.com:443/a', 'https://x.com/a'],
    ['query order', 'https://x.com/a?b=2&a=1', 'https://x.com/a?a=1&b=2'],
  ];

  for (const [rule, variant, canonical] of same) {
    it(`collapses ${rule}`, () => {
      expect(canonicalizeUrl(variant)).toBe(canonicalizeUrl(canonical));
    });
  }

  // The other half of the contract. Over-normalising merges genuinely
  // different articles, which is worse than showing one twice.
  const different: Array<[string, string, string]> = [
    ['different paths', 'https://x.com/a', 'https://x.com/b'],
    ['different hosts', 'https://x.com/a', 'https://y.com/a'],
    ['meaningful query param', 'https://x.com/a?id=1', 'https://x.com/a?id=2'],
    ['path case', 'https://x.com/A', 'https://x.com/a'],
    ['subdomain', 'https://sports.x.com/a', 'https://x.com/a'],
  ];

  for (const [rule, left, right] of different) {
    it(`keeps ${rule} distinct`, () => {
      expect(canonicalizeUrl(left)).not.toBe(canonicalizeUrl(right));
    });
  }

  it('refuses unsafe schemes rather than storing them', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('data:text/html,x')).toBeNull();
    expect(canonicalizeUrl('not a url')).toBeNull();
  });
});

describe('sourceDomain', () => {
  it('strips www and lowercases', () => {
    expect(sourceDomain('https://WWW.TheHindu.com/a')).toBe('thehindu.com');
  });

  it('keeps a subdomain, since it is a different publication', () => {
    expect(sourceDomain('https://timesofindia.indiatimes.com/a')).toBe(
      'timesofindia.indiatimes.com',
    );
  });

  it('returns null for an unusable URL', () => {
    expect(sourceDomain('nonsense')).toBeNull();
    expect(sourceDomain('ftp://x.com/a')).toBeNull();
  });
});

describe('identity is deterministic', () => {
  it('gives the same article id for tracking-param variants', async () => {
    const a = await articleId(canonicalizeUrl('https://x.com/a?utm_source=x')!);
    const b = await articleId(canonicalizeUrl('https://x.com/a')!);
    expect(a).toBe(b);
  });

  // One publisher reaching us through RSS and NewsData must be ONE source row,
  // or "how many independent sources" is inflated by an ingestion detail.
  it('gives one source id per domain regardless of provider', async () => {
    expect(await sourceId('thehindu.com')).toBe(await sourceId('thehindu.com'));
    expect(await sourceId('thehindu.com')).not.toBe(await sourceId('ndtv.com'));
  });
});

describe('slugify', () => {
  it('makes a readable slug', () => {
    expect(slugify('Government announces new policy')).toBe('government-announces-new-policy');
  });

  it('collapses punctuation and repeated separators', () => {
    expect(slugify('Budget 2026: what changed -- and why!')).toBe(
      'budget-2026-what-changed-and-why',
    );
  });

  // A strict [a-z0-9] filter would empty every Devanagari headline, and every
  // Hindi article would then collide on one slug.
  it('preserves non-Latin scripts instead of emptying them', () => {
    expect(slugify('मानसून की बारिश')).toBe('मानसून-की-बारिश');
    expect(slugify('கனமழை தொடங்கியது')).toBe('கனமழை-தொடங்கியது');
  });

  it('truncates without ending mid-word or on a separator', () => {
    const slug = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40) + ' tail');
    expect(slug.length).toBeLessThanOrEqual(72);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns empty for a title with no usable characters', () => {
    expect(slugify('!!! ---')).toBe('');
  });
});

describe('articleSlug', () => {
  it('is stable for the same article', () => {
    expect(articleSlug('Same headline', 'abcdef1234')).toBe(
      articleSlug('Same headline', 'abcdef1234'),
    );
  });

  // Wire copy runs under one headline at several outlets; slug is UNIQUE.
  it('disambiguates identical headlines by article id', () => {
    expect(articleSlug('Shared headline', 'aaaaaaaa11')).not.toBe(
      articleSlug('Shared headline', 'bbbbbbbb22'),
    );
  });

  it('falls back to the id when the title yields no slug', () => {
    expect(articleSlug('!!!', 'abcdef1234')).toBe('abcdef12');
  });
});

describe('canonicalIdentity', () => {
  it('resolves a usable article', async () => {
    const id = await canonicalIdentity('https://www.thehindu.com/news/x/?utm_source=t', 'A story');
    expect(id).not.toBeNull();
    expect(id!.canonicalUrl).toBe('https://thehindu.com/news/x');
    expect(id!.domain).toBe('thehindu.com');
    expect(id!.slug.startsWith('a-story-')).toBe(true);
  });

  it('returns null for an unsafe URL rather than a placeholder row', async () => {
    expect(await canonicalIdentity('javascript:alert(1)', 'A story')).toBeNull();
  });
});
