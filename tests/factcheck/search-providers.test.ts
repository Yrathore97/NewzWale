import { describe, it, expect, vi } from 'vitest';
import {
  searchEvidence,
  SEARCH_PROVIDERS,
  type SearchProvider,
} from '../../src/lib/factcheck/providers';
import type { SearchHit } from '../../src/lib/factcheck/search';

const hit = (url: string): SearchHit => ({ title: 'T', url, snippet: 's', publishedAt: null });

function stub(id: string, opts: { hits?: SearchHit[]; fail?: boolean; configured?: boolean } = {}): SearchProvider {
  return {
    id,
    isConfigured: () => opts.configured ?? true,
    search: async () => {
      if (opts.fail) throw new Error('provider exploded: https://api.example/search?key=SECRET123');
      return opts.hits ?? [hit(`https://${id}.example/1`)];
    },
  };
}

describe('search provider chain', () => {
  it('registers tavily but does not privilege it structurally', () => {
    expect(SEARCH_PROVIDERS.map((p) => p.id)).toContain('tavily');
    // Behaviour preserved: it is still the only provider today.
    expect(SEARCH_PROVIDERS).toHaveLength(1);
  });

  it('skips unconfigured providers without calling them', async () => {
    const p = stub('paid', { configured: false });
    const spy = vi.spyOn(p, 'search');
    await searchEvidence('q', {}, [p, stub('free')]);
    expect(spy).not.toHaveBeenCalled();
  });

  // A dead provider degrades the evidence set; it must not fail the check.
  it('isolates a failing provider', async () => {
    const out = await searchEvidence('q', {}, [stub('broken', { fail: true }), stub('working')]);
    expect(out.hits).toHaveLength(1);
    expect(out.attempts.find((a) => a.provider === 'broken')!.ok).toBe(false);
  });

  it('returns an empty result rather than throwing when all fail', async () => {
    const out = await searchEvidence('q', {}, [stub('a', { fail: true }), stub('b', { fail: true })]);
    expect(out.hits).toEqual([]);
    expect(out.attempts.every((a) => !a.ok)).toBe(true);
  });

  it('merges results from several providers', async () => {
    const out = await searchEvidence('q', {}, [stub('a'), stub('b')]);
    expect(out.hits.map((h) => h.url).sort()).toEqual([
      'https://a.example/1',
      'https://b.example/1',
    ]);
  });

  it('drops duplicate URLs across providers', async () => {
    const same = hit('https://shared.example/1');
    const out = await searchEvidence('q', {}, [stub('a', { hits: [same] }), stub('b', { hits: [same] })]);
    expect(out.hits).toHaveLength(1);
  });

  // These API keys travel in the request URL, so a raw error message can
  // contain the credential.
  it('never records a secret in an attempt', async () => {
    const out = await searchEvidence('q', { tavily: 'SECRET123' }, [stub('broken', { fail: true })]);
    const serialised = JSON.stringify(out.attempts);
    expect(serialised).not.toContain('SECRET123');
    expect(serialised).not.toContain('api.example');
  });

  it('truncates the query it records', async () => {
    const out = await searchEvidence('x'.repeat(500), {}, [stub('a')]);
    expect(out.attempts[0]!.query.length).toBeLessThanOrEqual(120);
  });

  it('records result counts and duration for observability', async () => {
    const out = await searchEvidence('q', {}, [stub('a')]);
    expect(out.attempts[0]).toMatchObject({ provider: 'a', resultCount: 1, ok: true });
    expect(out.attempts[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
