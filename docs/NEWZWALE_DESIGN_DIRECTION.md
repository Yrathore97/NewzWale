# NewzWale — Design Direction

**Date:** 2026-08-08
**Status:** ⛔ **APPROVAL GATE.** No UI implementation code is written until this
document is approved.
**Token authority:** [`DESIGN.md`](../DESIGN.md) +
[`src/styles/global.css`](../src/styles/global.css) remain the source of truth
for existing tokens. This document *extends* them; it does not replace them.

Method: generated with the `ui-ux-pro-max` skill, then **filtered against the
locked constraints**. What the tool proposed and why parts of it were rejected
is recorded in §9 — the rejections are as important as the adoptions.

---

## 1. Product personality

> **Discover the news quickly. Verify what you see deeply.**

NewzWale is a **serious Indian information platform**, not an AI product.
The interface's job is to make evidence legible, not to look intelligent.

| Is | Is not |
|---|---|
| Editorial, like a well-set newspaper | App-like, like a dashboard |
| Calm — colour carries meaning, not mood | Vibrant, gradient-heavy |
| Dense — respects the reader's time | Airy marketing layout |
| Transparent — shows its work | Confident — asserts an answer |
| Original | An Inshorts clone, a ChatGPT clone, a SaaS template |

**The governing tension:** every visual decision competes with evidence for
attention. When in doubt, the evidence wins. A fact-check result page with
beautiful chrome and cramped citations has failed regardless of how it looks.

### Two surfaces, two densities

| | NEWS (discovery) | FACT CHECK (verification) |
|---|---|---|
| Mode | Scan | Read |
| Density | **High** — 8/10 | **Moderate** — 5/10 |
| Type scale | Compact, tight leading | Generous, comfortable measure |
| Spacing | 8/12/16/24 | 16/24/32/48 |
| Motion | None beyond state changes | None beyond state changes |
| Goal | Get to the story fast | Understand *why* |

This is the single most important structural idea here: **the two surfaces are
deliberately not the same density.** Using one rhythm for both would make news
feel bloated or evidence feel cramped.

---

## 2. Colour

### 2.1 Base palette — unchanged, locked

The existing warm-neutral + coral system is retained in full. It is documented
in [`DESIGN.md`](../DESIGN.md) and asserted by `tests/contrast.test.ts`.

Reminder of the contract that must not be violated:
- `primary` `#ff6b57` is **decorative only** — 2.8:1 on white, fails AA.
- `primary-strong` `#cc4430` is the text-safe coral — 4.73:1 on white.

### 2.2 Verdict colours — new, and there is a problem to solve

Six verdicts need six treatments. Part 20 forbids colour-alone signalling, so
every verdict = **colour + icon + text label**, always.

| Verdict | Hue intent | Proposed light | Proposed dark | Icon | Form |
|---|---|---|---|---|---|
| TRUE | Green | `--verdict-true` ≈ `#2f7d4f` (reuse `success`) | `#6ec48f` | ✓ | Solid fill |
| FALSE | Red | `--verdict-false` ≈ `#c0392b` (reuse `error`) | `#f08a7d` | ✕ | Solid fill |
| PARTLY_TRUE | Amber | `--verdict-partly` ≈ `#a86a1c` (reuse `warning`) | `#e0b070` | ◐ | Solid fill |
| MISLEADING | Orange | `--verdict-misleading` **needs a new value** | new | ⚠ | **Outline + heavier border** |
| UNVERIFIED | Neutral | `--verdict-unverified` ≈ `mute` on `surface-card` | same tokens | ? | Outline |
| NEEDS_CONTEXT | Blue | `--verdict-context` **new** | new | ⓘ | Outline |

#### ⚠ Unresolved: the brand collides with a verdict

**NewzWale's brand accent is coral-orange (`#cc4430`). MISLEADING wants
orange.** Placing an orange verdict badge next to coral brand chrome produces
two failures at once: the verdict reads as decoration, and the brand reads as a
warning.

Compounding it, amber (`#a86a1c`) and orange sit ~2 hue steps apart — and
PARTLY_TRUE vs MISLEADING is the **most meaning-dense distinction in the whole
system** (facts wrong vs framing wrong). Roughly 8% of Indian men have red-green
CVD, for whom amber/orange/red collapse toward each other.

Three ways out, in my order of preference:

| Option | Approach | Trade-off |
|---|---|---|
| **A (recommended)** | Keep amber/orange but make them differ in **form, not just hue**: PARTLY_TRUE solid-filled, MISLEADING outline with a 2px border and a distinct icon. Additionally, **verdict badges never sit adjacent to coral brand chrome** | Requires layout discipline; safest for CVD |
| B | Move MISLEADING to a non-orange hue (deep magenta/plum) | Breaks the intuitive warm=caution gradient |
| C | Desaturate brand coral wherever a verdict is present | Weakens brand consistency |

**This needs your decision at the gate.** Whichever is chosen, all four new
values (misleading light/dark, context light/dark) get contrast assertions
against `canvas`, `surface-soft`, `surface-card`, `surface-elevated` in both
themes — **16 pairings per colour, tested before the colour ships.** That is an
existing repo convention, not a new rule.

### 2.3 Evidence stance colours

Distinct from verdicts, and deliberately quieter — stance is metadata, not a
conclusion.

| Stance | Treatment |
|---|---|
| Supporting | Left border in `success`, 3px |
| Contradicting | Left border in `error`, 3px |
| Contextual | Left border in `mute`, 3px |

Never a filled background. Filled cards would make the evidence list look like
six competing alerts and would out-shout the verdict.

---

## 3. Typography

### 3.1 Proposed change: add a serif for editorial voice

Current: Inter (all) + JetBrains Mono (captions). The `ui-ux-pro-max`
typography domain returned **"News Editorial — Newsreader / Roboto"** as its
top match for `news editorial journalism trustworthy readable`, noting
*"Newsreader designed for long-form reading"*.

**Adopt the idea, not the pairing.** Roboto adds nothing over Inter and would
cost a font swap across the whole product for no gain.

| Role | Font | Rationale |
|---|---|---|
| Headlines, verdict statements, claim text | **Newsreader** (serif) | Editorial authority; a serif headline reads as *journalism*, a sans headline reads as *app*. This is the single highest-leverage change to product personality |
| UI, body, labels, navigation | **Inter** (unchanged) | Already in place, excellent at small sizes |
| Metadata, datelines, source labels, timestamps | **JetBrains Mono** (unchanged) | Existing `.font-mono-caption`; tabular figures matter for dates and counts |

**Rejected:** Libre Bodoni (too high-contrast for Indian-language fallbacks),
Cormorant Garamond (too literary for a news product).

**Load cost.** Newsreader is a third family. Mitigated by **self-hosting all
three with `font-display: swap`** and subsetting — which also removes the
render-blocking Google Fonts `@import` at
[`global.css:1`](../src/styles/global.css) and one third-party CSP origin.
Net result: likely *faster* than today, despite one more family.

**Indic scripts.** Newsreader does not cover Devanagari, Tamil, Telugu, Bengali,
etc. Headlines in the 12 non-English content languages must fall back to a
matching Noto family. **Verify per script before shipping** — an unstyled
fallback on a Hindi headline is worse than using Inter everywhere.

### 3.2 Scale

| Token | Size / line-height | Font | Use |
|---|---|---|---|
| `display` | 40/1.1, -0.02em | Newsreader 600 | Story page headline, verdict statement |
| `headline` | 28/1.2, -0.01em | Newsreader 600 | Section headings, lead card |
| `title` | 20/1.3 | Newsreader 600 | Card headlines (lead) |
| `card` | 17/1.35 | Inter 600 | Card headlines (grid) — sans at small sizes |
| `body` | 16/1.6 | Inter 400 | Reading text, explanations |
| `body-compact` | 15/1.5 | Inter 400 | News summaries |
| `label` | 13/1.4 | Inter 500 | UI labels, buttons |
| `caption` | 12/1.4, 0.05em, uppercase | JetBrains Mono | Metadata (existing `.font-mono-caption`) |

Body never below **16px** on mobile — smaller triggers iOS auto-zoom on inputs
and fails the readable-font-size guideline.

**No `clamp(3rem, 10vw, 12rem)` display type.** The skill proposed it; Part 13
forbids giant hero sections. Rejected.

---

## 4. Spacing, geometry, elevation

**Spacing** — Tailwind's stock numeric scale, as today. `DESIGN.md` documents
why `--spacing-*` tokens must never be added to `@theme` (it silently redefines
`max-w-*` and has already broken a layout once). That constraint holds.

Applied rhythm:
- News surfaces: `2 / 3 / 4 / 6` (8/12/16/24px)
- Fact-check surfaces: `4 / 6 / 8 / 12` (16/24/32/48px)

**Geometry** — existing scale retained: `rounded-sm` 8px, `rounded-md` 16px,
`rounded-lg` 32px. Note `@theme` overrides Tailwind's defaults here.

Part 13 says avoid excessive rounded cards. Applied: **news cards move to
`rounded-sm` (8px)**, not 16px. Tighter corners read as editorial; large radii
read as app-like. `rounded-lg` (32px) is reserved for full-bleed hero panels
and used sparingly.

**Elevation** — the existing `.shadow-stacked-sm|md|lg` ladder is retained.
Evidence cards use **borders, not shadows**. A list of eight shadowed evidence
cards is visual noise; a list of eight bordered ones is a document.

---

## 5. Motion

Restrained by policy, not by taste.

| Interaction | Duration | Easing |
|---|---|---|
| Hover / focus | 150ms | ease-out |
| Press | 100ms | ease-out |
| Drawer / sheet | 250ms in / 180ms out | ease-out / ease-in |
| Scroll reveal | 300ms | ease-out |
| Pipeline stage tick | 200ms | ease-out |

Rules:
- **`prefers-reduced-motion` is honoured** — the existing block in
  `global.css:325` already collapses transitions and stops the marquee. Extend,
  never bypass.
- Exit is faster than entry (~65%).
- Nothing animates on the fact-check **result** page except stage transitions.
  Evidence does not fade in dramatically; it is already the point.
- No parallax. No scroll-jacking. No number count-ups.

**GSAP is rejected.** The skill's motion tier suggested a GSAP ScrollTrigger
snippet. Every effect above is achievable with CSS transitions and
`IntersectionObserver`. Adding an animation library to a 4-dependency project
for a 300ms fade would violate Part 17.

---

## 6. Component language

### 6.1 News card

`rounded-sm`, 1px `hairline` border, `surface-elevated`, no shadow at rest,
`shadow-stacked-sm` on hover.

```
┌────────────────────────────────────────┐
│ [16:9 thumbnail, reserved box]    [♡]  │
├────────────────────────────────────────┤
│ BUSINESS · The Hindu · 2h ago          │  mono caption, 12px
│                                        │
│ Headline up to three lines with tight  │  Inter 600 17px
│ leading and no rewriting                │
│                                        │
│ Grounded summary, two lines, clamped.  │  Inter 400 15px
├────────────────────────────────────────┤
│ 3 min · Also in 4 sources    ✓ Checked │  value row — the differentiator
└────────────────────────────────────────┘
```

The **value row** is what makes this card NewzWale's rather than any
aggregator's: coverage breadth and fact-check availability. Both are suppressed
entirely when not genuinely known — never a placeholder, never a zero.

### 6.2 Verdict badge

```
┌──────────────────────┐   ┌──────────────────────┐
│ ✓  TRUE              │   │ ⚠  MISLEADING        │
└──────────────────────┘   └──────────────────────┘
   solid fill                 outline, 2px border
```
Icon + label + colour, always all three. Never icon-only. Never colour-only.
Minimum 44×44px tap area when interactive.

### 6.3 Evidence card

```
┃ [1]  The Hindu          Tier 2 · Secondary      ← publisher + tier
┃      Published 4 Aug 2026 · Accessed 8 Aug 2026 ← both dates, per principle 7
┃      Read in full                               ← or "Snippet only"
┃
┃      "The exact quoted passage the verdict
┃       relied on, verbatim."
┃
┃      Why it matters: directly addresses the
┃      repo-rate figure in the claim.
┃                                    Open source ↗
```
Left border 3px carries the stance. Everything else is neutral. **Contradicting
evidence uses the identical card treatment as supporting** — no visual
demotion, no accordion, no "show more".

### 6.4 Evidence strength meter

Four discrete segments + text label. **Never a percentage** — a number implies
a precision this pipeline does not have.

```
Evidence  ●●●○  Moderate
```

### 6.5 Pipeline progress

Reflects real stages only (Part 10). A stage that did not run shows as skipped,
not as complete.

```
✓ Searching                    0.8s
✓ Collecting sources — 5 found 2.1s
◐ Evaluating evidence… 3 of 5
○ Comparing sources
○ Checking context
○ Generating verdict
```

---

## 7. Navigation

**Mobile** — bottom tab bar, 56px + safe-area:
`Home · Trending · Fact Check · Search · You`

Fact Check occupies the **centre** slot, visually weighted. It replaces the
current floating CTA, which is `hidden sm:flex` — hidden on exactly the screens
where it matters most.

Chrome budget: 56px top bar + 44px category strip (hides on scroll-down) + 56px
bottom nav. **~100px persistent, down from ~138px today**, and 56px while
actively reading.

**Desktop** — single 64px header, same five destinations. Category strip below.
The two experiences must not diverge conceptually.

All overlays (drawer, popover, sheet) share **one `Dialog` primitive**: focus
moves in, is trapped, returns on close; Escape closes; `role="dialog"` +
`aria-modal`; background scroll locked. One correct implementation replaces
three incomplete ones.

---

## 8. Homepage structure

Per Part 18. Product functionality visible immediately — **not** a marketing
landing page.

```
┌──────────────────────────────────────────────┐
│ Know the news. Check the claim.              │  ≤ 2 lines, Newsreader
│                                              │
│ ┌──────────────────────────────────────┐    │
│ │ Paste a claim, headline, or link…    │    │  ← WORKING input,
│ └──────────────────────────────────────┘    │    not a link to one
│ [ Fact Check a Claim ]  [ Explore News ↓ ]  │
└──────────────────────────────────────────────┘   ≤ 55vh mobile
  ↓ Latest / Breaking
  ↓ Trending
  ↓ Recently Fact-Checked      ← real results from D1, never mocks
  ↓ Why NewzWale               ← brief
  ↓ Methodology                → /methodology
  ↓ CTA · Footer
```

Non-negotiable: **"Recently Fact-Checked" renders real completed checks with
real verdicts.** Illustrative or mock verdicts on a fact-checking product's
homepage would be self-refuting.

---

## 9. What the design tool proposed, and what was rejected

Recorded so these are not re-proposed later.

`ui-ux-pro-max --design-system --variance 3 --motion 3 --density 8` returned:

| Proposal | Decision | Reason |
|---|---|---|
| Typography: **Newsreader / Roboto** | ⚠️ **Partially adopted** | Newsreader for headlines — genuinely right for a news product. Roboto rejected: no gain over incumbent Inter |
| Density 8 spacing scale | ✅ **Adopted for news** | Matches the scan-mode requirement. Fact-check stays at ~5 |
| Motion: Scroll Reveal, 300–400ms, subtle | ✅ **Adopted, re-implemented** | Right timing. Delivered in CSS + `IntersectionObserver`, not GSAP |
| Style: **Exaggerated Minimalism** | ❌ **Rejected** | "Oversized typography, statement design" directly contradicts Part 13 |
| `font-size: clamp(3rem, 10vw, 12rem)`, weight 900 | ❌ **Rejected** | Part 13 forbids giant hero sections |
| Accent `#EC4899` (pink) | ❌ **Rejected** | Brand coral is locked by Part 13 and by 110 lines of contrast tests |
| Base `#18181B` / `#FAFAFA` (cool neutral) | ❌ **Rejected** | NewzWale's base is *warm* neutral. Locked |
| Pattern: **Bento Grid Showcase** | ❌ **Rejected** | A showcase grid is a marketing pattern; Part 18 requires functionality visible immediately |

The tool optimises for a striking landing page. NewzWale is optimising for a
**working information product**. Where those diverged, the brief won — which is
the correct outcome, and the reason this section exists rather than a silent
adoption.

---

## 10. Accessibility floor

Non-negotiable, all verified before the gate closes on any UI phase:

- Verdicts: colour **+ icon + text**, never colour alone
- Contrast: every new pairing asserted in `tests/contrast.test.ts`, both themes
- `<html lang>` follows content language; `dir="rtl"` for Urdu (currently
  hardcoded `en` across 13 languages — a live defect)
- Full keyboard operability; visible focus everywhere (already true, extend it)
- Accessible dialogs: focus trap, Escape, focus return, `aria-modal`
- Bottom nav: correct tab order, `aria-current`, visible focus
- Complete ARIA tabs pattern with arrow keys where tabs remain
- `prefers-reduced-motion` honoured
- Touch targets ≥ 44×44px
- No horizontal scroll at 320px
- `aria-live="polite"` on pipeline stage transitions

---

## 11. Responsive breakpoints

| Width | Layout |
|---|---|
| 320 | 1 col, 12px gutters — the hard floor, no horizontal scroll |
| 375 / 390 / 414 | 1 col, 16px gutters, bottom nav |
| 768 | 2 col, bottom nav retained |
| 1024 | 3 col, header nav replaces bottom nav, sidebar appears |
| 1280 | 3 col + 300px sidebar |
| 1440+ | Same, `max-w-[1400px]` centred |

**Mobile-first authoring**: base styles are the phone layout; `sm:`/`lg:` add.
This inverts current practice and is a real change in how the CSS is written,
not merely where breakpoints sit.

Landscape and safe-area insets tested on a real device, not only in devtools.

---

## 12. Gate checklist

Approve or amend each before any Phase 6 code:

- [ ] Product personality and the two-density model (§1)
- [ ] **Verdict colour collision — choose Option A, B, or C (§2.2)**
- [ ] Evidence stance treatment (§2.3)
- [ ] **Newsreader for headlines — accept the third font family? (§3.1)**
- [ ] Indic-script fallback verification plan (§3.1)
- [ ] Type scale (§3.2)
- [ ] News cards move to `rounded-sm` (§4)
- [ ] Motion budget; GSAP stays rejected (§5)
- [ ] Card, badge, evidence, meter, progress components (§6)
- [ ] Bottom nav with Fact Check centred (§7)
- [ ] Homepage structure, incl. real fact-checks only (§8)
- [ ] The rejection list stands (§9)
- [ ] Accessibility floor (§10)
- [ ] Breakpoints (§11)
