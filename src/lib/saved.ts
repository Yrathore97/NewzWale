/** Device-local saved articles + homepage topic preferences.
 *
 *  This is the single source of truth for the `window.NZ` storage helpers,
 *  extracted VERBATIM from the inline block that used to live in
 *  `Layout.astro`. Behaviour, keys (`nz_saved`, `nz_topics`), the
 *  `nz-saved-changed` / `nz-topics-changed` events, and the `window.NZ` API are
 *  all unchanged — the only reason this is now a module is so the read-guards
 *  below can be unit-tested against real code, the same way
 *  `src/lib/history/factcheck-history.ts` is.
 *
 *  THE FIX THIS MODULE CARRIES: the previous inline `getSaved()`/`getTopics()`
 *  caught invalid JSON but not valid JSON of the WRONG SHAPE. A poisoned
 *  `nz_saved = {"corrupted":true}` (attacker-writable via any same-origin XSS,
 *  or a future format change) parsed successfully to a non-array, and then
 *  `.some()` / `.includes()` threw — which silently disabled saving across the
 *  whole site until the value was cleared. Both readers now verify the parsed
 *  value is an array before returning it. The history module already did this
 *  (`Array.isArray`); this brings saved/topics to parity.
 *
 *  Device-local only, by the Phase 8 decision: no server, no account, no D1.
 */

const SAVE_KEY = 'nz_saved';
const TOPICS_KEY = 'nz_topics';

export const DEFAULT_TOPICS = ['Sports', 'Business', 'Technology', 'Health'];

export interface SavedArticle {
  href: string;
  headline: string;
}

/** Reads saved articles. Invalid JSON, a missing key, OR valid JSON that is
 *  not an array all degrade to `[]` — the reader can never hand a non-array to
 *  a caller that will `.some()`/`.filter()` over it. */
export function getSaved(): SavedArticle[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function setSaved(list: SavedArticle[]): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(list));
  // Guarded so the module is importable under `environment: 'node'` (vitest),
  // where `window` is undefined. In the browser this fires exactly as before,
  // and every component listening on `nz-saved-changed` still updates.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nz-saved-changed', { detail: { list } }));
  }
}

export function isSaved(href: string): boolean {
  return getSaved().some((a) => a.href === href);
}

export function toggleSaved(href: string, headline: string): boolean {
  const list = getSaved();
  const exists = list.some((a) => a.href === href);
  const next = exists ? list.filter((a) => a.href !== href) : [...list, { href, headline }];
  setSaved(next);
  return !exists;
}

/** Reads homepage topic preferences.
 *
 *  A MISSING key and INVALID JSON both fall back to `DEFAULT_TOPICS` — the
 *  original behaviour, preserved so a first-time visitor still sees the default
 *  sections. Valid JSON of the wrong shape returns `[]` (per the Phase 8 fix
 *  spec): it is corruption, not a fresh visitor, so the defaults are not
 *  re-asserted. The load-bearing guarantee shared by all paths is that a
 *  non-array can never reach `refreshTopicControls`, whose `.includes()` would
 *  otherwise throw. */
export function getTopics(): string[] {
  try {
    const raw = localStorage.getItem(TOPICS_KEY);
    if (raw === null) return DEFAULT_TOPICS.slice();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return DEFAULT_TOPICS.slice();
  }
}

export function setTopics(list: string[]): void {
  localStorage.setItem(TOPICS_KEY, JSON.stringify(list));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('nz-topics-changed', { detail: { list } }));
  }
}

export function toggleTopic(name: string): boolean {
  const list = getTopics();
  const has = list.includes(name);
  const next = has ? list.filter((t) => t !== name) : [...list, name];
  setTopics(next);
  return !has;
}
