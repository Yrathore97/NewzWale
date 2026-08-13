/** Rate limiting.
 *
 *  WHY THE KV VERSION WAS NOT A RATE LIMITER
 *
 *  The previous implementation was:
 *
 *      const current = Number(await kv.get(key) ?? '0');
 *      if (current >= limit) return false;
 *      await kv.put(key, String(current + 1), { expirationTtl: WINDOW });
 *
 *  Read-then-write with no compare-and-swap. Twenty concurrent requests all
 *  read 0 and all write 1, so all twenty pass. Worse, Workers KV is eventually
 *  consistent between colos, so a distributed client gets an independent
 *  counter per data centre. The effective limit was not 20/hour; it was closer
 *  to 20/hour/colo/burst. KV has no atomic increment, so this cannot be fixed
 *  in KV - it needs a different primitive.
 *
 *  A Durable Object is that primitive: single-threaded, single-instance per
 *  id, with transactional storage. Increment is genuinely atomic.
 *
 *  The limit exists to stop cost abuse of Workers AI, Tavily, and the article
 *  fetch proxy. It is a cost control, so it must actually hold. */

/** Fixed window in seconds. A sliding window would be more precise, but a
 *  fixed window is one stored integer and one timestamp; the extra precision
 *  does not justify the extra state for a cost control. */
export const DEFAULT_WINDOW_SECONDS = 60 * 60;

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Seconds until the window resets. Feeds the Retry-After header. */
  retryAfterSeconds: number;
  limit: number;
}

/** Identity a limit is applied to.
 *
 *  Endpoint-aware on purpose: /api/factcheck spends money per call (Workers
 *  AI + Tavily + up to 5 page fetches) while /api/ticker is a cached proxy.
 *  One shared bucket would either throttle the cheap endpoint pointlessly or
 *  leave the expensive one wide open. */
export interface RateLimitKey {
  endpoint: string;
  identity: string;
}

/** Deterministic bucket id. Stable for the same caller and endpoint, so the
 *  Durable Object instance is the same across requests. */
export function bucketId({ endpoint, identity }: RateLimitKey): string {
  return `${endpoint}:${identity}`;
}

/** Identity used when the request did not come through Cloudflare at all -
 *  i.e. local development. Distinct constant so it is obvious in logs. */
export const LOCAL_DEV_IDENTITY = 'local-dev';

/** Derives the request identity.
 *
 *  Two hardening changes over the previous `?? 'unknown'`:
 *
 *  1. IPv6 is bucketed on the /64 prefix. Residential IPv6 allocations are
 *     routinely a /64 or larger, so per-address limiting hands one household
 *     effectively unlimited quota by rotating the low bits.
 *
 *  2. A request that reached us THROUGH Cloudflare but carries no
 *     cf-connecting-ip is refused rather than pooled into a shared bucket.
 *     Behind Cloudflare that header is always present, so its absence is
 *     anomalous, and the old `?? 'unknown'` gave every such caller one bucket
 *     they could exhaust for each other.
 *
 *  The distinction between "anomalous" and "not behind Cloudflare" is made
 *  with cf-ray, which Cloudflare attaches to every proxied request. Without
 *  it, this is local dev and a fixed identity is correct - the first draft of
 *  this function returned null in that case and 400'd every local fact check,
 *  which is how the difference got noticed. */
export function requestIdentity(request: Request): string | null {
  const ip = request.headers.get('cf-connecting-ip');

  if (!ip) {
    // No cf-ray either => the request never traversed Cloudflare => local dev.
    if (!request.headers.get('cf-ray')) return LOCAL_DEV_IDENTITY;
    // Proxied but missing the client IP: anomalous, refuse.
    return null;
  }

  if (ip.includes(':')) {
    const groups = ip.split(':');
    // First four groups = /64. Normalised so ::1 and 0:0:0:1 cannot become
    // different buckets.
    return groups.slice(0, 4).map((g) => g || '0').join(':') + '::/64';
  }
  return ip;
}

/** The client half of the rate limiter. Talks to the Durable Object.
 *
 *  `namespace` is typed structurally rather than as DurableObjectNamespace so
 *  this module stays testable with a plain fake and carries no Worker import.
 *  Same convention as `cached(kv, ...)` and `search(apiKey, ...)`. */
export interface RateLimiterStub {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface RateLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): RateLimiterStub;
}

export async function checkRateLimit(
  namespace: RateLimiterNamespace,
  key: RateLimitKey,
  limit: number,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<RateLimitDecision> {
  const id = namespace.idFromName(bucketId(key));
  const stub = namespace.get(id);

  const res = await stub.fetch('https://rate-limiter/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit, windowSeconds }),
  });

  return (await res.json()) as RateLimitDecision;
}

/** Fails OPEN when the limiter itself is unavailable.
 *
 *  A deliberate trade-off, and the direction matters. Failing closed would
 *  turn a Durable Object outage into a total outage of fact checking - the
 *  product's core function - to prevent what is only a cost overrun. Cost
 *  abuse during a limiter outage is recoverable; a fact-checker that answers
 *  nothing is not.
 *
 *  Logged loudly so an outage is visible rather than silently unlimited. */
export async function checkRateLimitSafe(
  namespace: RateLimiterNamespace | undefined,
  key: RateLimitKey,
  limit: number,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<RateLimitDecision> {
  const openDecision: RateLimitDecision = {
    allowed: true,
    remaining: limit,
    retryAfterSeconds: 0,
    limit,
  };

  if (!namespace) {
    // Binding absent: local dev before the Durable Object is provisioned.
    return openDecision;
  }

  try {
    return await checkRateLimit(namespace, key, limit, windowSeconds);
  } catch (err) {
    console.error('Rate limiter unavailable; failing open:', err);
    return openDecision;
  }
}
