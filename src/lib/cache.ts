import { pipelineIdentity } from './factcheck/version';

/** Cache key for one page of one category in one language.
 *
 *  v2 because v1 keyed on category ONLY - it would serve a Hindi reader the
 *  cached English feed. The version bump also avoids reading v1 entries, which
 *  were written under the old value shape (a bare Article[], not a NewsPage). */
export function newsCacheKey(category = 'top', language = 'en', page?: string): string {
  return `news:v2:${category}:${language}:${page ?? 'first'}`;
}

/** Canonical form of a claim, used for BOTH the cache key and (later) the
 *  persisted fact_checks.id, so the same claim can never produce two
 *  identities. Exported for tests and for the D1 layer. */
export function normalizeClaim(claim: string): string {
  return claim.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Cache identity for one fact-check result.
 *
 *  v2, and a full cryptographic digest rather than the claim itself. Two
 *  reasons, both of which v1 got wrong:
 *
 *  1. COLLISIONS. v1 was `fc:v1:${norm.slice(0, 200)}` - the first 200
 *     characters of the claim. A URL check submits up to 4,000 characters of
 *     article body as the claim, so any two articles sharing an opening (a
 *     wire lede, a boilerplate header, a cookie banner that survived text
 *     extraction) collided and were served each other's verdict. On a
 *     fact-checking product that is a correctness failure with a
 *     cache-poisoning shape. See NEWZWALE_SECURITY_AUDIT.md S-03.
 *
 *  2. METHODOLOGY DRIFT. The key now includes the pipeline identity, so a
 *     verdict produced under superseded methodology becomes unreachable the
 *     moment a version constant is bumped. No manual purge, no window where
 *     two methodologies are both serving.
 *
 *  Hashing also keeps raw user-submitted claim text out of KV key names,
 *  which are visible in operational tooling.
 *
 *  Async because SubtleCrypto is. Every caller is already in an async path. */
export async function factCheckCacheKey(claim: string): Promise<string> {
  const identity = `${normalizeClaim(claim)}|${pipelineIdentity()}`;
  return `fc:v2:${await sha256Hex(identity)}`;
}

const STALE_TTL = 60 * 60 * 24;

export async function cached<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>,
): Promise<T | null> {
  const hit = await kv.get(key);
  if (hit) return JSON.parse(hit) as T;

  try {
    const fresh = await produce();
    await kv.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
    await kv.put(`${key}:stale`, JSON.stringify(fresh), { expirationTtl: STALE_TTL });
    return fresh;
  } catch {
    const stale = await kv.get(`${key}:stale`);
    return stale ? (JSON.parse(stale) as T) : null;
  }
}
