/** Minimal D1 access surface.
 *
 *  NO ORM, deliberately. D1 is SQLite behind a prepared-statement API; an ORM
 *  would add a runtime dependency, a migration system that competes with the
 *  .sql files, and a query builder whose output nobody reads. The repositories
 *  in ./repositories own their SQL, which keeps it reviewable - and on a
 *  product where a mistaken join could mislabel a verdict, readable SQL is
 *  worth more than terse call sites.
 *
 *  The interfaces below are structural rather than imports of Cloudflare's
 *  D1Database type, so repositories can be unit-tested against node:sqlite
 *  without a Worker. Same convention as `cached(kv, ...)` and
 *  `search(apiKey, ...)`. */

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface Db {
  prepare(query: string): DbStatement;
  batch(statements: DbStatement[]): Promise<unknown[]>;
}

/** Thrown when a repository is used without a database binding.
 *
 *  The D1 binding is commented out in wrangler.jsonc until it is provisioned,
 *  so this WILL be hit if a caller forgets to check. Failing loudly beats a
 *  confusing "cannot read property prepare of undefined" from inside a query. */
export class DbUnavailableError extends Error {
  constructor() {
    super('The database binding (NEWZ_DB) is not configured on this environment.');
    this.name = 'DbUnavailableError';
  }
}

export function requireDb(db: Db | undefined): Db {
  if (!db) throw new DbUnavailableError();
  return db;
}

/** True when the environment has a usable database.
 *
 *  Callers use this to degrade rather than fail: during Phase 2 the app must
 *  keep working with the binding absent, because it is not provisioned yet. */
export function hasDb(db: Db | undefined): db is Db {
  return Boolean(db);
}

/** ISO-8601 UTC, the format every timestamp column in the schema uses. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Stable id for a row keyed by natural content (a canonical URL, a
 *  normalised claim). Same digest scheme as the KV cache key, so an article or
 *  fact check has ONE identity across both stores. */
export async function contentId(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
