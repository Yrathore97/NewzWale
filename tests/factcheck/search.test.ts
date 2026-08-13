import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseTavilyResults, search } from '../../src/lib/factcheck/search';

describe('parseTavilyResults', () => {
  it('maps a well-formed Tavily response to hits', () => {
    const raw = {
      query: 'india gdp',
      results: [
        {
          title: 'India GDP grows 7.2% in Q1',
          url: 'https://reuters.com/a',
          content: 'Official data showed the economy expanded 7.2 percent.',
          score: 0.98,
        },
        {
          title: 'Government statement on growth',
          url: 'https://pib.gov.in/b',
          content: 'The ministry confirmed the revised figure.',
          score: 0.91,
        },
      ],
    };

    const out = parseTavilyResults(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      title: 'India GDP grows 7.2% in Q1',
      url: 'https://reuters.com/a',
      snippet: 'Official data showed the economy expanded 7.2 percent.',
      // Tavily supplied no published_date on this result. NULL, never the
      // fetch time — and ranked lowest even when present, since it is a third
      // party's assertion about the publisher's date.
      publishedAt: null,
    });
    expect(out[1].url).toBe('https://pib.gov.in/b');
  });

  it('carries a provider-supplied date through when Tavily gives one', () => {
    const out = parseTavilyResults({
      results: [
        {
          title: 'A',
          url: 'https://a.example/1',
          content: 'text',
          published_date: '2026-08-06T00:00:00Z',
        },
      ],
    });
    expect(out[0]!.publishedAt).toBe('2026-08-06T00:00:00Z');
  });

  it('returns [] for malformed or empty responses', () => {
    expect(parseTavilyResults({ results: [] })).toEqual([]);
    expect(parseTavilyResults({})).toEqual([]);
    expect(parseTavilyResults(null)).toEqual([]);
    expect(parseTavilyResults(undefined)).toEqual([]);
    expect(parseTavilyResults('nonsense')).toEqual([]);
    expect(parseTavilyResults({ results: 'not-an-array' })).toEqual([]);
  });

  it('drops results missing a url or a title', () => {
    const out = parseTavilyResults({
      results: [
        { url: 'https://ok.com/x', title: 'Has no content' },
        { title: 'No url at all' },
        { url: 'https://no-title.com' },
        null,
        'garbage',
      ],
    });
    expect(out).toEqual([{ title: 'Has no content', url: 'https://ok.com/x', snippet: '', publishedAt: null }]);
  });

  it('coerces non-string field values rather than leaking them through', () => {
    const out = parseTavilyResults({ results: [{ url: 'https://n.com/1', title: 42, content: 7 }] });
    expect(out).toEqual([{ title: '42', url: 'https://n.com/1', snippet: '7', publishedAt: null }]);
  });
});

describe('search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the query to Tavily and parses the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'A', url: 'https://a.com', content: 'snippet a' }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await search('test-key', 'is the sky blue');

    expect(out).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'snippet a', publishedAt: null }]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.query).toBe('is the sky blue');
    expect(body.max_results).toBe(5);
  });

  it('sends the key in the Authorization header, never in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) });
    vi.stubGlobal('fetch', fetchMock);

    await search('secret-key', 'q');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('secret-key');
    expect(init.headers.Authorization).toBe('Bearer secret-key');
  });

  it('returns [] without calling out when the key is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(search('', 'q')).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] instead of throwing when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream down')));
    await expect(search('k', 'q')).resolves.toEqual([]);
  });

  it('returns [] instead of throwing on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await expect(search('k', 'q')).resolves.toEqual([]);
  });
});
