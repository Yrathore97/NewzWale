/** Presentation metadata for the six verdicts and the four evidence strengths.
 *
 *  SEMANTICS ARE NOT DEFINED HERE. `Verdict`, `EvidenceStrength` and their
 *  meanings live in src/lib/factcheck/schema.ts and are unchanged by P6. This
 *  module maps each existing value to an icon, a label and a visual form, so
 *  that every surface which renders a verdict — badge, chip, history row,
 *  filter chip — renders it identically.
 *
 *  WCAG 1.4.1: colour is never the carrier. Every entry supplies a glyph AND a
 *  text label, and the two amber/orange verdicts additionally differ in FORM.
 *  Amber (`warning`) and orange (`verdict-misleading`) measure 1.24:1 against
 *  each other — asserted in tests/contrast.test.ts — so for a reader with
 *  red-green CVD they are the same colour. `partly_true` is therefore solid and
 *  `misleading` is a 2px outline, and their glyphs differ. Remove that
 *  difference and the most meaning-dense distinction in the product (facts
 *  wrong vs framing wrong) becomes invisible to roughly 8% of Indian men.
 */

import type { EvidenceStrength, Verdict } from '../factcheck/schema';
import { VERDICTS, EVIDENCE_STRENGTHS } from '../factcheck/schema';

export interface VerdictPresentation {
  verdict: Verdict;
  /** Uppercase display label. */
  label: string;
  /** Text glyph. A character, not an icon font: it survives with styles off,
   *  and it is inside aria-hidden markup with the label carrying the meaning. */
  icon: string;
  /** `solid` draws a filled colour chip behind the glyph and a 1px border;
   *  `outline` draws no fill and a 2px border. This is the CVD-safe carrier. */
  form: 'solid' | 'outline';
  /** Tailwind colour token this verdict paints its border and glyph chip with.
   *  Never used for the badge's label text — see the amber assertion in
   *  tests/contrast.test.ts for why. */
  token: string;
  /** LITERAL Tailwind classes. Written out rather than composed as
   *  `border-${token}`, because Tailwind scans source text: an interpolated
   *  class name is never generated and the border silently disappears. */
  borderClass: string;
  /** Classes for the glyph chip: a solid fill for solid verdicts, coloured
   *  text for outline ones. `text-canvas` is the label colour on a fill and is
   *  correct in BOTH themes — canvas is white in light and near-black in dark,
   *  which is the direction the fill inverts too. */
  glyphClass: string;
  /** Screen-reader sentence. Read instead of the bare label so "MISLEADING"
   *  is not heard as a site error. */
  description: string;
}

export const VERDICT_PRESENTATION: Record<Verdict, VerdictPresentation> = {
  true: {
    verdict: 'true',
    label: 'TRUE',
    icon: '✓',
    form: 'solid',
    token: 'success',
    borderClass: 'border border-success',
    glyphClass: 'bg-success text-canvas',
    description: 'True — supported by reliable evidence, as stated.',
  },
  false: {
    verdict: 'false',
    label: 'FALSE',
    icon: '✕',
    form: 'solid',
    token: 'error',
    borderClass: 'border border-error',
    glyphClass: 'bg-error text-canvas',
    description: 'False — contradicted by reliable evidence.',
  },
  partly_true: {
    verdict: 'partly_true',
    label: 'PARTLY TRUE',
    // Half-filled circle: "some of it holds".
    icon: '◐',
    form: 'solid',
    token: 'warning',
    borderClass: 'border border-warning',
    glyphClass: 'bg-warning text-canvas',
    description: 'Partly true — some of the claim holds and some does not.',
  },
  misleading: {
    verdict: 'misleading',
    label: 'MISLEADING',
    icon: '⚠',
    // Outline, deliberately. See the module comment.
    form: 'outline',
    token: 'verdict-misleading',
    borderClass: 'border-2 border-verdict-misleading',
    glyphClass: 'text-verdict-misleading',
    description: 'Misleading — the facts check out but the framing does not.',
  },
  unverified: {
    verdict: 'unverified',
    label: 'UNVERIFIED',
    icon: '?',
    form: 'outline',
    token: 'mute',
    borderClass: 'border-2 border-mute',
    glyphClass: 'text-mute',
    // Styled and worded as an analytical outcome, never as a failure.
    description: 'Unverified — we could not establish this claim either way.',
  },
  needs_context: {
    verdict: 'needs_context',
    label: 'NEEDS CONTEXT',
    icon: 'ⓘ',
    form: 'outline',
    token: 'verdict-context',
    borderClass: 'border-2 border-verdict-context',
    glyphClass: 'text-verdict-context',
    description: 'Needs context — established, but incomplete without a qualification.',
  },
};

/** Never throws and never guesses. An unrecognised value presents as
 *  UNVERIFIED, matching `coerceVerdict` in the schema. */
export function verdictPresentation(value: unknown): VerdictPresentation {
  return (
    VERDICT_PRESENTATION[value as Verdict] ?? VERDICT_PRESENTATION.unverified
  );
}

/** Display order for filter chips and legends: assertions first, then the
 *  qualified verdicts, then the two non-assertive outcomes. */
export const VERDICT_ORDER: readonly Verdict[] = [
  'true',
  'false',
  'partly_true',
  'misleading',
  'needs_context',
  'unverified',
];

// Guards against the schema gaining a seventh verdict without a presentation.
if (VERDICT_ORDER.length !== VERDICTS.length) {
  throw new Error('VERDICT_ORDER is out of sync with VERDICTS');
}

// ---------------------------------------------------------------------------
// Evidence strength
// ---------------------------------------------------------------------------

export interface StrengthPresentation {
  strength: EvidenceStrength;
  label: string;
  /** How many of the four segments are filled. NEVER rendered as a
   *  percentage — a number implies a precision the pipeline does not have
   *  (NEWZWALE_DESIGN_DIRECTION §6.4). */
  filled: number;
  description: string;
}

export const STRENGTH_SEGMENTS = 4;

export const STRENGTH_PRESENTATION: Record<EvidenceStrength, StrengthPresentation> = {
  strong: {
    strength: 'strong',
    label: 'Strong',
    filled: 4,
    description: 'Multiple independent, high-quality sources agree.',
  },
  moderate: {
    strength: 'moderate',
    label: 'Moderate',
    filled: 3,
    description: 'Corroborated, but by fewer or less independent sources.',
  },
  weak: {
    strength: 'weak',
    label: 'Weak',
    filled: 2,
    description: 'Thin or single-source evidence.',
  },
  none: {
    strength: 'none',
    label: 'None',
    filled: 0,
    description: 'No usable evidence was found.',
  },
};

export function strengthPresentation(value: unknown): StrengthPresentation {
  return STRENGTH_PRESENTATION[value as EvidenceStrength] ?? STRENGTH_PRESENTATION.none;
}

if (Object.keys(STRENGTH_PRESENTATION).length !== EVIDENCE_STRENGTHS.length) {
  throw new Error('STRENGTH_PRESENTATION is out of sync with EVIDENCE_STRENGTHS');
}
