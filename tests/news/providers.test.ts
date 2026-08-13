import { describe, it, expect, vi } from 'vitest';
import {
  resolveChain,
  fetchFromChain,
  PROVIDERS,
  type NewsProvider,
} from '../../src/lib/news/providers';
import type { NewsPage } from '../../src/lib/news/types';

function stub(
  id: string,
  opts: Partial<Pick<NewsProvider, 'paginated' | 'multilingual'>> & {
    configured?: boolean;
    result?: NewsPage | Error;
  } = {},
): NewsProvider {
  const { paginated = true, multilingual = true, configured = true, result } = opts;
  return {
    id,
    paginated,
    multilingual,
    isConfigured: () => configured,
    fetchPage: async () => {
      if (result instanceof Error) throw result;
      return result ?? { articles: [{ id: id, title: id } as any], nextPage: null };
    },
  };
}

describe('PROVIDERS registration', () => {
  // The order IS the current fallback behaviour in /api/news. Changing it is a
  // product decision (RSS becoming first-class), not an implementation detail.
  it('preserves the shipped fallback order', () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(['newsdata', 'guardian', 'rss']);
  });

  it('marks only newsdata as paginated and multilingual', () => {
    const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
    expect(byId.newsdata.paginated).toBe(true);
    expect(byId.newsdata.multilingual).toBe(true);
    expect(byId.guardian.paginated).toBe(false);
    expect(byId.rss.paginated).toBe(false);
  });

  // RSS needs no credential. It is the only provider that cannot be switched
  // off by a billing event, which is why it can become the foundation later.
  it('treats rss as always configured and the paid providers as key-gated', () => {
    const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
    expect(byId.rss.isConfigured({})).toBe(true);
    expect(byId.newsdata.isConfigured({})).toBe(false);
    expect(byId.guardian.isConfigured({})).toBe(false);
    expect(byId.newsdata.isConfigured({ newsdata: 'k' })).toBe(true);
  });
});

describe('resolveChain', () => {
  const all = [stub('a'), stub('b', { paginated: false }), stub('c', { multilingual: false })];

  it('returns every eligible provider in order', () => {
    expect(resolveChain({}, {}, 'en', all).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('skips unconfigured providers without calling them', () => {
    const chain = resolveChain({}, {}, 'en', [stub('x', { configured: false }), stub('y')]);
    expect(chain.map((p) => p.id)).toEqual(['y']);
  });

  // Paging into an unpaginated source returns the same articles forever.
  it('excludes unpaginated providers once a page token is present', () => {
    expect(resolveChain({ page: 'tok' }, {}, 'en', all).map((p) => p.id)).toEqual(['a', 'c']);
  });

  // Serving English headlines to a Hindi reader is worse than serving none.
  it('excludes English-only providers for a non-default language', () => {
    expect(resolveChain({ language: 'hi' }, {}, 'en', all).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('does not exclude anything for the default language', () => {
    expect(resolveChain({ language: 'en' }, {}, 'en', all)).toHaveLength(3);
  });

  it('can resolve to an empty chain', () => {
    const chain = resolveChain({ page: 'tok', language: 'hi' }, {}, 'en', [
      stub('b', { paginated: false }),
    ]);
    expect(chain).toEqual([]);
  });
});

describe('fetchFromChain', () => {
  it('returns the first successful provider and records which one answered', async () => {
    const result = await fetchFromChain({}, {}, 'en', [stub('first'), stub('second')]);
    expect(result.providerId).toBe('first');
  });

  // Provider failure must not break the feed.
  it('falls through a failing provider to the next', async () => {
    const result = await fetchFromChain({}, {}, 'en', [
      stub('broken', { result: new Error('502') }),
      stub('working'),
    ]);
    expect(result.providerId).toBe('working');
  });

  it('falls through several failures', async () => {
    const result = await fetchFromChain({}, {}, 'en', [
      stub('a', { result: new Error('down') }),
      stub('b', { result: new Error('empty') }),
      stub('c'),
    ]);
    expect(result.providerId).toBe('c');
  });

  // Throwing (rather than returning []) is load-bearing: it lets cached()
  // serve its stale copy instead of caching an empty feed for the full TTL.
  it('throws when every provider fails, so the caller can serve stale', async () => {
    await expect(
      fetchFromChain({}, {}, 'en', [
        stub('a', { result: new Error('down') }),
        stub('b', { result: new Error('down') }),
      ]),
    ).rejects.toThrow(/All news providers failed/);
  });

  it('throws a distinct error when no provider is even eligible', async () => {
    await expect(
      fetchFromChain({ page: 'tok' }, {}, 'en', [stub('b', { paginated: false })]),
    ).rejects.toThrow(/No news provider is eligible/);
  });

  it('names the failures so a degraded feed is diagnosable', async () => {
    await expect(
      fetchFromChain({}, {}, 'en', [stub('newsdata', { result: new Error('429 quota') })]),
    ).rejects.toThrow(/newsdata: 429 quota/);
  });

  it('does not call providers after one succeeds', async () => {
    const later = stub('later');
    const spy = vi.spyOn(later, 'fetchPage');
    await fetchFromChain({}, {}, 'en', [stub('first'), later]);
    expect(spy).not.toHaveBeenCalled();
  });
});
