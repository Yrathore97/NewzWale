# NewzWale — UI/UX Specification

**Date:** 2026-08-08
**Status:** Proposal. Awaiting approval. **No UI has been changed.**

**Token authority:** [`DESIGN.md`](../DESIGN.md) and
[`src/styles/global.css`](../src/styles/global.css) remain the single source of
truth for colour, type, spacing, radius, elevation, and the accessibility
contract. This document specifies **composition, layout, states, and
interaction** — it does not restate or override tokens.

Current UI audit: [`NEWZWALE_AUDIT.md`](NEWZWALE_AUDIT.md) §5.

---

## 1. Design direction

**"Know What's True. Not Just What's Trending."** — the interface must make
*true* feel more prominent than *trending*.

Five rules, in priority order:

1. **Evidence is the interface.** On any fact-check screen, evidence occupies
   more space than the verdict. A badge is a summary, not an answer.
2. **Editorial, not app-chrome.** Content carries the page; UI recedes.
   Warm neutrals, generous type, thin rules, restrained colour.
3. **Density with air.** High information density is the goal — achieved by
   tightening *metadata*, never by tightening headlines.
4. **One card, one story.** Fixed metadata positions so the eye learns the
   pattern once and stops re-parsing.
5. **Honest states.** Loading looks like loading; empty says what is empty;
   errors say what failed. Nothing implies work that did not happen.

### Reference use

Short-form news apps are studied for *principles only*: typographic scale
relationships, spacing rhythm, breakpoint behaviour, modular card
architecture, hierarchy technique, and interaction affordances.

**Not copied:** layouts, palettes, iconography, illustration style, motion
signatures, copy, or brand feel. NewzWale's identity is the existing
warm-neutral coral editorial system — that stays, and the compositions around
it change.

*(The `ui-ux-pro-max` skill is installed and available for component-level
exploration during implementation. It must not be used to re-derive the
palette or type scale — those are fixed by `DESIGN.md` and asserted by
`tests/contrast.test.ts`.)*

---

## 2. Retain / redesign / delete

### Retain unchanged
- The entire token system in `global.css` — `@theme` + `html.dark` re-pointing
- `DESIGN.md` and its accessibility contract
- `tests/contrast.test.ts` — 110 lines of real guardrail, including the test
  pinning raw coral as unsafe for text
- `ArticleCard.astro` structure (extend, don't rebuild), `LeadStory`,
  `CategoryRail`, `LogoIcon`, `SavedArticlesDrawer` behaviour
- The `prefers-reduced-motion` block, the skip link, `:focus-visible` rings
- Honest empty/error copy already in place
- `createElement` + `textContent` DOM building — never `innerHTML`

### Redesign
| Component | Why |
|---|---|
| Navigation chrome | Three stacked bars = ~138 px on mobile, 21% of a 667 px viewport |
| `HeroMesh` | Its "Search" filters already-loaded DOM cards. Replace with real search |
| `MostReadSidebar` | Labelled "Most Read", fed `top.slice(0, 5)` — the newest five. Make it real or rename it |
| `FactCheckWidget` | Needs the full evidence model, 6 verdicts, claim confirmation |
| `MastheadInfoStrip` | Four third-party client fetches (security S-09); geolocation prompt with no gesture |
| Mobile navigation | No bottom nav; the primary CTA is `hidden sm:flex` — hidden exactly where it matters |

### Delete
- `buildCard()` in `NewsFeed.astro:148-242` — a hand-rolled DOM duplicate of
  `ArticleCard.astro`. Replace with a single template rendered by both paths
- The duplicated `formatPublished` (`NewsFeed.astro:124`) and `isSafeUrl`
  (`:137`) — import from `lib/`

---

## 3. Navigation

### 3.1 Mobile (< 768 px) — bottom tab bar

```
┌─────────────────────────────────────────┐
│  ☰  NewzWale              🔍  ☾         │  56px, sticky, single bar
├─────────────────────────────────────────┤
│  Top  India  World  Business  Sports →  │  44px, scrollable, hides on scroll-down
├─────────────────────────────────────────┤
│                                         │
│              content                    │
│                                         │
├─────────────────────────────────────────┤
│  🏠      📈      ✓✓      🔍      👤     │  56px + safe-area, always visible
│ Home  Trending FactCheck Search  You    │
└─────────────────────────────────────────┘
```

- Chrome drops from ~138 px to **100 px**, and the category strip hides on
  scroll-down, leaving 56 px while reading.
- **Fact Check gets a permanent tab**, centre position, visually weighted. It
  is the differentiator; it should never be more than one tap away.
- Replaces the `hidden sm:flex` floating CTA in `Layout.astro:262`.
- The masthead strip's contents relocate: language and theme into **You**,
  saved count as a badge on **You**, ticker into the Home feed as a dismissible
  card, weather removed from the default view (see security S-09).
- 44×44 px minimum touch targets. Bottom bar respects
  `env(safe-area-inset-bottom)`.

### 3.2 Desktop (≥ 1024 px)

Single 64 px header: logo · News · Trending · Fact Check · Search · saved ·
theme. Category strip below. Same five destinations as mobile, so the two
experiences do not diverge conceptually.

### 3.3 Focus and keyboard — fixes audit A-02 to A-05

Every overlay (mobile menu, topics popover, saved drawer, any dialog):
- Focus moves in on open, is trapped while open, returns to the trigger on
  close
- Escape closes
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby`
- Background scroll locked

Tabs (`FactCheckWidget`) get the complete ARIA pattern: roving `tabindex`,
Left/Right/Home/End arrow handling. The current partial implementation —
`role="tablist"` with no keyboard model — is worse than no ARIA at all,
because it promises a pattern it does not deliver.

---

## 3.4 Anti-patterns — explicitly forbidden

From brief Part 10 and Part 25. NewzWale must not read as a generic AI product.

**Avoid:** excessive gradients · excessive glassmorphism · generic AI-dashboard
appearance · unnecessary animation · visual noise · giant hero sections that
hide the product · overuse of rounded cards · fake "AI magic" effects ·
excessive badges.

Three of these are **already present** and must be addressed:

| Present | Where | Fix |
|---|---|---|
| Giant hero hiding the product | [`HeroMesh.astro`](../src/components/HeroMesh.astro) — 153 lines of hero with a fake search bar before any story appears | Compress; put a real fact-check input and real stories above the fold |
| Excessive gradients / glow | `.mesh-gradient-bg`, `.mesh-gradient-glow`, `mesh-gradient-glow opacity-30` on `/verify` | Reduce to a restrained accent wash; the design system's own stated direction is "subtle gradients that stay out of the imagery's way" |
| Badge proliferation | Homepage carries: eyebrow badge, LIVE dot, BREAKING pill, category pill, save pill, "Headlines from publisher feeds" pill, three feature pills | Cut to what carries information |

Target adjectives, in tension order: **calm** before clever, **editorial**
before app-like, **evidence-focused** before impressive.

## 3.5 Landing page (brief Part 12)

The homepage must communicate *what NewzWale is*, *why it is different*, and
*what you can do*, above the fold, without a marketing wall.

```
┌────────────────────────────────────────────────────┐
│ Know What's True. Not Just What's Trending.        │  ← restrained, 2 lines max
│ Live Indian news, plus a fact-checker that shows   │
│ its evidence.                                      │
│                                                    │
│ ┌────────────────────────────────────────────┐    │
│ │ Paste a claim, headline, or link…          │    │  ← LIVE input, not a link
│ └────────────────────────────────────────────┘    │     to a fact-check page
│ [ Fact-check this ]      [ Read the news ↓ ]      │
└────────────────────────────────────────────────────┘
  ↓ Latest / Trending news          ← real stories, high on the page
  ↓ How fact-checking works         ← 3 stages, honest about what runs
  ↓ Evidence-first methodology      → /methodology
  ↓ Featured fact checks            ← real completed checks, real verdicts
  ↓ News categories
  ↓ Trust & transparency            ← limitations stated, not hidden
  ↓ Final CTA
  ↓ Footer
```

Rules:
- **The hero contains a working fact-check input**, not a button that navigates
  to one. The differentiator is usable in the first interaction.
- Featured fact checks are **real completed checks** pulled from the database —
  never mock verdicts, never illustrative examples styled as results.
- "Trust & transparency" states limitations. A trust section that only lists
  strengths is marketing, and readers of a fact-checking product will price it
  as such.
- Total hero height ≤ 60vh on mobile. Real content must be reachable without a
  deliberate scroll.

## 4. News UI

### 4.1 Card

Anatomy and honesty rules are in
[`NEWZWALE_PRODUCT_SPEC.md`](NEWZWALE_PRODUCT_SPEC.md) §4.2. Visual spec:

| Element | Treatment |
|---|---|
| Image | 16:9, `object-cover`, lazy below fold, `surface-card` placeholder. **Reserve the box** to prevent CLS |
| Category badge | Pill, top-left over image, our slug not upstream's |
| Save | Top-right, 44×44 tap target, `aria-pressed` |
| Meta row | `font-mono-caption`, `text-mute`: category · publisher · relative time |
| Headline | `text-ink`, 3-line clamp, the only large type on the card |
| Summary | `text-body`, 2-line clamp |
| Value row | Reading time · "Also in N sources" · fact-check chip |

Variants: `lead` (hero, eager image, larger headline), `default` (grid),
`compact` (list rows, no image — for search results and trending).

**One implementation.** The Astro component and the "Load more" client path
must render from the same template.

### 4.2 Responsive grid

| Breakpoint | Grid | Notes |
|---|---|---|
| 320–639 | 1 col, 16 px gutters | Single column; no horizontal scroll at 320 px |
| 640–1023 | 2 col | |
| 1024–1279 | 3 col | Sidebar appears |
| ≥ 1280 | 3 col + 300 px sidebar | `max-w-[1400px]` retained |

Mobile-first authoring: base styles are the phone layout; `sm:`/`lg:` add. This
inverts today's practice (audit §5.5) and is a real change in how the CSS is
written, not just where the breakpoints sit.

### 4.3 Story page `/news/[slug]`

Per architecture AD-09 — a story page, not a reproduction.

```
breadcrumb
CATEGORY · publisher · timestamp · est. N min read
Headline (display type)
[hero image]
"Publisher's own summary, quoted and attributed."
[ Read the full story at The Hindu ↗ ]      ← primary action, unmissable

── ALSO REPORTED BY ─────────────────────
  compact cards from other sources in the cluster

── FACT CHECK ───────────────────────────
  verdict cards for checked claims from this story,
  or → "Check a claim from this story"

── RELATED ──────────────────────────────
```

---

## 5. Fact Check UI

### 5.1 Input — mobile-first, one thumb

```
Know what's true.
┌──────────────────────────────────────┐
│ Paste a claim, headline, or link…    │
│                                      │  min 96px, autofocus off
└──────────────────────────────────────┘
[ Paste from clipboard ]   [ Check → ]
Checks published fact-checkers, then live sources.
```

- **One input.** URL vs text is detected, not chosen by the user. The current
  three-tab model asks the reader to classify their own input before they get
  help — for the forward-checker arriving from WhatsApp, that is friction at
  exactly the wrong moment. Image stays a separate, clearly-disabled entry.
- **"Paste from clipboard"** is the single most valuable affordance for the
  primary use case.
- Demo prompts retained — they teach the product in one tap.

### 5.2 Claim confirmation — new, and the most important addition

When the input is a URL or a long paragraph, show the extracted claim back
before checking:

```
We'll check this claim:
┌──────────────────────────────────────┐
│ "RBI kept the repo rate at 6.5% in    │
│  its August 2026 review."             │
└──────────────────────────────────────┘
[ Check this ]   [ Edit ]   [ Pick a different claim ]
```

This converts an unanswerable question into an answerable one, and it makes the
system's interpretation auditable by the reader. Today, a URL check silently
submits 4,000 characters of article body as "the claim".

### 5.3 Progressive result disclosure

The check takes seconds. Show real stages — never a generic spinner:

```
✓ Checked published fact-checkers      (0.8s)
✓ Searched live sources — 5 found      (2.1s)
◐ Reading sources… 3 of 5
○ Weighing evidence
```

Each line reflects a stage that actually ran. Honest by construction: if
certified lookup found nothing, the line says so rather than showing a tick.

### 5.4 Result

Layout is specified in
[`NEWZWALE_PRODUCT_SPEC.md`](NEWZWALE_PRODUCT_SPEC.md) §5.2. UI requirements:

- Verdict badge and evidence-strength meter **side by side, equal weight**. A
  `TRUE` on weak evidence must not look like a `TRUE` on strong evidence.
- Contradicting evidence is **never** collapsed by default.
- Every evidence item shows: number, publisher, quality chip, publication date
  (or "date unknown"), read-method chip ("read in full" / "snippet only"),
  quoted passage, outbound link.
- Limitations panel always rendered, never empty.
- Share button producing an OG-imaged `/fact-check/[id]` link.

### 5.5 Verdict visual language

Six verdicts, three requirements: distinguishable in both themes, **never
colour-alone** (WCAG 1.4.1), and no verdict styled as an error.

Per brief Part 16, the conceptual semantics are:

| Verdict | Semantic | Icon | Notes |
|---|---|---|---|
| TRUE | positive / green | ✓ | |
| FALSE | negative / red | ✕ | |
| PARTLY TRUE | **amber** | ◐ | Half-filled — "some of it holds" |
| MISLEADING | **orange** | ⚠ | Adjacent to amber in hue — **must differ in more than hue**: distinct fill weight and border treatment, or the two are indistinguishable for the ~8% of Indian men with red-green CVD |
| UNVERIFIED | **neutral** | ? | **Styled as a legitimate analytical outcome, not an error** |
| NEEDS CONTEXT | **blue / informational** | ⓘ | An intentional methodological outcome, not a failure |

The amber/orange adjacency is the hard problem in this palette and the reason
"do not rely on colour alone" is a hard rule rather than a guideline. Amber and
orange are the two verdicts most likely to be confused, and they are also the
two whose distinction carries the most meaning (facts wrong vs framing wrong).

**Final colours are chosen by contrast testing, not by eye.** Blue and orange
are new to the palette — the existing system has only `success` / `error` /
`warning` — so both need light and dark values that clear AA against `canvas`,
`surface-soft`, `surface-card`, and `surface-elevated`, in both themes. That is
16 pairings per new colour, and every one lands an assertion in
`tests/contrast.test.ts` before the colour ships.

Constraints:
- Every badge carries icon **+ text label** + colour.
- `warning` currently serves one verdict and must now serve two — the pair
  needs a documented, tested treatment difference.
- **Every new colour pairing requires an assertion in `tests/contrast.test.ts`.**
  This is an existing repo convention (`DESIGN.md` "Conventions") and it is not
  optional.
- The evidence-strength meter is 4 discrete segments with a text label, not a
  percentage. A number implies precision the pipeline does not have.

### 5.6 History `/fact-check/history`

Device-local list, newest first, filterable by verdict via chips showing counts.
Empty state explains that history is stored on this device only and is not
synced — stated plainly, not buried.

---

## 6. States — required for every view

The audit found real gaps here (§5.6). This table is the acceptance checklist.

| View | Loading | Empty | Error |
|---|---|---|---|
| News feed | Skeleton cards matching real card geometry | "No headlines in *Sports* right now" + other categories | "Couldn't load headlines" + Retry |
| Load more | Skeleton row appended, button disabled | "You've reached the end" ✅ exists | "Couldn't load more. Tap to retry" ✅ exists |
| Category rail | Skeleton | **Currently renders nothing at all** → must show a labelled empty state, not vanish | Same |
| Story page | Skeleton | 404 | 500 |
| Trending | Skeleton | "Not enough coverage yet to rank stories" | Retry |
| Search | Inline spinner | "No results for *X*" + **"Check this as a claim →"** | Retry |
| Fact check | Staged progress (§5.3) | n/a | Named error + Retry, preserving input |
| Result | Skeleton | `UNVERIFIED` is a **result**, not an empty state | Named error |
| History / Saved | — | "Nothing yet" + what the feature does | — |

Cross-cutting:
- Skeletons must match final geometry to prevent layout shift.
- Error copy names what failed and what to do. No "Something went wrong".
- **`/api/news` currently returns HTTP 200 on total failure** (audit P-16) —
  the client cannot distinguish "no news" from "outage". Fix at the API, then
  the UI can be honest.

---

## 7. Accessibility requirements

Target: **WCAG 2.2 AA**. Existing strengths retained; gaps closed.

| ID | Fix | Where |
|---|---|---|
| A-01 | `<html lang>` reflects content language; `dir="rtl"` for Urdu | `Layout.astro:22` |
| A-02 | Full ARIA tabs pattern with arrow keys | `FactCheckWidget.astro:22` |
| A-03 | Mobile drawer: focus trap, Escape, scroll lock, focus return | `Navbar.astro:182` |
| A-04 | Topics popover: proper menu semantics, Escape, focus return | `Navbar.astro:70` |
| A-05 | Saved drawer: `role="dialog"`, `aria-modal`, focus management | `SavedArticlesDrawer.astro` |
| A-06 | Meaningful `alt`, or move the category badge out of the image so it is not sighted-only | `ArticleCard.astro:29` |
| A-07 | Geolocation only on explicit user action, with an explanation | `MastheadInfoStrip.astro:222` |
| A-08 | Verify the scroll-hiding header does not break magnifier/landmark navigation | `Navbar.astro:266` |
| new | Verdict badges: icon + label + colour, never colour alone | Verdict components |
| new | `aria-live="polite"` announcing fact-check stage transitions | Result component |
| new | Touch targets ≥ 44×44 px throughout | Global |
| new | No horizontal scroll at 320 px | Global |
| new | Visible focus on the bottom nav, and correct tab order | `BottomNav` |

Testing: keep `tests/contrast.test.ts` as the automated colour gate; add a
manual keyboard-only pass and a screen-reader pass per phase, recorded in
`PROGRESS.md`.

---

## 8. Performance budget

| Metric | Target | Current risk |
|---|---|---|
| LCP (mobile, 4G) | < 2.5 s | 7 self-subrequests per homepage render (audit §4.1) |
| CLS | < 0.1 | Card images have `width`/`height` ✅; skeletons must match geometry |
| INP | < 200 ms | Low — little JS |
| JS per page | < 40 KB gzipped | Currently very low; the bottom nav and PWA must not blow this |
| Fonts | Self-host Inter + JetBrains Mono | Currently a render-blocking `@import` from Google Fonts (`global.css:1`) — also a third-party dependency in the CSP |

The Google Fonts `@import` is worth calling out: an `@import` at the top of the
stylesheet is the most render-blocking form of font loading available.
Self-hosting with `font-display: swap` removes a third-party origin, a DNS
lookup, and a CSP entry at once.

---

## 9. Motion

- Respect `prefers-reduced-motion` — the existing block already collapses
  transitions and stops the marquee. Do not add unconditional animation.
- Durations 150–300 ms; ease-out for entry, ease-in for exit.
- Motion communicates state change (drawer, tab, load), never decoration.
- The one-time "peek nudge" on scrollable strips (`Navbar.astro:241`,
  `MastheadInfoStrip.astro:262`) is a good affordance — retain it, and make
  sure it is disabled under reduced motion.

---

## 10. Component inventory (target)

```
shell/     Layout  Header  BottomNav*  CategoryStrip  Footer  ThemeToggle
           LanguageSelect  SkipLink  NavProgress
news/      ArticleCard(lead|default|compact)  ArticleGrid  CategoryRail
           LeadStory  CoverageList*  TrendingList*  ReadingTime*
           FactCheckChip*  StoryHeader*
factcheck/ ClaimInput*  ClaimConfirm*  CheckProgress*  VerdictBadge*
           EvidenceStrengthMeter*  EvidenceList*  EvidenceItem*
           SourceQualityChip*  LimitationsPanel*  RelatedClaims*
           ShareResult*  VerdictFilterChips*
shared/    Skeleton*  EmptyState*  ErrorState*  Dialog*  Chip  Pill
           Breadcrumb  Pagination
```
`*` = new. Everything else exists and is extended rather than replaced.

**Dialog** is deliberately shared: focus trapping is currently reimplemented
(incompletely) three times. One correct implementation closes A-03, A-04, and
A-05 together.
