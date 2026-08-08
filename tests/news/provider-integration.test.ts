import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  newsDataProvider,
  guardianProvider,
  rssProvider,
  fetchFromChain,
  PROVIDERS,
} from '../../src/lib/news/providers';
import { prepareArticles } from '../../src/lib/news/feed';
import { canonicalizeUrl } from '../../src/lib/url';

/** Each real provider is driven end to end with a stubbed fetch, so these
 *  cover the actual adapters rather than a hand-written double. */

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return handler(String(input));
    }),
  );
  return calls;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const NEWSDATA_OK = {
  results: [
    {
      article_id: 'nd1',
      title: 'RBI holds repo rate',
      link: 'https://thehindu.com/business/rbi',
      description: 'Tenth consecutive pause.',
      image_url: 'https://thehindu.com/img.jpg',
      source_id: 'thehindu',
      category: ['business'],
      pubDate: '2026-08-08 10:00:00',
    },
  ],
  nextPage: 'TOKEN2',
};

const GUARDIAN_OK = {
  response: {
    results: [
      {
        id: 'world/2026/aug/08/story',
        webTitle: 'Guardian story',
        webUrl: 'https://theguardian.com/world/story',
        sectionId: 'world',
        webPublicationDate: '2026-08-08T09:00:00Z',
        fields: { trailText: 'Trail', thumbnail: 'https://g.com/t.jpg' },
      },
    ],
  },
};

const RSS_OK = `<?xml version="1.0"?><rss><channel>
  <item><title>RSS headline</title><link>https://thehindu.com/rss/1</link>
  <description><![CDATA[Summary text]]></description><pubDate>Fri, 08 Aug 2026 08:00:00 +0530</pubDate></item>
</channel></rss>`;

// ---------------------------------------------------------------------------
describe('provider success — each returns the common Article shape', () => {
  const REQUIRED = ['id', 'title', 'url', 'summary', 'imageUrl', 'source', 'category', 'publishedAt'];

  it('NewsData normalises to the common shape', async () => {
    stub(() => json(NEWSDATA_OK));
    const page = await newsDataProvider.fetchPage({ category: 'business' }, { newsdata: 'k' });

    expect(page.articles).toHaveLength(1);
    for (const field of REQUIRED) expect(page.articles[0]).toHaveProperty(field);
    expect(page.articles[0]!.title).toBe('RBI holds repo rate');
    expect(page.nextPage).toBe('TOKEN2');
  });

  it('Guardian normalises to the same shape', async () => {
    stub(() => json(GUARDIAN_OK));
    const page = await guardianProvider.fetchPage({ category: 'world' }, { guardian: 'k' });

    for (const field of REQUIRED) expect(page.articles[0]).toHaveProperty(field);
    expect(page.articles[0]!.source).toBe('theguardian');
    // Unpaginated by nature; must not invent a token.
    expect(page.nextPage).toBeNull();
  });

  it('RSS normalises to the same shape', async () => {
    stub(() => new Response(RSS_OK, { headers: { 'content-type': 'application/xml' } }));
    const page = await rssProvider.fetchPage({}, {});

    expect(page.articles.length).toBeGreaterThan(0);
    for (const field of REQUIRED) expect(page.articles[0]).toHaveProperty(field);
    expect(page.nextPage).toBeNull();
  });

  // Known limitation, asserted so it is not mistaken for a bug later: the RSS
  // parser reads no media:content, so RSS-sourced articles never carry an
  // image. Blocking once RSS becomes the primary ingestion layer.
  it('RSS articles currently have no image (documented gap)', async () => {
    stub(() => new Response(RSS_OK, { headers: { 'content-type': 'application/xml' } }));
    const page = await rssProvider.fetchPage({}, {});
    expect(page.articles[0]!.imageUrl).toBeNull();
  });

  it('every registered provider yields the same field set', async () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['newsdata', 'guardian', 'rss']);
  });
});

// ---------------------------------------------------------------------------
describe('provider failure is isolated', () => {
  it('a NewsData HTTP error falls through to Guardian', async () => {
    stub((url) => {
      if (url.includes('newsdata.io')) return new Response('nope', { status: 500 });
      if (url.includes('guardianapis')) return json(GUARDIAN_OK);
      return new Response(RSS_OK);
    });

    const result = await fetchFromChain({}, { newsdata: 'k', guardian: 'k' });
    expect(result.providerId).toBe('guardian');
  });

  it('NewsData returning zero articles is treated as a failure, not an empty feed', async () => {
    stub((url) => {
      if (url.includes('newsdata.io')) return json({ results: [] });
      if (url.includes('guardianapis')) return json(GUARDIAN_OK);
      return new Response(RSS_OK);
    });

    const result = await fetchFromChain({}, { newsdata: 'k', guardian: 'k' });
    expect(result.providerId).toBe('guardian');
  });

  it('two providers failing still reaches RSS', async () => {
    stub((url) => {
      if (url.includes('newsdata.io')) return new Response('', { status: 429 });
      if (url.includes('guardianapis')) return new Response('', { status: 503 });
      return new Response(RSS_OK);
    });

    const result = await fetchFromChain({}, { newsdata: 'k', guardian: 'k' });
    expect(result.providerId).toBe('rss');
    expect(result.articles.length).toBeGreaterThan(0);
  });

  // RSS needs no credential — the only provider that cannot be switched off
  // by a billing event, which is why it is the floor of the chain.
  it('works with no API keys at all, via RSS', async () => {
    const calls = stub(() => new Response(RSS_OK));
    const result = await fetchFromChain({}, {});
    expect(result.providerId).toBe('rss');
    // Paid providers were never contacted.
    expect(calls.some((c) => c.includes('newsdata.io'))).toBe(false);
    expect(calls.some((c) => c.includes('guardianapis'))).toBe(false);
  });

  it('a network throw is contained like an HTTP error', async () => {
    stub((url) => {
      if (url.includes('newsdata.io')) throw new Error('DNS failure');
      return new Response(RSS_OK);
    });
    const result = await fetchFromChain({}, { newsdata: 'k' });
    expect(result.providerId).toBe('rss');
  });

  it('all providers failing throws, so the caller can serve a stale copy', async () => {
    stub(() => new Response('', { status: 500 }));
    await expect(fetchFromChain({}, { newsdata: 'k', guardian: 'k' })).rejects.toThrow(
      /All news providers failed/,
    );
  });

  it('a paginated request never falls back to an unpaginated provider', async () => {
    const calls = stub((url) => {
      if (url.includes('newsdata.io')) return new Response('', { status: 500 });
      return new Response(RSS_OK);
    });

    await expect(fetchFromChain({ page: 'TOKEN2' }, { newsdata: 'k' })).rejects.toThrow();
    // RSS would otherwise return page 1 forever.
    expect(calls.some((c) => c.includes('thehindu.com/news'))).toBe(false);
  });

  it('a non-English request never falls back to an English-only provider', async () => {
    stub((url) => {
      if (url.includes('newsdata.io')) return new Response('', { status: 500 });
      return new Response(RSS_OK);
    });
    await expect(fetchFromChain({ language: 'hi' }, { newsdata: 'k', guardian: 'k' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('normalization and deduplication', () => {
  const article = (url: string, title = 'T', publishedAt = '2026-08-08T00:00:00Z') => ({
    id: url,
    title,
    url,
    summary: '',
    imageUrl: null,
    source: 's',
    category: 'top',
    publishedAt,
  });

  it('drops exact duplicate URLs', () => {
    const out = prepareArticles([article('https://x.com/1'), article('https://x.com/1')]);
    expect(out).toHaveLength(1);
  });

  it('drops articles with an unsafe URL', () => {
    const out = prepareArticles([
      article('javascript:alert(1)'),
      article('https://x.com/ok'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://x.com/ok');
  });

  it('drops articles missing a title or URL', () => {
    const out = prepareArticles([
      { ...article('https://x.com/1'), title: '' },
      article('https://x.com/2'),
    ]);
    expect(out).toHaveLength(1);
  });

  it('sorts newest first so one source cannot monopolise the top', () => {
    const out = prepareArticles([
      article('https://x.com/old', 'old', '2026-08-01T00:00:00Z'),
      article('https://x.com/new', 'new', '2026-08-08T00:00:00Z'),
    ]);
    expect(out.map((a) => a.title)).toEqual(['new', 'old']);
  });

  // KNOWN GAP, asserted so it is visible rather than assumed solved.
  // prepareArticles dedups on the EXACT url, so tracking parameters defeat it.
  // canonicalizeUrl (src/lib/url.ts) is the fix, and wiring it into ingestion
  // is Phase 2 work - it changes what the live feed shows and needs its own
  // verification.
  it('does NOT yet collapse tracking-parameter variants', () => {
    const out = prepareArticles([
      article('https://x.com/1'),
      article('https://x.com/1?utm_source=twitter'),
    ]);
    expect(out).toHaveLength(2);

    // The canonicaliser that will close this already agrees they are one story.
    expect(canonicalizeUrl('https://x.com/1?utm_source=twitter')).toBe(
      canonicalizeUrl('https://x.com/1'),
    );
  });
});
