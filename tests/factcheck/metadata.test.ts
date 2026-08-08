import { describe, it, expect } from 'vitest';
import {
  parseDate,
  extractPublicationDate,
  extractJsonLdBlocks,
} from '../../src/lib/factcheck/metadata';

const page = (head: string) => `<!doctype html><html><head>${head}</head><body><p>Story.</p></body></html>`;

describe('parseDate', () => {
  it('accepts ISO-8601 and normalises to UTC', () => {
    expect(parseDate('2026-08-06T10:30:00Z')).toBe('2026-08-06T10:30:00.000Z');
    expect(parseDate('2026-08-06')).toBe('2026-08-06T00:00:00.000Z');
  });

  it('accepts RFC 2822, the RSS format', () => {
    expect(parseDate('Fri, 08 Aug 2026 08:00:00 +0530')).toBe('2026-08-08T02:30:00.000Z');
  });

  it('converts a non-UTC offset correctly', () => {
    expect(parseDate('2026-08-06T10:30:00+05:30')).toBe('2026-08-06T05:00:00.000Z');
  });

  it('returns null for malformed input', () => {
    for (const bad of ['', '   ', 'not a date', 'yesterday', 'Q3', null, undefined, 42]) {
      expect(parseDate(bad as never), String(bad)).toBeNull();
    }
  });

  // A bare year is not a publication date — it is a year.
  it('refuses a bare year', () => {
    expect(parseDate('2026')).toBeNull();
  });

  // 03/04/2026 is March 4th or April 3rd depending on locale. A coin-flip is
  // not extraction.
  it('refuses ambiguous numeric day/month ordering', () => {
    expect(parseDate('03/04/2026')).toBeNull();
    expect(parseDate('3.4.2026')).toBeNull();
  });

  it('refuses dates outside a sane window', () => {
    expect(parseDate('1970-01-01T00:00:00Z')).toBeNull();
    expect(parseDate('2199-01-01')).toBeNull();
  });
});

describe('extractJsonLdBlocks', () => {
  it('parses a well-formed block', () => {
    const html = page(
      '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-08-06"}</script>',
    );
    expect(extractJsonLdBlocks(html)).toHaveLength(1);
  });

  it('survives a malformed block without throwing', () => {
    const html = page('<script type="application/ld+json">{oh no</script>');
    expect(extractJsonLdBlocks(html)).toEqual([]);
  });

  it('collects several blocks', () => {
    const html = page(
      '<script type="application/ld+json">{"a":1}</script><script type="application/ld+json">{"b":2}</script>',
    );
    expect(extractJsonLdBlocks(html)).toHaveLength(2);
  });
});

describe('extractPublicationDate — sources in precedence order', () => {
  it('reads JSON-LD datePublished', () => {
    const r = extractPublicationDate(
      page('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-08-06T09:00:00Z"}</script>'),
    );
    expect(r.publishedAt).toBe('2026-08-06T09:00:00.000Z');
    expect(r.source).toBe('json_ld');
  });

  it('walks nested JSON-LD graphs', () => {
    const r = extractPublicationDate(
      page(
        '<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"NewsArticle","datePublished":"2026-08-06"}]}</script>',
      ),
    );
    expect(r.publishedAt).toBe('2026-08-06T00:00:00.000Z');
  });

  it('reads article:published_time', () => {
    const r = extractPublicationDate(
      page('<meta property="article:published_time" content="2026-08-06T09:00:00Z">'),
    );
    expect(r.source).toBe('meta_article_published');
  });

  it('handles reversed meta attribute order', () => {
    const r = extractPublicationDate(
      page('<meta content="2026-08-06T09:00:00Z" property="article:published_time">'),
    );
    expect(r.publishedAt).toBe('2026-08-06T09:00:00.000Z');
  });

  it('reads a time element only when marked as publication metadata', () => {
    const marked = extractPublicationDate(
      page('') + '<time class="published" datetime="2026-08-06">Aug 6</time>',
    );
    expect(marked.source).toBe('time_element');

    // A bare <time> can be an event date inside the article body — a
    // different fact entirely.
    const bare = extractPublicationDate(
      page('') + '<time datetime="2026-08-06">the summit on Aug 6</time>',
    );
    expect(bare.publishedAt).toBeNull();
  });

  it('accepts an RSS pubDate as a lower-precedence source', () => {
    const r = extractPublicationDate(page(''), { rssDate: 'Fri, 08 Aug 2026 08:00:00 +0530' });
    expect(r.source).toBe('rss');
    expect(r.publishedAt).toBe('2026-08-08T02:30:00.000Z');
  });

  it('accepts a provider date as the lowest-precedence source', () => {
    const r = extractPublicationDate(page(''), { providerDate: '2026-08-06' });
    expect(r.source).toBe('provider');
  });

  // The publisher's own markup outranks a third party's assertion about it.
  it('prefers JSON-LD over meta, and both over provider', () => {
    const html = page(
      '<script type="application/ld+json">{"datePublished":"2026-08-01"}</script>' +
        '<meta property="article:published_time" content="2026-08-02">',
    );
    const r = extractPublicationDate(html, { providerDate: '2026-08-03' });
    expect(r.source).toBe('json_ld');
    expect(r.publishedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('does not treat dateModified as a publication date', () => {
    const r = extractPublicationDate(
      page('<script type="application/ld+json">{"dateModified":"2026-08-06"}</script>'),
    );
    // An article edited today was not published today; treating it as such
    // would make stale evidence look current.
    expect(r.publishedAt).toBeNull();
  });
});

// ── THE GOVERNING RULE ────────────────────────────────────────────────────
describe('extractPublicationDate — a date is extracted or it is NULL', () => {
  it('returns null when the page carries no date', () => {
    const r = extractPublicationDate(page('<title>Story</title>'));
    expect(r.publishedAt).toBeNull();
    expect(r.source).toBe('none');
    expect(r.candidates).toEqual([]);
  });

  it('returns null when every date present is malformed', () => {
    const r = extractPublicationDate(
      page('<meta property="article:published_time" content="not a date">'),
    );
    expect(r.publishedAt).toBeNull();
  });

  // The specific forbidden inferences.
  it('never infers a date from the URL path', () => {
    const r = extractPublicationDate(page('<link rel="canonical" href="https://x.example/2024/03/story">'));
    expect(r.publishedAt).toBeNull();
  });

  it('never infers a date from body text', () => {
    const r = extractPublicationDate(
      '<html><body><p>On 6 August 2026 the board met.</p></body></html>',
    );
    expect(r.publishedAt).toBeNull();
  });

  // The one failure mode that would look like success: silently substituting
  // the fetch time, so every undated source appears freshly published.
  it('never falls back to the current time', () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    const r = extractPublicationDate(page(''));

    expect(r.publishedAt).toBeNull();
    // Stated as a string comparison so the intent survives a refactor that
    // makes publishedAt non-null.
    expect(String(r.publishedAt)).not.toContain(todayIso);
  });

  it('stays null even when an accessed timestamp is available to the caller', () => {
    // extractPublicationDate is deliberately not given accessedAt at all —
    // it has no way to substitute it even by mistake.
    const r = extractPublicationDate(page(''), { providerDate: null, rssDate: null });
    expect(r.publishedAt).toBeNull();
  });
});

describe('extractPublicationDate — conflicts are surfaced, not resolved silently', () => {
  it('flags a conflict when sources disagree by more than a day', () => {
    const html = page(
      '<script type="application/ld+json">{"datePublished":"2026-08-01"}</script>',
    );
    const r = extractPublicationDate(html, { providerDate: '2026-06-15' });

    expect(r.conflict).toBe(true);
    expect(r.candidates.length).toBeGreaterThan(1);
    expect(r.conflictNote).toMatch(/different publication dates/i);
  });

  it('still chooses deterministically when there is a conflict', () => {
    const html = page('<script type="application/ld+json">{"datePublished":"2026-08-01"}</script>');
    const a = extractPublicationDate(html, { providerDate: '2026-06-15' });
    const b = extractPublicationDate(html, { providerDate: '2026-06-15' });
    expect(a.publishedAt).toBe(b.publishedAt);
    expect(a.publishedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('does not flag a conflict for the same moment in different timezones', () => {
    const html = page(
      '<script type="application/ld+json">{"datePublished":"2026-08-06T10:30:00+05:30"}</script>' +
        '<meta property="article:published_time" content="2026-08-06T05:00:00Z">',
    );
    const r = extractPublicationDate(html);
    expect(r.conflict).toBe(false);
  });

  it('records every distinct candidate for auditability', () => {
    const html = page(
      '<script type="application/ld+json">{"datePublished":"2026-08-01"}</script>' +
        '<meta property="article:published_time" content="2026-08-02">',
    );
    const r = extractPublicationDate(html, { providerDate: '2026-08-03' });
    expect(r.candidates.map((c) => c.source)).toEqual([
      'json_ld',
      'meta_article_published',
      'provider',
    ]);
    expect(r.candidates.every((c) => c.raw.length > 0)).toBe(true);
  });
});
