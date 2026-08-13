import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  AA_NORMAL_TEXT,
  AA_LARGE_TEXT,
  AA_UI_COMPONENT,
} from '../src/lib/contrast';

/** The Subtle Gradient palette, mirroring the @theme block in src/styles/global.css.
 *  If a colour changes there, change it here — these tests are the gate that
 *  stops an unreadable palette from shipping. */
const LIGHT = {
  canvas: '#ffffff',
  surfaceSoft: '#faf9f7',
  surfaceCard: '#f4f3ef',
  surfaceElevated: '#ffffff',
  ink: '#111111',
  body: '#3a3a35',
  mute: '#686860',
  primary: '#ff6b57',
  primaryStrong: '#cc4430',
  onPrimary: '#ffffff',
  success: '#2f7d4f',
  error: '#c0392b',
  warning: '#a86a1c',
  verdictMisleading: '#a8500f',
  verdictContext: '#1a5fb4',
};

const DARK = {
  canvas: '#1a1a18',
  surfaceSoft: '#232320',
  surfaceCard: '#2d2d29',
  surfaceElevated: '#2d2d29',
  ink: '#f5f4f1',
  body: '#c9c8c2',
  mute: '#9a9a94',
  primary: '#ff8b7a',
  onPrimary: '#1a1a18',
  success: '#6ec48f',
  error: '#f08a7d',
  warning: '#e0b070',
  verdictMisleading: '#f0a868',
  verdictContext: '#8ab4f8',
};

/** The four surfaces a verdict badge can land on, per NEWZWALE_DESIGN_DIRECTION
 *  §2.2. surfaceElevated duplicates another value in each theme today; it is
 *  listed explicitly anyway so that re-pointing it later cannot quietly escape
 *  the gate. */
const LIGHT_SURFACES = [
  LIGHT.canvas,
  LIGHT.surfaceSoft,
  LIGHT.surfaceCard,
  LIGHT.surfaceElevated,
];
const DARK_SURFACES = [DARK.canvas, DARK.surfaceSoft, DARK.surfaceCard, DARK.surfaceElevated];

describe('sanity checks against known values', () => {
  it('black on white is 21:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });
  it('is order independent', () => {
    expect(contrastRatio('#111111', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#111111'), 5);
  });
});

describe('the raw coral is NOT safe for white text', () => {
  // This is why primaryStrong exists. Documented as a test so nobody
  // "simplifies" it back to the raw brand coral later.
  it('fails AA for normal text, which is the whole reason we darken it', () => {
    expect(contrastRatio(LIGHT.primary, '#ffffff')).toBeLessThan(AA_NORMAL_TEXT);
  });
});

describe('light mode text passes WCAG AA', () => {
  const surfaces = [LIGHT.canvas, LIGHT.surfaceSoft, LIGHT.surfaceCard];

  it('ink on every surface', () => {
    for (const s of surfaces) {
      expect(contrastRatio(LIGHT.ink, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('body text on every surface', () => {
    for (const s of surfaces) {
      expect(contrastRatio(LIGHT.body, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('muted text on every surface', () => {
    for (const s of surfaces) {
      expect(contrastRatio(LIGHT.mute, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('white label on the darkened coral button', () => {
    expect(contrastRatio(LIGHT.onPrimary, LIGHT.primaryStrong)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('coral link text on canvas', () => {
    expect(contrastRatio(LIGHT.primaryStrong, LIGHT.canvas)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('the raw coral is still usable for large decorative shapes', () => {
    expect(contrastRatio(LIGHT.primary, LIGHT.canvas)).toBeGreaterThanOrEqual(2.5);
  });
});

describe('dark mode text passes WCAG AA', () => {
  const surfaces = [DARK.canvas, DARK.surfaceSoft, DARK.surfaceCard];

  it('ink on every surface', () => {
    for (const s of surfaces) {
      expect(contrastRatio(DARK.ink, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('body text on every surface', () => {
    for (const s of surfaces) {
      expect(contrastRatio(DARK.body, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('muted text on canvas and soft surfaces', () => {
    expect(contrastRatio(DARK.mute, DARK.canvas)).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
    expect(contrastRatio(DARK.mute, DARK.surfaceSoft)).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
  });

  it('lifted coral reads as link text on dark surfaces', () => {
    for (const s of surfaces) {
      expect(contrastRatio(DARK.primary, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('dark ink label on the lifted coral button', () => {
    expect(contrastRatio(DARK.onPrimary, DARK.primary)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

// ---------------------------------------------------------------------------
// P6 verdict colours.
//
// Two colours were added to the palette and nothing else: MISLEADING (orange)
// and NEEDS_CONTEXT (blue). NEWZWALE_DESIGN_DIRECTION.md §2.2 requires every
// pairing against canvas / surface-soft / surface-card / surface-elevated, in
// both themes, to be asserted here BEFORE the colour ships. That is 4 surfaces
// x 2 colours x 2 themes = 16 pairings, and they are all below.
// ---------------------------------------------------------------------------

describe('P6: the two new verdict colours clear AA on every surface', () => {
  it('MISLEADING orange, light theme, all four surfaces', () => {
    for (const s of LIGHT_SURFACES) {
      expect(contrastRatio(LIGHT.verdictMisleading, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('MISLEADING orange, dark theme, all four surfaces', () => {
    for (const s of DARK_SURFACES) {
      expect(contrastRatio(DARK.verdictMisleading, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('NEEDS_CONTEXT blue, light theme, all four surfaces', () => {
    for (const s of LIGHT_SURFACES) {
      expect(contrastRatio(LIGHT.verdictContext, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });

  it('NEEDS_CONTEXT blue, dark theme, all four surfaces', () => {
    for (const s of DARK_SURFACES) {
      expect(contrastRatio(DARK.verdictContext, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});

describe('P6: reused verdict colours on the surfaces badges actually use', () => {
  // TRUE, FALSE and UNVERIFIED reuse success / error / mute. Asserted because
  // P6 puts them on surface-card for the first time, which is darker than the
  // canvas they were originally measured against.
  it('success, error and mute carry text on every light surface', () => {
    for (const c of [LIGHT.success, LIGHT.error, LIGHT.mute]) {
      for (const s of LIGHT_SURFACES) {
        expect(contrastRatio(c, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
  });

  it('success, error and mute carry text on every dark surface', () => {
    for (const c of [DARK.success, DARK.error]) {
      for (const s of DARK_SURFACES) {
        expect(contrastRatio(c, s)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      }
    }
    // mute is the deliberate exception, as it already is in light mode: it is
    // large/secondary text only.
    for (const s of DARK_SURFACES) {
      expect(contrastRatio(DARK.mute, s)).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
    }
  });

  // This one is a constraint discovery, not a preference. PARTLY_TRUE reuses
  // `warning`, and `warning` peaks at 4.43:1 on white and 3.99:1 on
  // surface-card. It therefore CANNOT carry normal-size text in light mode, in
  // either direction, and the token layer is frozen so it cannot be darkened.
  //
  // That is precisely why VerdictBadge puts the label in `ink` on a neutral
  // surface and lets the verdict colour carry only the border and the icon
  // chip, which are non-text UI and need 3:1. Pinned so that a later "just make
  // the label amber" change fails loudly here instead of shipping.
  it('amber cannot carry normal-size text in light mode, so badges never ask it to', () => {
    expect(contrastRatio(LIGHT.warning, LIGHT.surfaceCard)).toBeLessThan(AA_NORMAL_TEXT);
    expect(contrastRatio(LIGHT.onPrimary, LIGHT.warning)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('amber is still legible as a border and icon fill, which is all it carries', () => {
    for (const s of LIGHT_SURFACES) {
      expect(contrastRatio(LIGHT.warning, s)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    }
    for (const s of DARK_SURFACES) {
      expect(contrastRatio(DARK.warning, s)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    }
  });
});

describe('P6: verdict badges must not rely on colour alone', () => {
  // WCAG 1.4.1. Roughly 8% of Indian men have red-green CVD, for whom amber and
  // orange collapse toward each other. These two assertions are the arithmetic
  // proof that hue cannot be the carrier, and therefore the justification for
  // the fill/border/glyph differences in .verdict-solid vs .verdict-outline.
  it('PARTLY_TRUE amber and MISLEADING orange are nearly indistinguishable by hue', () => {
    expect(contrastRatio(LIGHT.warning, LIGHT.verdictMisleading)).toBeLessThan(AA_UI_COMPONENT);
    expect(contrastRatio(DARK.warning, DARK.verdictMisleading)).toBeLessThan(AA_UI_COMPONENT);
  });

  it('MISLEADING orange is also close to the brand coral it must never sit beside', () => {
    expect(contrastRatio(LIGHT.verdictMisleading, LIGHT.primaryStrong)).toBeLessThan(
      AA_UI_COMPONENT,
    );
  });

  // The badge label is ink on a neutral surface in every verdict, so it is
  // readable regardless of which verdict colour is in play.
  it('the badge label is readable on the neutral badge surface for every verdict', () => {
    expect(contrastRatio(LIGHT.ink, LIGHT.surfaceCard)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrastRatio(DARK.ink, DARK.surfaceCard)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  // Solid-variant badges put a white glyph inside a verdict-coloured chip.
  // A glyph is a non-text UI component: 3:1.
  it('a white glyph is legible inside every light-theme solid chip', () => {
    for (const c of [LIGHT.success, LIGHT.error, LIGHT.warning]) {
      expect(contrastRatio('#ffffff', c)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    }
  });

  it('a dark glyph is legible inside every dark-theme solid chip', () => {
    for (const c of [DARK.success, DARK.error, DARK.warning]) {
      expect(contrastRatio(DARK.canvas, c)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    }
  });
});

describe('P6: evidence stance borders', () => {
  // 3px left borders per NEWZWALE_DESIGN_DIRECTION §2.3. Non-text UI: 3:1.
  it('supporting, contradicting and contextual borders are visible on cards', () => {
    for (const c of [LIGHT.success, LIGHT.error, LIGHT.mute]) {
      expect(contrastRatio(c, LIGHT.surfaceCard)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
      expect(contrastRatio(c, LIGHT.surfaceElevated)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    }
    for (const c of [DARK.success, DARK.error, DARK.mute]) {
      expect(contrastRatio(c, DARK.surfaceCard)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
      expect(contrastRatio(c, DARK.surfaceElevated)).toBeGreaterThanOrEqual(AA_UI_COMPONENT);
    }
  });
});
