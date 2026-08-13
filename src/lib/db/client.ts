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

/** The Worker environment, insofar as the database layer cares about it.
 *
 *  Structural, like `Db` above: importing Cloudflare's Env here would drag a
 *  Worker-only type into modules that are unit-tested under plain Node. */
export interface DbEnv {
  NEWZ_DB?: Db;
}

/** The one place `NEWZ_DB` is read off the environment.
 *
 *  Before this existed, each call site wrote
 *  `(env as unknown as { NEWZ_DB?: Db }).NEWZ_DB` — a raw double cast repeated
 *  per consumer. Repeating it means each copy independently asserts the
 *  binding's name and type, so a rename breaks them silently and separately.
 *  Narrowing once here keeps that assertion in a single reviewable line.
 *
 *  Returns `undefined` rather than throwing when the binding is absent: it IS
 *  absent today (wrangler.jsonc keeps the D1 block commented until a real
 *  database_id exists), and read paths are required to degrade rather than
 *  fail. Callers that genuinely need a database pass the result to
 *  `requireDb`; callers that can degrade use `hasDb`. */
export function getDb(env: unknown): Db | undefined {
  return (env as DbEnv | undefined)?.NEWZ_DB;
}

/** ISO-8601 UTC, the format every timestamp column in the schema uses. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** ── Keyset pagination ──────────────────────────────────────────────────────
 *
 *  OFFSET is not used anywhere in this layer. Feeds are ingested continuously,
 *  so by the time a reader asks for page 2 the rows have shifted underneath
 *  the offset and they see an article twice or miss one entirely. A keyset
 *  cursor names the last row seen instead of counting past it, which is stable
 *  under concurrent inserts.
 *
 *  The cursor is opaque to clients on purpose. It encodes a sort value and a
 *  row id, and both are fed to a parameterised comparison — never interpolated
 *  into SQL. */

/** NUL, because it is the only byte neither component can contain.
 *
 *  A space would be wrong. Timestamps in this schema come from two sources
 *  with two shapes: `nowIso()` writes real ISO-8601 ('...T00:00:00Z'), while
 *  the columns' own `DEFAULT (datetime('now'))` writes SQLite's
 *  'YYYY-MM-DD HH:MM:SS' — which CONTAINS A SPACE. Splitting on the first
 *  space would cut the sort value in half and silently corrupt the cursor.
 *  Pinned by a test. */
const CURSOR_SEP = '\u0000';

export interface Cursor {
  /** The ORDER BY value of the last row on the previous page. */
  sortValue: string;
  /** That row's id, breaking ties when several rows share a sort value. */
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return btoa(`${cursor.sortValue}${CURSOR_SEP}${cursor.id}`);
}

/** Parses a client-supplied cursor, or returns null if it is not one.
 *
 *  Returns null rather than throwing so the caller decides the consequence:
 *  a route rejects with INVALID_INPUT, while an internal caller can treat it
 *  as "start from the beginning". Malformed input must never reach the query —
 *  a null here means the WHERE clause is omitted entirely, not that an empty
 *  string is bound. */
export function decodeCursor(value: string | undefined | null): Cursor | null {
  if (!value) return null;
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return null;
  }
  const sep = decoded.indexOf(CURSOR_SEP);
  if (sep <= 0 || sep === decoded.length - 1) return null;
  return { sortValue: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
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
