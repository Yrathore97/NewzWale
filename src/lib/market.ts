/** Sensex/Nifty quotes from Yahoo Finance.
 *
 *  Extracted from src/pages/api/ticker.ts so /api/v1/ticker (the documented
 *  market ticker, NEWZWALE_ARCHITECTURE.md §4.2 and security finding S-08)
 *  can reuse the exact same fetch rather than a second copy of it.
 *
 *  The legacy /api/ticker.ts route is DELIBERATELY left as its own inline
 *  copy rather than refactored to import this: S-08's own remediation
 *  (cache + rate-limit that route) is out of P5 scope, and importing from
 *  here without also applying the fix would leave the route's actual
 *  problem — no cache, no rate limit — completely unaddressed while
 *  disturbing a file P5 has no documented reason to touch. */

const SYMBOLS = { sensex: '%5EBSESN', nifty: '%5ENSEI' } as const;

// Yahoo answers 429 to requests without a browser-style User-Agent.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export interface Quote {
  price: number;
  changePct: number | null;
}

async function quote(symbol: string): Promise<Quote> {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
    headers: { 'user-agent': UA, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const meta = ((await res.json()) as any)?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) throw new Error('no price');
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  return {
    price: meta.regularMarketPrice,
    changePct: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : null,
  };
}

export async function fetchMarketTicker(): Promise<{ sensex: Quote; nifty: Quote }> {
  const [sensex, nifty] = await Promise.all([quote(SYMBOLS.sensex), quote(SYMBOLS.nifty)]);
  return { sensex, nifty };
}
