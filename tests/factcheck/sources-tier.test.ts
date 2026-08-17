import { describe, it, expect } from 'vitest';
import { profileFor, tierFor } from '../../src/lib/factcheck/sources';

/** Tier is PROVENANCE, and it is load-bearing: `hasCorroboratingTier` in
 *  gate.ts refuses an assertive verdict on tier-3-only evidence. Getting a
 *  primary source wrong therefore suppresses verdicts it should support. */

describe('tier assignment', () => {
  it('treats the Reserve Bank of India as a primary source', () => {
    // Found in production: rbi.org.in came back tier3, so the central bank
    // counted as low-reliability on its own policy rate.
    expect(tierFor('https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx')).toBe('tier1');
    expect(profileFor('rbi.org.in').displayName).toBe('Reserve Bank of India');
  });

  it('does NOT grant tier 1 to .org.in generally', () => {
    // The reason rbi.org.in is a curated entry rather than a suffix rule:
    // `.org.in` is open registration. A suffix rule would hand the strongest
    // provenance signal we have to anyone who registers one.
    expect(tierFor('https://some-campaign-group.org.in/post')).toBe('tier3');
    expect(tierFor('https://randomngo.org.in')).toBe('tier3');
  });

  it('still resolves genuine government suffixes without a curated entry', () => {
    expect(tierFor('https://pib.gov.in/PressRelease')).toBe('tier1');
    expect(tierFor('https://somedept.nic.in/x')).toBe('tier1');
  });

  it('leaves an unknown publisher at the conservative default', () => {
    expect(tierFor('https://unknown-blog.example/post')).toBe('tier3');
  });
});
