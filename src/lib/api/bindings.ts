/** Turning an absent Worker binding into a correct API response.
 *
 *  DOCUMENTED FALLBACK BEHAVIOUR. The D1 binding is commented out in
 *  wrangler.jsonc until `wrangler d1 create` yields a real database_id, so on
 *  today's deploy every D1-backed v1 route has no database. That must produce
 *  a truthful, machine-readable answer rather than a crash or — far worse — an
 *  empty success envelope, which would tell a client "there is no news"
 *  instead of "this service is not available yet".
 *
 *  UPSTREAM_UNAVAILABLE (503) is the right code: the route is correct, its
 *  dependency is missing, and the condition is transient from the client's
 *  point of view. INTERNAL would imply a bug; NOT_FOUND would imply the data
 *  does not exist. */

import { ApiError } from './errors';
import { getDb, type Db } from '../db/client';

export function requireDbBinding(env: unknown): Db {
  const db = getDb(env);
  if (!db) {
    // The message names no binding, file path or account detail — a client
    // learns that storage is unavailable, not how this Worker is wired.
    throw new ApiError('UPSTREAM_UNAVAILABLE', 'The news database is not available right now.');
  }
  return db;
}
