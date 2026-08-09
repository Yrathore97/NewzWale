/** Yahoo Finance quote fetch, extracted for /api/v1/ticker (P5). Same
 *  stubbed-fetch approach as tests/news/provider-integration.test.ts. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMarketTicker } from '../src/lib/market';

afterEach(() => vi.unstubAllGlobals());

function yahooResponse(price: number, prevClose: number) {
  return {
    ok: true,
    json: async () => ({
      chart: { result: [{ meta: { regularMarketPrice: price, chartPreviousClose: prevClose } }] },
    }),
  };
}

describe('fetchMarketTicker', () => {
  it('returns price and change percent for both symbols', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes('BSESN')) return yahooResponse(82000, 81000);
        if (url.includes('NSEI')) return yahooResponse(25000, 24750);
        throw new Error('unexpected symbol');
      }),
    );

    const { sensex, nifty } = await fetchMarketTicker();
    expect(sensex.price).toBe(82000);
    expect(sensex.changePct).toBeCloseTo(((82000 - 81000) / 81000) * 100, 5);
    expect(nifty.price).toBe(25000);
  });

  it('sends a browser user-agent, since Yahoo 429s without one', async () => {
    const fetchMock = vi.fn(async () => yahooResponse(100, 100));
    vi.stubGlobal('fetch', fetchMock);

    await fetchMarketTicker();

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['user-agent']).toMatch(/Mozilla/);
  });

  it('throws when Yahoo answers with a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    await expect(fetchMarketTicker()).rejects.toThrow(/yahoo/);
  });

  it('throws when the response has no price', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ chart: { result: [{ meta: {} }] } }) })),
    );
    await expect(fetchMarketTicker()).rejects.toThrow(/no price/);
  });

  it('reports null change when no previous close is available', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 100 } }] } }),
      })),
    );
    const { sensex } = await fetchMarketTicker();
    expect(sensex.changePct).toBeNull();
  });
});
