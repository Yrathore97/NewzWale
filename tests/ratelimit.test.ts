import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  checkRateLimit,
  checkRateLimitSafe,
  requestIdentity,
  bucketId,
  LOCAL_DEV_IDENTITY,
  type RateLimiterNamespace,
} from '../src/lib/ratelimit';
import { RateLimiter } from '../src/lib/durable/rate-limiter';

/** In-memory stand-in for DurableObjectState.
 *
 *  blockConcurrencyWhile is modelled as a real serialising queue rather than a
 *  pass-through. That matters: the whole reason the limiter moved off KV is
 *  that read-modify-write must not interleave, and a fake that runs callbacks
 *  concurrently would let a broken implementation pass. */
function fakeState() {
  const store = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  let alarmAt: number | null = null;

  return {
    storage: {
      get: async <T>(k: string) => store.get(k) as T | undefined,
      put: async (k: string, v: unknown) => void store.set(k, v),
      deleteAll: async () => store.clear(),
      setAlarm: async (t: number) => void (alarmAt = t),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>): Promise<T> => {
      const next = chain.then(fn);
      // Keep the queue alive even if one callback rejects.
      chain = next.catch(() => undefined);
      return next;
    },
    _store: store,
    get _alarmAt() {
      return alarmAt;
    },
  };
}

function limiterInstance() {
  const state = fakeState();
  const obj = new RateLimiter(state as unknown as DurableObjectState);
  return { obj, state };
}

async function check(obj: RateLimiter, limit = 5, windowSeconds = 3600) {
  const res = await obj.fetch(
    new Request('https://rate-limiter/check', {
      method: 'POST',
      body: JSON.stringify({ limit, windowSeconds }),
    }),
  );
  return (await res.json()) as {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
    limit: number;
  };
}

// ---------------------------------------------------------------------------
// Behaviour carried over from the previous KV-backed implementation. The
// storage primitive changed; these guarantees did not, and must not regress.
// ---------------------------------------------------------------------------
describe('RateLimiter — core limiting behaviour', () => {
  it('allows the first request', async () => {
    const { obj } = limiterInstance();
    expect((await check(obj, 5)).allowed).toBe(true);
  });

  it('allows while under the limit', async () => {
    const { obj } = limiterInstance();
    for (let i = 0; i < 4; i += 1) expect((await check(obj, 5)).allowed).toBe(true);
  });

  it('blocks once the limit is reached', async () => {
    const { obj } = limiterInstance();
    for (let i = 0; i < 5; i += 1) await check(obj, 5);
    expect((await check(obj, 5)).allowed).toBe(false);
  });

  it('reports remaining quota accurately', async () => {
    const { obj } = limiterInstance();
    expect((await check(obj, 3)).remaining).toBe(2);
    expect((await check(obj, 3)).remaining).toBe(1);
    expect((await check(obj, 3)).remaining).toBe(0);
  });

  it('supplies a positive Retry-After once blocked', async () => {
    const { obj } = limiterInstance();
    await check(obj, 1);
    const blocked = await check(obj, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Counting correctness under overlapping requests.
//
// WHAT THIS DOES AND DOES NOT PROVE — stated honestly, because the difference
// matters for how much confidence to place in it.
//
// PROVES: the count/limit/window arithmetic never over-admits, and the object
// does not leak quota when many requests overlap.
//
// DOES NOT PROVE: that blockConcurrencyWhile is what provides atomicity. This
// was checked rather than assumed - re-running these cases against a fake
// whose blockConcurrencyWhile does NOT serialise still admitted exactly 5,
// because JavaScript is single-threaded and the fake's await points serialise
// on their own. A unit test in this environment cannot distinguish the two.
//
// The real atomicity guarantee is architectural, not testable here: a Durable
// Object is single-threaded with one instance per id, so the read-modify-write
// cannot interleave. That is the property KV lacked (eventually consistent,
// no atomic increment, one counter per colo), and it is why the primitive
// changed. Verifying it end-to-end needs a deployed load test, recorded as
// outstanding in the Phase 1 report.
// ---------------------------------------------------------------------------
describe('RateLimiter — counting under overlapping requests', () => {
  it('admits exactly `limit` requests when 20 arrive together', async () => {
    const { obj } = limiterInstance();

    const results = await Promise.all(Array.from({ length: 20 }, () => check(obj, 5)));

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(15);
  });

  it('does not keep incrementing after the limit is hit', async () => {
    const { obj, state } = limiterInstance();
    for (let i = 0; i < 10; i += 1) await check(obj, 3);
    expect((state._store.get('w') as { count: number }).count).toBe(3);
  });
});

describe('RateLimiter — windowing', () => {
  afterEach(() => vi.useRealTimers());

  it('starts a fresh window after the old one expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'));

    const { obj } = limiterInstance();
    for (let i = 0; i < 3; i += 1) await check(obj, 3, 60);
    expect((await check(obj, 3, 60)).allowed).toBe(false);

    vi.setSystemTime(new Date('2026-08-08T00:01:01Z'));
    expect((await check(obj, 3, 60)).allowed).toBe(true);
  });

  it('does not reset early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T00:00:00Z'));

    const { obj } = limiterInstance();
    for (let i = 0; i < 3; i += 1) await check(obj, 3, 60);

    vi.setSystemTime(new Date('2026-08-08T00:00:59Z'));
    expect((await check(obj, 3, 60)).allowed).toBe(false);
  });

  it('schedules an alarm so idle buckets free their storage', async () => {
    const { obj, state } = limiterInstance();
    await check(obj, 5, 60);
    expect(state._alarmAt).toBeGreaterThan(0);
  });

  it('clears storage when the alarm fires', async () => {
    const { obj, state } = limiterInstance();
    await check(obj, 5);
    expect(state._store.size).toBe(1);
    await obj.alarm();
    expect(state._store.size).toBe(0);
  });
});

describe('RateLimiter — malformed input', () => {
  it('rejects a non-JSON body without throwing', async () => {
    const { obj } = limiterInstance();
    const res = await obj.fetch(
      new Request('https://rate-limiter/check', { method: 'POST', body: 'not json' }),
    );
    expect(res.status).toBe(400);
  });

  it('clamps a nonsensical limit rather than admitting everything', async () => {
    const { obj } = limiterInstance();
    const res = await obj.fetch(
      new Request('https://rate-limiter/check', {
        method: 'POST',
        body: JSON.stringify({ limit: -1, windowSeconds: 0 }),
      }),
    );
    const decision = (await res.json()) as { allowed: boolean; limit: number };
    expect(decision.limit).toBe(1);
    expect(decision.allowed).toBe(true);
  });
});

describe('requestIdentity', () => {
  const req = (headers: Record<string, string>) => new Request('https://x/', { headers });

  it('uses cf-connecting-ip for IPv4', () => {
    expect(requestIdentity(req({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  // Previously `?? 'unknown'`, which pooled every header-less caller into one
  // shared bucket they could exhaust for each other. Now refused - but ONLY
  // when the request actually came through Cloudflare, which cf-ray proves.
  it('returns null when proxied by Cloudflare but the client IP is missing', () => {
    expect(requestIdentity(req({ 'cf-ray': '8a1b2c3d4e5f' }))).toBeNull();
  });

  // Regression: the first version returned null here too, which 400'd every
  // fact check in local development. No cf-ray means the request never
  // traversed Cloudflare, so this is dev, not an anomaly.
  it('falls back to a fixed dev identity when not behind Cloudflare at all', () => {
    expect(requestIdentity(req({}))).toBe(LOCAL_DEV_IDENTITY);
  });

  // A residential IPv6 allocation is routinely a /64, so per-address limiting
  // hands one household unlimited quota by rotating the low bits.
  it('buckets IPv6 on the /64 prefix', () => {
    const a = requestIdentity(req({ 'cf-connecting-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }));
    const b = requestIdentity(req({ 'cf-connecting-ip': '2001:db8:1:2:1111:2222:3333:4444' }));
    expect(a).toBe(b);
  });

  it('keeps different IPv6 /64s in different buckets', () => {
    const a = requestIdentity(req({ 'cf-connecting-ip': '2001:db8:1:2::1' }));
    const b = requestIdentity(req({ 'cf-connecting-ip': '2001:db8:9:9::1' }));
    expect(a).not.toBe(b);
  });
});

describe('bucketId', () => {
  // A fact check costs a model call plus five page fetches; a ticker read is a
  // cached lookup. One shared bucket would misprice both.
  it('separates endpoints for the same caller', () => {
    expect(bucketId({ endpoint: 'factcheck', identity: '1.2.3.4' })).not.toBe(
      bucketId({ endpoint: 'ticker', identity: '1.2.3.4' }),
    );
  });

  it('is stable for the same caller and endpoint', () => {
    expect(bucketId({ endpoint: 'factcheck', identity: '1.2.3.4' })).toBe(
      bucketId({ endpoint: 'factcheck', identity: '1.2.3.4' }),
    );
  });
});

describe('checkRateLimit / checkRateLimitSafe', () => {
  afterEach(() => vi.restoreAllMocks());

  function namespaceFor(obj: RateLimiter): RateLimiterNamespace {
    return {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (_url: string, init?: RequestInit) => obj.fetch(new Request('https://rate-limiter/check', init)) }),
    };
  }

  it('routes through the namespace and returns the decision', async () => {
    const { obj } = limiterInstance();
    const decision = await checkRateLimit(namespaceFor(obj), { endpoint: 'factcheck', identity: 'ip' }, 2);
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(2);
  });

  // Deliberate direction: a limiter outage must not take fact checking - the
  // product's core function - offline to prevent a recoverable cost overrun.
  it('fails OPEN and logs when the limiter throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: RateLimiterNamespace = {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => { throw new Error('DO unreachable'); } }),
    };

    const decision = await checkRateLimitSafe(broken, { endpoint: 'factcheck', identity: 'ip' }, 20);
    expect(decision.allowed).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('fails open when the binding is absent, as in local dev', async () => {
    const decision = await checkRateLimitSafe(undefined, { endpoint: 'factcheck', identity: 'ip' }, 20);
    expect(decision.allowed).toBe(true);
  });
});
