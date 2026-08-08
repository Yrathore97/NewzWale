/** Durable Object implementing an atomic fixed-window counter.
 *
 *  Deliberately small. A Durable Object is a single-threaded actor with
 *  transactional storage; that is the entire reason it is here, and the whole
 *  value is in the fact that `read; compare; write` cannot interleave. Adding
 *  quota tiers, distributed accounting or analytics to this class would grow
 *  the surface without adding a guarantee.
 *
 *  Cloudflare also offers a native rate-limiting binding. It was not used
 *  because its limits are declared statically in wrangler config, and this
 *  application needs per-endpoint limits chosen at call time (a fact check
 *  costs a model invocation plus five page fetches; a ticker read costs a
 *  cached lookup). Revisit if that changes.
 *
 *  ONE INSTANCE PER (endpoint, identity) — see bucketId in ../ratelimit.ts.
 *  Requests for the same bucket land on the same instance no matter which colo
 *  they arrive at, which is precisely the property KV could not provide. */

interface WindowState {
  /** Requests counted in the current window. */
  count: number;
  /** Epoch ms when the current window began. */
  startedAt: number;
}

interface CheckRequest {
  limit: number;
  windowSeconds: number;
}

const STATE_KEY = 'w';

export class RateLimiter {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    let body: CheckRequest;
    try {
      body = (await request.json()) as CheckRequest;
    } catch {
      return Response.json({ error: 'bad request' }, { status: 400 });
    }

    const limit = Number.isFinite(body.limit) && body.limit > 0 ? Math.floor(body.limit) : 1;
    const windowSeconds =
      Number.isFinite(body.windowSeconds) && body.windowSeconds > 0
        ? Math.floor(body.windowSeconds)
        : 3600;
    const windowMs = windowSeconds * 1000;

    // blockConcurrencyWhile serialises the read-modify-write against every
    // other request to this object. This is the atomicity the KV version
    // could not have.
    const decision = await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = (await this.state.storage.get<WindowState>(STATE_KEY)) ?? {
        count: 0,
        startedAt: now,
      };

      // Expired window: start a fresh one rather than carrying the count over.
      const expired = now - stored.startedAt >= windowMs;
      const current: WindowState = expired ? { count: 0, startedAt: now } : stored;

      const elapsed = now - current.startedAt;
      const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - elapsed) / 1000));

      if (current.count >= limit) {
        // Over limit: do NOT increment. Otherwise a client hammering the
        // endpoint would keep pushing the count up for no purpose, and on a
        // sliding-window implementation would extend its own lockout.
        return { allowed: false, remaining: 0, retryAfterSeconds, limit };
      }

      const next: WindowState = { count: current.count + 1, startedAt: current.startedAt };
      await this.state.storage.put(STATE_KEY, next);

      // Let storage expire on its own rather than leaving state for every IP
      // that ever called, forever.
      await this.state.storage.setAlarm(current.startedAt + windowMs);

      return {
        allowed: true,
        remaining: Math.max(0, limit - next.count),
        retryAfterSeconds,
        limit,
      };
    });

    return Response.json(decision);
  }

  /** Fires when the window ends. Clearing storage lets Cloudflare evict the
   *  object entirely, so an idle bucket costs nothing. */
  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}
