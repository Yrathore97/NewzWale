/** Client-side fact-check history — the P6 HISTORY decision.
 *
 *  DEVICE-LOCAL ONLY, by explicit product decision:
 *    - localStorage, nothing else.
 *    - NO server-side history table, NO D1 schema change, NO authentication.
 *    - Written only after a fact-check has SUCCEEDED. A failed or in-flight
 *      check never produces a row — a history entry is evidence a check
 *      actually completed.
 *
 *  This module owns the storage format and is the only place that touches the
 *  `nz_factcheck_history` key. It does not import from src/lib/factcheck/*: it
 *  stores presentation-shaped strings (verdict, evidenceStrength as their wire
 *  values), not the pipeline's internal types, so a change to the evidence
 *  engine cannot silently corrupt history it never asked to depend on.
 */

const STORAGE_KEY = 'nz_factcheck_history';

/** Bounded so an active user's localStorage entry cannot grow without limit.
 *  Oldest entries are evicted first. */
export const MAX_HISTORY_ENTRIES = 50;

export interface FactCheckHistoryEntry {
  /** The persisted fact-check's id — same id /fact-check/[id] resolves. */
  id: string;
  claim: string;
  verdict: string;
  /** Nullable: not every render path has the strength available. */
  evidenceStrength: string | null;
  /** ISO-8601. When this device recorded the entry, not when the check ran —
   *  the two are the same in practice, but this is the honest description of
   *  what the field measures. */
  checkedAt: string;
}

function isEntry(value: unknown): value is FactCheckHistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    v.id.length > 0 &&
    typeof v.claim === 'string' &&
    typeof v.verdict === 'string' &&
    (v.evidenceStrength === null || typeof v.evidenceStrength === 'string') &&
    typeof v.checkedAt === 'string'
  );
}

/** Reads and validates. Any failure mode — missing key, invalid JSON, wrong
 *  shape, a non-array, entries that do not pass isEntry — degrades to an empty
 *  list rather than throwing. A corrupted history must not break the page that
 *  reads it. */
export function getFactCheckHistory(): FactCheckHistoryEntry[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage can throw in private-browsing modes and with disabled cookies.
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isEntry);
}

function write(entries: FactCheckHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota exceeded, or storage unavailable. History is a convenience
    // feature; losing a write must not surface as an error to the reader.
  }
}

export interface RecordHistoryInput {
  id: string;
  claim: string;
  verdict: string;
  evidenceStrength?: string | null;
  /** ISO-8601. Defaults to now. */
  checkedAt?: string;
}

/** Records one completed fact-check, or moves it to the front if it is
 *  already present (a claim checked twice is not two rows).
 *
 *  No-op for a missing id or claim: those are the two fields
 *  /fact-check/history cannot render without, and a partial entry is worse
 *  than no entry. */
export function recordFactCheckHistory(input: RecordHistoryInput): void {
  if (!input.id || !input.claim) return;

  const entry: FactCheckHistoryEntry = {
    id: input.id,
    claim: input.claim,
    verdict: input.verdict || 'unverified',
    evidenceStrength: input.evidenceStrength ?? null,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
  };

  const existing = getFactCheckHistory().filter((e) => e.id !== entry.id);
  const next = [entry, ...existing].slice(0, MAX_HISTORY_ENTRIES);
  write(next);
}

export function removeFactCheckHistoryEntry(id: string): void {
  write(getFactCheckHistory().filter((e) => e.id !== id));
}

export function clearFactCheckHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do if storage is unavailable */
  }
}

/** Newest first (recordFactCheckHistory already inserts at the front, but
 *  this is asserted rather than assumed for anything reading the raw store). */
export function sortedByRecency(entries: FactCheckHistoryEntry[]): FactCheckHistoryEntry[] {
  return [...entries].sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
}

export function filterByVerdict(
  entries: FactCheckHistoryEntry[],
  verdict: string | 'all',
): FactCheckHistoryEntry[] {
  return verdict === 'all' ? entries : entries.filter((e) => e.verdict === verdict);
}

/** Counts per verdict plus 'all', for the filter chips. Every VERDICT_ORDER
 *  value is present even at zero, so a chip for an unseen verdict still
 *  renders (disabled) rather than being absent. */
export function countsByVerdict(
  entries: FactCheckHistoryEntry[],
  verdicts: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = { all: entries.length };
  for (const v of verdicts) counts[v] = 0;
  for (const e of entries) {
    if (e.verdict in counts) counts[e.verdict] += 1;
  }
  return counts;
}
