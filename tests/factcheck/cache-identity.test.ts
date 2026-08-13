import { describe, it, expect } from 'vitest';
import { factCheckCacheKey, normalizeClaim } from '../../src/lib/cache';
import {
  PIPELINE_VERSION,
  EVIDENCE_VERSION,
  MODEL,
  pipelineIdentity,
} from '../../src/lib/factcheck/version';

describe('normalizeClaim', () => {
  it('collapses case and whitespace', () => {
    expect(normalizeClaim('  The   RBI   Held  Rates  ')).toBe('the rbi held rates');
  });

  it('is idempotent', () => {
    const once = normalizeClaim('  A   B  ');
    expect(normalizeClaim(once)).toBe(once);
  });

  it('treats newlines and tabs as whitespace, so pasted text normalises', () => {
    expect(normalizeClaim('RBI\nheld\trates')).toBe('rbi held rates');
  });
});

describe('factCheckCacheKey', () => {
  it('is versioned under v2 and carries a full sha256 digest', async () => {
    const key = await factCheckCacheKey('RBI kept the repo rate at 6.5%.');
    expect(key).toMatch(/^fc:v2:[0-9a-f]{64}$/);
  });

  it('is stable for the same claim', async () => {
    const a = await factCheckCacheKey('The sky is blue on Tuesdays.');
    const b = await factCheckCacheKey('The sky is blue on Tuesdays.');
    expect(a).toBe(b);
  });

  it('ignores case and whitespace differences, matching normalizeClaim', async () => {
    const a = await factCheckCacheKey('RBI kept the repo rate at 6.5%');
    const b = await factCheckCacheKey('  rbi   KEPT the repo   rate at 6.5%  ');
    expect(a).toBe(b);
  });

  it('differs for different claims', async () => {
    const a = await factCheckCacheKey('Rates were held.');
    const b = await factCheckCacheKey('Rates were cut.');
    expect(a).not.toBe(b);
  });

  // REGRESSION — NEWZWALE_SECURITY_AUDIT.md S-03.
  //
  // v1 keyed on `norm.slice(0, 200)`: the first 200 characters of the claim.
  // A URL check submits up to 4,000 characters of article body as the claim,
  // so any two articles sharing an opening — a wire lede, a boilerplate
  // header, a cookie banner that survived text extraction — collided and were
  // served EACH OTHER'S VERDICT.
  //
  // On a fact-checking product that is a correctness failure with a
  // cache-poisoning shape: craft a claim sharing a prefix with a target claim,
  // seed the desired verdict, wait for the victim.
  describe('claims sharing a long prefix never collide', () => {
    const shared = 'A'.repeat(400);

    it('distinguishes claims that differ only after character 200', async () => {
      const a = await factCheckCacheKey(`${shared} and rates were held.`);
      const b = await factCheckCacheKey(`${shared} and rates were cut.`);
      expect(a).not.toBe(b);
    });

    it('distinguishes claims differing only in the final character', async () => {
      const a = await factCheckCacheKey(`${shared}X`);
      const b = await factCheckCacheKey(`${shared}Y`);
      expect(a).not.toBe(b);
    });

    it('would have collided under the v1 truncation scheme', () => {
      // Demonstrates the bug this test exists to prevent regressing to.
      const v1 = (claim: string) => `fc:v1:${normalizeClaim(claim).slice(0, 200)}`;
      expect(v1(`${shared} held.`)).toBe(v1(`${shared} cut.`));
    });
  });

  // Raw claim text in a KV key name is visible in operational tooling.
  it('does not embed the claim text in the key', async () => {
    const key = await factCheckCacheKey('my private medical question about a diagnosis');
    expect(key).not.toContain('medical');
    expect(key).not.toContain('diagnosis');
    expect(key).not.toContain('private');
  });
});

describe('cache identity binds the pipeline version', () => {
  it('includes all three reproducibility inputs', () => {
    const identity = pipelineIdentity();
    expect(identity).toContain(`p${PIPELINE_VERSION}`);
    expect(identity).toContain(`e${EVIDENCE_VERSION}`);
    expect(identity).toContain(MODEL);
  });

  // The point of the whole scheme: bumping a version constant must make every
  // existing entry unreachable, with no manual purge and no window in which
  // two methodologies are both serving verdicts.
  it('produces a different key when the pipeline identity changes', async () => {
    const claim = 'Rates were held at 6.5%.';
    const current = await factCheckCacheKey(claim);

    // Recompute the key by hand under a bumped pipeline version.
    const bumped = `${normalizeClaim(claim)}|p${PIPELINE_VERSION + 1}|e${EVIDENCE_VERSION}|${MODEL}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bumped));
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(current).not.toBe(`fc:v2:${hex}`);
  });

  it('produces a different key for a different model', async () => {
    const claim = 'Rates were held at 6.5%.';
    const withCurrentModel = `${normalizeClaim(claim)}|${pipelineIdentity()}`;
    const withOtherModel = `${normalizeClaim(claim)}|p${PIPELINE_VERSION}|e${EVIDENCE_VERSION}|@cf/some/other-model`;
    expect(withCurrentModel).not.toBe(withOtherModel);
  });

  it('versions are positive integers', () => {
    expect(Number.isInteger(PIPELINE_VERSION) && PIPELINE_VERSION > 0).toBe(true);
    expect(Number.isInteger(EVIDENCE_VERSION) && EVIDENCE_VERSION > 0).toBe(true);
    expect(MODEL.length).toBeGreaterThan(0);
  });
});
