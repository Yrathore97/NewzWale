import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Minimal in-memory localStorage, mirroring tests/history/factcheck-history.
 *  vitest runs `environment: 'node'` (no DOM), so this is the Storage face the
 *  module under test actually calls. */
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
  getSaved,
  isSaved,
  toggleSaved,
  getTopics,
  toggleTopic,
  DEFAULT_TOPICS,
} from '../src/lib/saved';

const SAVE_KEY = 'nz_saved';
const TOPICS_KEY = 'nz_topics';

describe('saved-articles storage (window.NZ backing)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('normal operation', () => {
    it('starts empty', () => {
      expect(getSaved()).toEqual([]);
    });

    it('saves, reports saved, and unsaves', () => {
      expect(toggleSaved('https://x.com/1', 'One')).toBe(true);
      expect(isSaved('https://x.com/1')).toBe(true);
      expect(getSaved()).toEqual([{ href: 'https://x.com/1', headline: 'One' }]);

      expect(toggleSaved('https://x.com/1', 'One')).toBe(false);
      expect(isSaved('https://x.com/1')).toBe(false);
      expect(getSaved()).toEqual([]);
    });

    it('does not duplicate an already-saved article', () => {
      toggleSaved('https://x.com/1', 'One');
      // A second toggle removes it rather than adding a duplicate.
      toggleSaved('https://x.com/1', 'One');
      toggleSaved('https://x.com/1', 'One');
      expect(getSaved().filter((a) => a.href === 'https://x.com/1')).toHaveLength(1);
    });
  });

  describe('malformed storage — the P8 defect', () => {
    it('returns [] for valid JSON of the wrong shape (the reported crash)', () => {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ corrupted: true }));
      expect(getSaved()).toEqual([]);
    });

    it('returns [] for a JSON array-less primitive', () => {
      for (const raw of ['42', '"a string"', 'true', 'null']) {
        localStorage.setItem(SAVE_KEY, raw);
        expect(getSaved()).toEqual([]);
      }
    });

    it('preserves the existing invalid-JSON behaviour (also [])', () => {
      localStorage.setItem(SAVE_KEY, '{not json');
      expect(getSaved()).toEqual([]);
    });

    it('isSaved() does not throw after poisoned nz_saved', () => {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ corrupted: true }));
      expect(() => isSaved('https://x.com/1')).not.toThrow();
      expect(isSaved('https://x.com/1')).toBe(false);
    });

    it('toggleSaved() recovers and saves normally after poisoned storage', () => {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ corrupted: true }));
      // The poisoned value must not prevent a fresh save.
      expect(() => toggleSaved('https://x.com/1', 'One')).not.toThrow();
      expect(getSaved()).toEqual([{ href: 'https://x.com/1', headline: 'One' }]);
      // And the store is now a valid array again.
      const stored = JSON.parse(localStorage.getItem(SAVE_KEY)!);
      expect(Array.isArray(stored)).toBe(true);
      expect(stored).toEqual([{ href: 'https://x.com/1', headline: 'One' }]);
    });

    it('recovers when localStorage.getItem itself throws', () => {
      const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage disabled');
      });
      expect(() => getSaved()).not.toThrow();
      expect(getSaved()).toEqual([]);
      spy.mockRestore();
    });
  });
});

describe('topic preferences storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns the defaults when nothing is stored', () => {
    expect(getTopics()).toEqual(DEFAULT_TOPICS);
  });

  it('round-trips a real selection', () => {
    // toggleTopic on a default removes it; on a new name adds it.
    toggleTopic('Sports');
    expect(getTopics()).not.toContain('Sports');
    toggleTopic('Sports');
    expect(getTopics()).toContain('Sports');
  });

  it('returns [] for valid JSON of the wrong shape', () => {
    localStorage.setItem(TOPICS_KEY, JSON.stringify({ corrupted: true }));
    expect(getTopics()).toEqual([]);
  });

  it('preserves the existing invalid-JSON behaviour (defaults)', () => {
    localStorage.setItem(TOPICS_KEY, '{not json');
    expect(getTopics()).toEqual(DEFAULT_TOPICS);
  });

  it('getTopics() does not throw after poisoned nz_topics', () => {
    localStorage.setItem(TOPICS_KEY, JSON.stringify({ corrupted: true }));
    expect(() => getTopics()).not.toThrow();
    // A non-array can never reach refreshTopicControls' .includes().
    expect(Array.isArray(getTopics())).toBe(true);
  });

  it('toggleTopic() recovers after poisoned storage', () => {
    localStorage.setItem(TOPICS_KEY, JSON.stringify({ corrupted: true }));
    expect(() => toggleTopic('Health')).not.toThrow();
    expect(getTopics()).toContain('Health');
  });
});
