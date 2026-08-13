import { describe, expect, it } from 'vitest';
import manifestSource from '../../public/site.webmanifest?raw';

/** P9. NEWZWALE_IMPLEMENTATION_PLAN.md §Phase 9 names four specific defects in
 *  public/site.webmanifest: no `start_url`, no `scope`, no `shortcuts`, and
 *  "**both** icons are `purpose: maskable`, which is wrong for the standard
 *  display context". This file pins each one so a later edit cannot quietly
 *  reintroduce them. */

const manifest = JSON.parse(manifestSource) as {
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
  shortcuts: { name: string; url: string }[];
};

describe('web app manifest', () => {
  it('declares an install scope and start URL', () => {
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  it('has at least one icon usable in the standard display context', () => {
    const any = manifest.icons.filter((i) => (i.purpose ?? 'any').split(' ').includes('any'));
    expect(any.length).toBeGreaterThan(0);
  });

  it('does not declare the existing icons as maskable — they are not', () => {
    // The artwork is a coral tile with its own baked-in rounded corners. Under
    // a square Android mask those corners read as notches, and there is no
    // safe-zone-padded variant in public/ to point at. Claiming `maskable`
    // without that artwork is the defect the plan flagged.
    const maskable = manifest.icons.filter((i) => (i.purpose ?? '').includes('maskable'));
    expect(maskable).toEqual([]);
  });

  it('ships the 192 and 512 PNGs the install flow needs', () => {
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });

  it('points every shortcut at a real in-scope route', () => {
    expect(manifest.shortcuts.length).toBeGreaterThan(0);
    const routes = ['/fact-check', '/trending', '/saved'];
    for (const shortcut of manifest.shortcuts) {
      expect(shortcut.url.startsWith(manifest.scope)).toBe(true);
      expect(routes).toContain(shortcut.url);
    }
  });
});
