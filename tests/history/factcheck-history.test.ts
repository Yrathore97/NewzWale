import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Minimal in-memory localStorage.
 *
 *  The test config runs vitest with `environment: 'node'`, which has no DOM
 *  and therefore no localStorage. Reaching for jsdom/happy-dom would add a
 *  dependency to a 4-dependency project for a Map with a Storage-shaped face —
 *  this is that Map. It implements exactly what the module under test calls:
 *  getItem, setItem, removeItem, clear. */
class FakeStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

(globalThis as unknown as { localStorage: Storage }).localStorage = new FakeStorage();
(globalThis as unknown as { Storage: unknown }).Storage = FakeStorage;

import {
  getFactCheckHistory,
  recordFactCheckHistory,
  removeFactCheckHistoryEntry,
  clearFactCheckHistory,
  filterByVerdict,
  countsByVerdict,
  sortedByRecency,
  MAX_HISTORY_ENTRIES,
} from '../../src/lib/history/factcheck-history';

const KEY = 'nz_factcheck_history';

describe('factcheck-history', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(getFactCheckHistory()).toEqual([]);
  });

  it('writes a successful record and reads it back', () => {
    recordFactCheckHistory({ id: 'a1', claim: 'RBI held rates', verdict: 'true', evidenceStrength: 'strong' });

    const all = getFactCheckHistory();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: 'a1',
      claim: 'RBI held rates',
      verdict: 'true',
      evidenceStrength: 'strong',
    });
    expect(typeof all[0].checkedAt).toBe('string');
  });

  it('does not write a record missing id or claim', () => {
    recordFactCheckHistory({ id: '', claim: 'no id', verdict: 'true' });
    recordFactCheckHistory({ id: 'x', claim: '', verdict: 'true' });
    expect(getFactCheckHistory()).toEqual([]);
  });

  it('defaults a missing verdict to unverified rather than dropping the record', () => {
    recordFactCheckHistory({ id: 'a1', claim: 'claim', verdict: '' });
    expect(getFactCheckHistory()[0].verdict).toBe('unverified');
  });

  describe('duplicate handling', () => {
    it('checking the same id twice produces one row, not two', () => {
      recordFactCheckHistory({ id: 'dup', claim: 'first phrasing', verdict: 'true' });
      recordFactCheckHistory({ id: 'dup', claim: 'first phrasing', verdict: 'true' });
      expect(getFactCheckHistory()).toHaveLength(1);
    });

    it('re-recording the same id moves it to the front and updates its fields', () => {
      recordFactCheckHistory({ id: 'dup', claim: 'old', verdict: 'unverified' });
      recordFactCheckHistory({ id: 'other', claim: 'middle', verdict: 'true' });
      recordFactCheckHistory({ id: 'dup', claim: 'old', verdict: 'true', evidenceStrength: 'strong' });

      const all = getFactCheckHistory();
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe('dup');
      expect(all[0].verdict).toBe('true');
      expect(all[0].evidenceStrength).toBe('strong');
    });
  });

  describe('maximum history size', () => {
    it('caps at MAX_HISTORY_ENTRIES, evicting the oldest', () => {
      for (let i = 0; i < MAX_HISTORY_ENTRIES + 10; i++) {
        recordFactCheckHistory({ id: `id-${i}`, claim: `claim ${i}`, verdict: 'true' });
      }
      const all = getFactCheckHistory();
      expect(all).toHaveLength(MAX_HISTORY_ENTRIES);
      // Most recently added is first, oldest (id-0..id-9) were evicted.
      expect(all[0].id).toBe(`id-${MAX_HISTORY_ENTRIES + 9}`);
      expect(all.some((e) => e.id === 'id-0')).toBe(false);
      expect(all.some((e) => e.id === 'id-9')).toBe(false);
    });
  });

  describe('malformed localStorage', () => {
    it('returns empty for invalid JSON rather than throwing', () => {
      localStorage.setItem(KEY, '{not json');
      expect(() => getFactCheckHistory()).not.toThrow();
      expect(getFactCheckHistory()).toEqual([]);
    });

    it('returns empty when the stored value is not an array', () => {
      localStorage.setItem(KEY, JSON.stringify({ oops: true }));
      expect(getFactCheckHistory()).toEqual([]);
    });

    it('filters out entries missing required fields instead of discarding the whole list', () => {
      localStorage.setItem(
        KEY,
        JSON.stringify([
          { id: 'good', claim: 'a claim', verdict: 'true', evidenceStrength: null, checkedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'bad-no-claim', verdict: 'true' },
          { claim: 'no id here' },
          null,
          'a string, not an object',
          42,
        ]),
      );
      const all = getFactCheckHistory();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('good');
    });

    it('recovers gracefully when localStorage.getItem throws', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      expect(() => getFactCheckHistory()).not.toThrow();
      expect(getFactCheckHistory()).toEqual([]);
      spy.mockRestore();
    });

    it('recording does not throw when localStorage.setItem throws (e.g. quota exceeded)', () => {
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota exceeded');
      });
      expect(() =>
        recordFactCheckHistory({ id: 'a', claim: 'claim', verdict: 'true' }),
      ).not.toThrow();
      spy.mockRestore();
    });
  });

  describe('filtering by verdict', () => {
    beforeEach(() => {
      recordFactCheckHistory({ id: '1', claim: 'a', verdict: 'true' });
      recordFactCheckHistory({ id: '2', claim: 'b', verdict: 'false' });
      recordFactCheckHistory({ id: '3', claim: 'c', verdict: 'true' });
    });

    it('"all" returns everything', () => {
      expect(filterByVerdict(getFactCheckHistory(), 'all')).toHaveLength(3);
    });

    it('a specific verdict returns only matching entries', () => {
      const trueOnly = filterByVerdict(getFactCheckHistory(), 'true');
      expect(trueOnly).toHaveLength(2);
      expect(trueOnly.every((e) => e.verdict === 'true')).toBe(true);
    });

    it('a verdict with no entries returns an empty array, not an error', () => {
      expect(filterByVerdict(getFactCheckHistory(), 'misleading')).toEqual([]);
    });

    it('counts every requested verdict including zero-count ones', () => {
      const counts = countsByVerdict(getFactCheckHistory(), ['true', 'false', 'misleading']);
      expect(counts).toEqual({ all: 3, true: 2, false: 1, misleading: 0 });
    });
  });

  describe('clearing and removing', () => {
    it('removes a single entry by id', () => {
      recordFactCheckHistory({ id: 'keep', claim: 'a', verdict: 'true' });
      recordFactCheckHistory({ id: 'drop', claim: 'b', verdict: 'true' });
      removeFactCheckHistoryEntry('drop');
      const all = getFactCheckHistory();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('keep');
    });

    it('clears the entire history', () => {
      recordFactCheckHistory({ id: '1', claim: 'a', verdict: 'true' });
      clearFactCheckHistory();
      expect(getFactCheckHistory()).toEqual([]);
    });

    it('clearing an already-empty history does not throw', () => {
      expect(() => clearFactCheckHistory()).not.toThrow();
    });
  });

  describe('sortedByRecency', () => {
    it('orders newest first regardless of input order', () => {
      const entries = [
        { id: '1', claim: 'old', verdict: 'true', evidenceStrength: null, checkedAt: '2026-01-01T00:00:00.000Z' },
        { id: '2', claim: 'new', verdict: 'true', evidenceStrength: null, checkedAt: '2026-06-01T00:00:00.000Z' },
        { id: '3', claim: 'mid', verdict: 'true', evidenceStrength: null, checkedAt: '2026-03-01T00:00:00.000Z' },
      ];
      const sorted = sortedByRecency(entries);
      expect(sorted.map((e) => e.id)).toEqual(['2', '3', '1']);
    });
  });
});
