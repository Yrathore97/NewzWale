import { describe, it, expect, vi } from 'vitest';
import { newsCacheKey, cached } from '../src/lib/cache';

describe('newsCacheKey', () => {
  it('namespaces by category, language, and page', () => {
    expect(newsCacheKey('business', 'en')).toBe('news:v2:business:en:first');
  });

  it('defaults to the top category in English, first page', () => {
    expect(newsCacheKey()).toBe('news:v2:top:en:first');
  });

  it('gives different languages different keys', () => {
    expect(newsCacheKey('top', 'hi')).not.toBe(newsCacheKey('top', 'en'));
  });

  it('gives different pages different keys', () => {
    expect(newsCacheKey('top', 'en', 'tok2')).toBe('news:v2:top:en:tok2');
    expect(newsCacheKey('top', 'en', 'tok2')).not.toBe(newsCacheKey('top', 'en'));
  });
});

function fakeKV(store: Record<string, string> = {}) {
  return {
    get: vi.fn(async (k: string) => store[k] ?? null),
    put: vi.fn(async (k: string, v: string) => { store[k] = v; }),
  } as any;
}

describe('cached', () => {
  it('returns the cached value without calling the producer', async () => {
    const kv = fakeKV({ 'k': JSON.stringify([{ id: '1' }]) });
    const produce = vi.fn();
    const out = await cached(kv, 'k', 60, produce);
    expect(out).toEqual([{ id: '1' }]);
    expect(produce).not.toHaveBeenCalled();
  });

  it('calls the producer and stores the result on a miss', async () => {
    const kv = fakeKV();
    const out = await cached(kv, 'k', 60, async () => [{ id: '2' }]);
    expect(out).toEqual([{ id: '2' }]);
    expect(kv.put).toHaveBeenCalledWith('k', JSON.stringify([{ id: '2' }]), { expirationTtl: 60 });
  });

  it('returns null when the producer throws and nothing is cached', async () => {
    const kv = fakeKV();
    const out = await cached(kv, 'k', 60, async () => { throw new Error('boom'); });
    expect(out).toBeNull();
  });

  it('serves a stale value when the producer throws', async () => {
    const kv = fakeKV({ 'k:stale': JSON.stringify([{ id: 'old' }]) });
    const out = await cached(kv, 'k', 60, async () => { throw new Error('boom'); });
    expect(out).toEqual([{ id: 'old' }]);
  });

  describe('stale-while-revalidate', () => {
    // The 2-3s first load after each 20-minute expiry was the reader waiting
    // on the upstream provider while a perfectly good stale copy sat in KV.
    it('returns stale immediately and refreshes in the background', async () => {
      const store: Record<string, string> = { 'k:stale': JSON.stringify(['old']) };
      const kv = fakeKV(store);
      const background: Promise<unknown>[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const produce = vi.fn(async () => { await gate; return ['new']; });

      const out = await cached(kv, 'k', 60, produce, { waitUntil: (p) => background.push(p) });

      expect(out).toEqual(['old']);          // did not wait on the producer
      expect(background).toHaveLength(1);
      release();
      await Promise.all(background);
      expect(JSON.parse(store['k'])).toEqual(['new']);
      expect(JSON.parse(store['k:stale'])).toEqual(['new']);
    });

    // NewsData's free tier is 200 requests/day, shared with the cron. A burst
    // of readers on an expired key must not each spend one.
    it('does not start a second refresh while one is in flight', async () => {
      const kv = fakeKV({ 'k:stale': JSON.stringify(['old']) });
      const produce = vi.fn(async () => ['new']);
      const bg: Promise<unknown>[] = [];
      const opts = { waitUntil: (p: Promise<unknown>) => bg.push(p) };
      await cached(kv, 'k', 60, produce, opts);
      // Second reader arrives before the first refresh has written 'k'.
      await cached(kv, 'k', 60, async () => ['newer'], opts);
      await Promise.all(bg);
      expect(produce).toHaveBeenCalledTimes(1);
      expect(bg).toHaveLength(1);
    });

    it('a failed background refresh keeps serving stale', async () => {
      const store: Record<string, string> = { 'k:stale': JSON.stringify(['old']) };
      const kv = fakeKV(store);
      const bg: Promise<unknown>[] = [];
      const out = await cached(kv, 'k', 60, async () => { throw new Error('boom'); }, {
        waitUntil: (p) => bg.push(p),
      });
      await Promise.all(bg); // must not reject
      expect(out).toEqual(['old']);
      expect(JSON.parse(store['k:stale'])).toEqual(['old']);
    });

    it('without waitUntil, behaviour is unchanged (waits for fresh)', async () => {
      const kv = fakeKV({ 'k:stale': JSON.stringify(['old']) });
      const out = await cached(kv, 'k', 60, async () => ['new']);
      expect(out).toEqual(['new']);
    });
  });
});
