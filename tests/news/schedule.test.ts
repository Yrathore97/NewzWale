import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  runScheduledIngest,
  CRON_CATEGORIES,
  CRON_LANGUAGE,
} from '../../src/lib/news/schedule';
import * as ingestModule from '../../src/lib/news/ingest';
import type { Db } from '../../src/lib/db/client';

/** Scheduled ingestion — the caller `ingest()` never had.
 *
 *  These tests are about the TICK's contract, not about ingestion itself
 *  (which has its own suite): that a tick spends a predictable, quota-bounded
 *  number of provider requests, and that one bad category cannot cost the
 *  others their work or trigger a Cloudflare retry of the whole fan-out. */

const fakeDb = {} as Db;
const keys = { newsdata: 'k', guardian: 'k' };

function summary(overrides: Partial<ingestModule.IngestSummary> = {}): ingestModule.IngestSummary {
  return {
    fetched: 10,
    persisted: 4,
    deduplicated: 6,
    clustered: 4,
    sources: 3,
    skippedInvalid: 0,
    undatedArticles: 0,
    failedProviders: [],
    ...overrides,
  };
}

let ingestSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ingestSpy = vi.spyOn(ingestModule, 'ingest');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runScheduledIngest', () => {
  it('ingests every configured category exactly once', async () => {
    ingestSpy.mockResolvedValue(summary());

    const results = await runScheduledIngest(fakeDb, keys);

    expect(ingestSpy).toHaveBeenCalledTimes(CRON_CATEGORIES.length);
    expect(results.map((r) => r.category)).toEqual([...CRON_CATEGORIES]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('spends one ingest call per category — the quota unit the schedule is sized on', async () => {
    ingestSpy.mockResolvedValue(summary());

    await runScheduledIngest(fakeDb, keys, ['top', 'world'], 'en');

    // If this ever fans out per language too, the daily NewsData spend
    // multiplies by 13 and the free tier is gone before noon.
    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(ingestSpy).toHaveBeenCalledWith(fakeDb, keys, { category: 'top', language: 'en' });
    expect(ingestSpy).toHaveBeenCalledWith(fakeDb, keys, { category: 'world', language: 'en' });
  });

  it('defaults to English only', () => {
    expect(CRON_LANGUAGE).toBe('en');
  });

  it('keeps going when one category throws, and never rejects', async () => {
    ingestSpy
      .mockResolvedValueOnce(summary({ persisted: 2 }))
      .mockRejectedValueOnce(new Error('provider exploded'))
      .mockResolvedValueOnce(summary({ persisted: 5 }));

    const results = await runScheduledIngest(fakeDb, keys, ['top', 'india', 'world']);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ category: 'top', ok: true, persisted: 2 });
    expect(results[1]).toMatchObject({ category: 'india', ok: false, error: 'provider exploded' });
    expect(results[2]).toMatchObject({ category: 'world', ok: true, persisted: 5 });
  });

  it('reports a missing database binding instead of throwing', async () => {
    const results = await runScheduledIngest(undefined, keys, ['top', 'world']);

    expect(ingestSpy).not.toHaveBeenCalled();
    expect(results).toEqual([
      { category: 'top', ok: false, error: 'database binding absent' },
      { category: 'world', ok: false, error: 'database binding absent' },
    ]);
  });

  it('surfaces provider failures even when the category itself succeeded', async () => {
    // A dead NewsData key still returns ok:true overall, because RSS carried
    // the run. That must remain visible rather than reading as fully healthy.
    ingestSpy.mockResolvedValue(
      summary({ failedProviders: [{ providerId: 'newsdata', reason: 'rate limited' }] }),
    );

    const [result] = await runScheduledIngest(fakeDb, keys, ['top']);

    expect(result.ok).toBe(true);
    expect(result.failedProviders).toEqual([{ providerId: 'newsdata', reason: 'rate limited' }]);
  });

  it('covers the eight real categories', () => {
    expect([...CRON_CATEGORIES]).toEqual([
      'top',
      'india',
      'world',
      'business',
      'sports',
      'entertainment',
      'technology',
      'health',
    ]);
  });
});
