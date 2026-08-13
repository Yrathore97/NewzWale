# NewzWale — Repository Audit

**Date:** 2026-08-08 (re-verified against the NewzWale 2.0 master brief, same day)
**Scope:** Full read-only audit of the repository at commit `ef0deeb` (branch `claude/install-ui-ux-pro-max-skill-fb49bc`).
**Status:** Discovery only. No code was modified — `git diff --stat` is empty.
**Baseline verified:** `npm test` → 134/134 passing, 14 files. `npx astro check` → 60 files, **0 errors, 0 warnings, 0 hints**.

> **Second-pass note.** This document was re-verified against the NewzWale 2.0
> master brief. The original findings stand unchanged. Four new findings were
> added (P-19 – P-22), and several open decisions have since been settled — see
> [`NEWZWALE_IMPLEMENTATION_PLAN.md`](NEWZWALE_IMPLEMENTATION_PLAN.md)
> §Decisions. One earlier recommendation was **reversed** by the brief:
> source-grounded AI summaries are now permitted under constraints
> ([`NEWZWALE_PRODUCT_SPEC.md`](NEWZWALE_PRODUCT_SPEC.md) §4.3).

Companion documents:
[`NEWZWALE_ARCHITECTURE.md`](NEWZWALE_ARCHITECTURE.md) ·
[`NEWZWALE_PRODUCT_SPEC.md`](NEWZWALE_PRODUCT_SPEC.md) ·
[`NEWZWALE_UI_UX_SPEC.md`](NEWZWALE_UI_UX_SPEC.md) ·
[`NEWZWALE_FACTCHECK_SPEC.md`](NEWZWALE_FACTCHECK_SPEC.md) ·
[`NEWZWALE_SECURITY_AUDIT.md`](NEWZWALE_SECURITY_AUDIT.md) ·
[`NEWZWALE_IMPLEMENTATION_PLAN.md`](NEWZWALE_IMPLEMENTATION_PLAN.md)

---

## 1. Executive summary

NewzWale is a **small, disciplined, honest codebase** — roughly 2,900 lines of
application source plus 5,100 lines including tests. It is not a mess. The
engineering standard in the existing code is high: security guards are
commented with their reasoning, the fact-check pipeline genuinely refuses to
guess, the design system is token-based and contrast-tested in CI, and
`PROGRESS.md` is an unusually accurate handoff log.

The gap is **not quality, it is scope**. The product described by the NewzWale
principles — six verdicts, evidence strength, supporting vs contradicting
evidence, source quality, related claims, history, search, trending, article
pages, a mobile app — is roughly 4× the surface area of what exists. What
exists is a headline aggregator plus a single-shot claim checker.

Three things must be understood before planning:

1. **There is no database and no persistence.** Everything is either a KV cache
   entry with a TTL or `localStorage`. No article has a stable identity, no
   fact-check has an ID, no history exists server-side. Half the requested
   target routes (`/news/[slug]`, `/fact-check/[id]`, `/trending`, `/search`)
   are blocked on this.
2. **The 4→6 verdict change is not a rename.** `insufficient_evidence` splits
   into two new verdicts and `misleading` splits into two. The pipeline
   currently produces no signal capable of telling those pairs apart. See
   [§7](#7-4→6-verdict-migration-inventory).
3. **Two product principles are currently violated in code**, not merely
   unimplemented: single-source verdicts (principle 6) and preservation of
   publication dates (principle 7). See [§6](#6-principle-conformance).

---

## 2. Architecture as built

### 2.1 Stack

| Layer | Choice | Evidence |
|---|---|---|
| Framework | Astro 7, `output: 'server'` | [`astro.config.mjs`](../astro.config.mjs) |
| Runtime | Cloudflare Workers, `@astrojs/cloudflare` v14 | [`wrangler.jsonc`](../wrangler.jsonc) |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite`, tokens in `@theme` | [`src/styles/global.css`](../src/styles/global.css) |
| Tests | Vitest 4, node environment | [`vitest.config.ts`](../vitest.config.ts) |
| CI | GitHub Actions — test, `astro check`, build | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) |
| Runtime deps | 4 total: astro, tailwindcss, `@astrojs/cloudflare`, `@tailwindcss/vite` | [`package.json`](../package.json) |

**There is no database, no ORM, no auth library, no UI framework, no state
manager, and no client-side router.** Every interactive behaviour is a plain
`<script>` block inside an `.astro` component.

### 2.2 Bindings and secrets

```
KV   NEWZ_CACHE   e05934d898ea4c90b96f0df3bade9191   — news + fact-check + rate-limit
KV   SESSION      1850d81959b6492fa926dea8cbe993f2   — auto-injected by the Astro adapter; UNUSED by app code
AI   AI                                              — Workers AI, used by stage 3 only
```

Secrets (Worker secrets, never committed; template in [`.dev.vars.example`](../.dev.vars.example)):
`NEWSDATA_API_KEY`, `GOOGLE_FACTCHECK_API_KEY`, `TAVILY_API_KEY`,
`GUARDIAN_API_KEY` (optional).

`compatibility_flags: ["global_fetch_strictly_public"]` is set — this is the
platform-level SSRF backstop and is load-bearing. Do not remove it.

### 2.3 Routes as built

**Pages** (all SSR except 404/500 which are prerendered):

| Route | File | Purpose |
|---|---|---|
| `/` | [`src/pages/index.astro`](../src/pages/index.astro) | Homepage: hero, lead story, 4 topic rails, promo, main grid, sidebar |
| `/verify` | [`src/pages/verify.astro`](../src/pages/verify.astro) | Fact-check tool + methodology + FAQ |
| `/category/[slug]` | [`src/pages/category/[slug].astro`](../src/pages/category/[slug].astro) | Per-category feed; 404s on unknown slug |
| `/about` `/contact` `/privacy` `/terms` | static | Marketing / legal |
| `/404` `/500` | prerendered | Error pages |

**APIs:**

| Endpoint | Method | File | Notes |
|---|---|---|---|
| `/api/news` | GET | [`src/pages/api/news.ts`](../src/pages/api/news.ts) | `category`, `language`, `page`; KV-cached 20 min |
| `/api/factcheck` | POST | [`src/pages/api/factcheck.ts`](../src/pages/api/factcheck.ts) | `{claim}` or `{url}`; rate-limited 20/IP/hr; KV-cached 24 h |
| `/api/ticker` | GET | [`src/pages/api/ticker.ts`](../src/pages/api/ticker.ts) | Yahoo Finance Sensex/Nifty; **uncached, unlimited** |

**Absent entirely:** `/search`, `/trending`, `/news/[slug]`, `/fact-check/*`,
any auth route, any user route, any admin route.

### 2.4 Client-side state

There is no server-side user state at all. Everything lives in `localStorage`,
managed by a single `window.NZ` façade defined in
[`src/layouts/Layout.astro:130-256`](../src/layouts/Layout.astro):

| Key | Shape | Written by |
|---|---|---|
| `nz_saved` | `{href, headline}[]` | Save buttons on every card |
| `nz_topics` | `string[]` | "Customize topics" popover |
| `theme` | `'dark' \| 'light'` | Theme toggle |
| `userLanguage` / `userLanguageName` | `string` | Language `<select>` |
| `newzwale_weather_cache` | `{timestamp, location, temp, condition}` | Masthead weather |

Consequence: **saved articles and topic preferences do not sync across
devices, and are lost when site data is cleared.** This is a deliberate
"no account needed" trade-off, currently marketed as a feature in the README.

---

## 3. Fact-check pipeline — traced execution

The requested trace, mapped to real files and line numbers.

```
┌─ USER INPUT ────────────────────────────────────────────────────────────────┐
│ src/components/FactCheckWidget.astro:22-79                                  │
│ Three tabs: Text/Claim (textarea), Article URL (input), Image (DISABLED).   │
│ Submit handler :225 builds {claim} or {url}, POSTs /api/factcheck.          │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ REQUEST HANDLING ──────────────────────────────────────────────────────────┐
│ src/pages/api/factcheck.ts:127 POST                                         │
│  :130 request.json()  — no size limit                                       │
│  :137 rate limit on cf-connecting-ip BEFORE any outbound work (correct)     │
│  :144 resolveClaim()                                                        │
│  :149 reject < MIN_CLAIM_CHARS (10). NO MAXIMUM.                            │
│  :153 KV lookup  fc:v1:<lowercased, whitespace-collapsed, FIRST 200 CHARS>  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ CLAIM EXTRACTION ──────────────────────────────────────────────────────────┐
│ src/pages/api/factcheck.ts:116 resolveClaim()                               │
│  url path  → src/lib/factcheck/extract.ts:67 fetchArticleText()             │
│              :69 scheme allowlist (http/https)                              │
│              :72 isPrivateHost() SSRF guard (:45, well-tested)              │
│              :75 fetch — NO timeout, NO size cap, NO content-type check     │
│              :79 extractReadableText() — regex tag strip, cap 4000 chars    │
│  text path → trim only                                                      │
│                                                                             │
│ ⚠ THERE IS NO CLAIM EXTRACTION. For a URL, up to 4,000 characters of        │
│   article body become "the claim" verbatim. No sentence selection, no       │
│   check-worthiness ranking, no entity/date/number extraction.               │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ SOURCE SEARCH — stage 1: certified ────────────────────────────────────────┐
│ src/pages/api/factcheck.ts:172-181 → src/lib/factcheck/google.ts:32         │
│  Google Fact Check Tools API, query = claim.slice(0, 300)                   │
│  languageCode hardcoded 'en' — Indian-language claims get English-only      │
│  :6 parseGoogleClaims returns the FIRST claim whose rating maps cleanly.    │
│  ⚠ EARLY RETURN. One publisher's review becomes the final verdict.          │
│    Violates principle 6 (never trust a single source).                      │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓ (only if stage 1 found nothing)
┌─ SOURCE SEARCH — stage 2: web ──────────────────────────────────────────────┐
│ src/pages/api/factcheck.ts:187-189 → src/lib/factcheck/search.ts:39         │
│  Tavily POST, max_results 5, search_depth 'basic', key in Authorization     │
│  header (deliberate — a key in a query string leaks into logs).             │
│  Sliced to MAX_SOURCES = 3.                                                 │
│  Failure returns [] rather than throwing → degrades to insufficient.        │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ SOURCE COLLECTION ─────────────────────────────────────────────────────────┐
│ :189 Promise.allSettled(hits.map(fetchArticleText))                         │
│  Three concurrent attacker-influenced fetches, same missing timeout/size    │
│  guards as above.                                                           │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ SOURCE PROCESSING ─────────────────────────────────────────────────────────┐
│ :191-197 page text if the fetch succeeded, else the Tavily snippet.         │
│  Truncated to PASSAGE_CHARS = 1500.                                         │
│  ⚠ The result never records WHICH of the two it used, so the UI cannot      │
│    tell the reader "this source was summarised, not read".                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ EVIDENCE EXTRACTION ───────────────────────────────────────────────────────┐
│ :201-205 Evidence[] = { title, url, publisher: hostname }                   │
│  src/lib/factcheck/types.ts:3-8                                             │
│  ⚠ NO publication date. NO source quality. NO stance (supports/contradicts).│
│    NO relevance score. NO quoted passage. Violates principle 7.             │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ CLAIM / EVIDENCE COMPARISON ───────────────────────────────────────────────┐
│ :212-222 ONE call to env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8')       │
│  temperature 0, max_tokens 300                                              │
│  SYSTEM prompt :37-48 — deliberately verbose; PROGRESS.md records that a    │
│  terser version flipped debunked claims to "verified" against the live      │
│  model. Re-test both directions before editing.                             │
│  ⚠ Passages are concatenated into the user message with no delimiting or    │
│    instruction-stripping. Prompt injection is unmitigated. See the          │
│    security audit, finding S-06.                                            │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ VERDICT ───────────────────────────────────────────────────────────────────┐
│ :230 coerceVerdict() → src/lib/factcheck/verdict.ts:31                      │
│  Anything not in the 4-value allowlist becomes insufficient_evidence.       │
│  :238 basis = 'none' when insufficient, else 'ai_assessment'.               │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ EXPLANATION ───────────────────────────────────────────────────────────────┐
│ :231-234 model's 2-sentence explanation, or the UNREADABLE constant :53.    │
│  ⚠ No structured reasoning, no limitations field, no confidence.            │
└─────────────────────────────────────────────────────────────────────────────┘
                                     ↓
┌─ UI RESULT ─────────────────────────────────────────────────────────────────┐
│ src/components/FactCheckWidget.astro:258-277                                │
│  Badge (VERDICTS map :187), basis note, explanation, source grid.           │
│  ⚠ :206 a.href = e.url with NO scheme validation. See security S-12.        │
│  Result is ephemeral — no ID, no permalink, no history, not shareable.      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Every file in the fact-check flow

| File | Role |
|---|---|
| [`src/components/FactCheckWidget.astro`](../src/components/FactCheckWidget.astro) | Input UI, submit, verdict rendering (289 lines) |
| [`src/pages/verify.astro`](../src/pages/verify.astro) | Page shell, methodology copy, FAQ |
| [`src/pages/api/factcheck.ts`](../src/pages/api/factcheck.ts) | Orchestrator, prompt, model call, cache (246 lines) |
| [`src/lib/factcheck/types.ts`](../src/lib/factcheck/types.ts) | `Verdict`, `Evidence`, `FactCheckResult` |
| [`src/lib/factcheck/extract.ts`](../src/lib/factcheck/extract.ts) | HTML→text, SSRF guard, article fetch |
| [`src/lib/factcheck/google.ts`](../src/lib/factcheck/google.ts) | Stage 1, Google Fact Check Tools |
| [`src/lib/factcheck/search.ts`](../src/lib/factcheck/search.ts) | Stage 2, Tavily |
| [`src/lib/factcheck/verdict.ts`](../src/lib/factcheck/verdict.ts) | Rating normalisation, enum coercion |
| [`src/lib/cache.ts`](../src/lib/cache.ts) | `factCheckCacheKey`, `cached()` |
| [`src/lib/ratelimit.ts`](../src/lib/ratelimit.ts) | KV counter |
| [`src/components/FactCheckPromo.astro`](../src/components/FactCheckPromo.astro) | Homepage promo — contains verdict copy |

---

## 4. News pipeline — traced execution

```
SOURCE/RSS
  Primary   NewsData.io   src/lib/news/newsdata.ts:38   country=in, language, category, page token
  Fallback1 Guardian      src/lib/news/guardian.ts:36   English only, unpaginated, needs GUARDIAN_API_KEY
  Fallback2 RSS           src/lib/news/rss.ts:40        4 fixed feeds: thehindu, indianexpress, ndtv, mint
     ↓
INGESTION
  src/pages/api/news.ts:29-61 inside cached(); NewsData → (empty/throw) → Guardian → RSS.
  Fallbacks are FIRST-PAGE ONLY (:43) — paging into an unpaginated source would loop forever.
     ↓
NORMALIZATION
  normalizeNewsData :7 / normalizeGuardian :17 / parseRss :19  → Article
  src/lib/news/types.ts:1  { id, title, url, summary, imageUrl, source, category, publishedAt }
  ⚠ parseRss is a regex parser (rss.ts:10-20), not an XML parser. Fragile on CDATA edge cases
    and namespaced tags; no media:content, so RSS articles NEVER have images.
     ↓
DEDUPLICATION
  src/lib/news/feed.ts:23 prepareArticles — EXACT URL match only, then sort newest-first.
  ⚠ No title similarity, no canonical-URL normalisation (utm params defeat it), no
    cross-source story clustering. "Multiple-source coverage" in the target IA is not possible
    with this.
     ↓
STORAGE
  NONE. KV cache only: news:v2:<category>:<language>:<page>, TTL 20 min,
  plus a :stale copy at 24 h served when the producer throws (src/lib/cache.ts:17).
  ⚠ No article table, no stable IDs, no history, no full-text index.
     ↓
CATEGORIZATION
  Site allowlist src/lib/news/categories.ts:15 (8 slugs) maps to upstream names.
  Article.category is whatever upstream returned, NOT the site slug — so a card in the
  Sports rail can display a different category badge.
     ↓
SUMMARY
  Verbatim upstream description / trailText. RSS truncated to 300 chars.
  ⚠ No generated summaries anywhere. The target "concise, easy-to-scan" news product needs
    them, and generating them is a licensing + accuracy decision, not just an engineering one.
     ↓
NEWS UI
  index.astro → HeroMesh, LeadStory, CategoryRail ×4, FactCheckPromo, NewsFeed, MostReadSidebar
  category/[slug].astro → NewsFeed
  All cards link OUT to the publisher (target="_blank" rel="noopener noreferrer").
```

### 4.1 Structural problem: self-subrequest fan-out

`index.astro:27`, `HeroMesh.astro:8`, `CategoryRail.astro:21` and
`NewsFeed.astro:30` each call `fetch(new URL('/api/news', Astro.url))` — the
Worker making full HTTP requests **to itself**.

One homepage render issues **seven** self-subrequests:
1 (index lead) + 1 (HeroMesh ticker) + 4 (rails) + 1 (NewsFeed grid).

Consequences:
- Each is a real round trip with serialisation overhead on a cold render.
- Cloudflare counts these against the per-request subrequest limit (50 on the
  free plan). Add the upstream NewsData calls behind each cache miss and the
  worst-case cold homepage is already ~14 subrequests.
- `index.astro` and `HeroMesh.astro` fetch the *same* `top` feed separately.

Fix: call `fetchNewsData`/`cached()` directly from a shared server module. This
is a Phase 0 change with no user-visible effect.

---

## 5. UI audit

### 5.1 Pages, navigation, chrome

Every page stacks **three** pieces of sticky/persistent chrome:

| Bar | Component | Height | Contents |
|---|---|---|---|
| Masthead info strip | [`MastheadInfoStrip.astro`](../src/components/MastheadInfoStrip.astro) | ~28px | Weather, date, ticker, language, saved count, theme |
| Header | [`Navbar.astro`](../src/components/Navbar.astro) | 64px | Logo, News/Fact Check, Customize topics, CTA / hamburger |
| Category strip | inside `Navbar.astro` | 46px | 8 horizontally-scrolling category pills |

That is **~138px of chrome before any content** on a 667px-tall phone — about
21% of the viewport. The header hides on scroll-down
(`Navbar.astro:252-273`), which mitigates but does not solve it.

Navigation is only two destinations deep: News (`/`) and Fact Check
(`/verify`), plus the category strip. There is no search destination, no
trending, no history, no user area.

### 5.2 Reusable components inventory

| Component | Lines | Reusable? | Verdict |
|---|---|---|---|
| `ArticleCard.astro` | 107 | ✅ Yes — `lead` and `default` sizes | **Retain**, extend |
| `LogoIcon.astro` | 64 | ✅ | **Retain** |
| `Footer.astro` | 74 | ✅ | Retain, extend links |
| `Navbar.astro` | 274 | Partly — mixes nav, theme, language, scroll, category strip | **Split** |
| `MastheadInfoStrip.astro` | 301 | ❌ Single-purpose, 4 third-party fetches | **Redesign** (see security S-09) |
| `NewsFeed.astro` | 293 | Partly | **Refactor** — see below |
| `FactCheckWidget.astro` | 289 | ❌ | **Redesign** for 6 verdicts + evidence model |
| `HeroMesh.astro` | 153 | ❌ | Redesign — its "search" is fake |
| `LeadStory.astro` | 30 | ✅ | Retain |
| `CategoryRail.astro` | 59 | ✅ | Retain |
| `MostReadSidebar.astro` | 52 | ❌ "Most Read" is really "newest 5" | **Redesign or rename** |
| `FactCheckPromo.astro` | 42 | ✅ | Retain, update copy |
| `SeoContentSection.astro` | 85 | ❌ SEO filler | Review |
| `SavedArticlesDrawer.astro` | 99 | ✅ | Retain, fix focus management |
| `Layout.astro` | 313 | ✅ | Retain; extract the `window.NZ` script |

### 5.3 Duplicated logic — a real maintenance hazard

`NewsFeed.astro:148-242` contains **`buildCard()`, a complete hand-rolled DOM
reimplementation of `ArticleCard.astro`**, used for "Load more" results. Two
independent implementations of the same card must now be kept in sync by hand.

Also duplicated in that same `<script>`:
- `formatPublished` — `NewsFeed.astro:124` duplicates `feed.ts:39`
- `isSafeUrl` — `NewsFeed.astro:137` duplicates `feed.ts:4`

A style tweak to `ArticleCard.astro` silently does not apply to any card loaded
via "Load more". This is the single highest-value refactor in the UI layer.

### 5.4 Design system

**This is the strongest asset in the repository. Retain it wholesale.**

- Tokens declared in a Tailwind v4 `@theme` block, re-pointed by `html.dark`,
  so `dark:` variants are almost never needed
  ([`global.css:23-143`](../src/styles/global.css)).
- Documented in [`DESIGN.md`](../DESIGN.md) with a full token table and a
  written accessibility contract.
- `tests/contrast.test.ts` asserts every text/surface pair against WCAG in both
  modes, **including a test that pins raw coral `#ff6b57` as unsafe for text**
  so it can't be "simplified" back later. 110 lines of real guardrail.
- Zero hardcoded hex in `src/**/*.astro` — verified.
- `prefers-reduced-motion` block collapses transitions and stops the marquee.
- Visible `:focus-visible` ring on every interactive element.

Known trap, documented in both `global.css:83-90` and `DESIGN.md`: do **not**
add `--spacing-*` tokens to `@theme` — Tailwind v4 resolves `max-w-*` through
the spacing scale and it has already broken a layout once.

Second trap: the `.btn-*` component classes are unlayered CSS and therefore
**beat Tailwind utilities on the same element**.

### 5.5 Responsive behaviour

Breakpoints are stock Tailwind. Grids are `grid-cols-1 md:grid-cols-2
lg:grid-cols-3`. Containers are `max-w-[1400px]`.

The composition is **desktop-first written responsively**, not mobile-first:
the homepage's `lg:grid-cols-[1fr_300px]` sidebar layout is the primary design
and mobile is the collapsed case. Evidence: the "Verify a claim" floating CTA
is `hidden sm:flex` ([`Layout.astro:262`](../src/layouts/Layout.astro)) — it is
hidden on exactly the screens where a persistent action is most valuable.

### 5.6 State coverage

| State | Coverage |
|---|---|
| **Loading** | Top progress bar on navigation (`Layout.astro:269`); spinner on the fact-check button. ❌ No skeletons; ❌ nothing during "Load more" beyond a label change |
| **Empty** | NewsFeed: "Headlines are temporarily unavailable" ✅; SavedArticlesDrawer: ✅; **CategoryRail: renders nothing at all — silent disappearance** ❌ |
| **Error** | FactCheckWidget error box with `role="alert"` ✅; ticker/weather hide silently ✅ (deliberate — never show invented numbers); `/api/news` returns HTTP 200 with an empty array on total failure ❌ (masks outages from monitoring) |
| **404/500** | Dedicated designed pages ✅ |

### 5.7 Accessibility findings

Foundation is genuinely good: skip link, contrast tests in CI, focus rings,
reduced motion, `aria-live` on the load-more status, `aria-hidden` on the
duplicated marquee copy, `createElement`+`textContent` instead of `innerHTML`.

Gaps found:

| # | Finding | Location |
|---|---|---|
| A-01 | `<html lang="en">` is **hardcoded** even when headlines render in Hindi, Tamil, Urdu, etc. Screen readers will mispronounce every headline; also an SEO signal error. Urdu additionally needs `dir="rtl"`. | `Layout.astro:22` |
| A-02 | Tab pattern has `role="tablist"` but no roving tabindex and no arrow-key handling — an incomplete ARIA pattern is worse than none | `FactCheckWidget.astro:22` |
| A-03 | Mobile drawer: no focus trap, no focus move, no Escape, no scroll lock | `Navbar.astro:182` |
| A-04 | Topics popover: `role="menu"` without `menuitem` children; closes on outside click but not Escape; no focus return | `Navbar.astro:70` |
| A-05 | Saved drawer: Escape works, but focus is never moved in or restored, and the dialog lacks `role="dialog"` / `aria-modal` | `SavedArticlesDrawer.astro` |
| A-06 | Every card image is `alt=""`. Defensible for decorative thumbs, but combined with the category badge being *inside* the image, sighted-only information is conveyed | `ArticleCard.astro:29` |
| A-07 | Browser geolocation permission prompt fires on page load with no user gesture and no explanation | `MastheadInfoStrip.astro:222` |
| A-08 | Header hides on scroll-down, which can move `#main`'s landmark boundary unexpectedly for magnifier users | `Navbar.astro:266` |

### 5.8 What to retain vs redesign

**Retain as-is:** the token system and `global.css`; `DESIGN.md`; the contrast
test suite; `ArticleCard`, `LeadStory`, `CategoryRail`, `LogoIcon`,
`SavedArticlesDrawer`; the SSR + KV caching approach; the honest empty/error
copy; `prepareArticles`; the SSRF guard; `PROGRESS.md` as the handoff protocol.

**Redesign:** the three-bar chrome (consolidate to one bar + a mobile bottom
nav); `HeroMesh` (its search is a client-side filter of already-loaded cards —
`HeroMesh.astro:130-156`); `MostReadSidebar` (labelled "Most Read" but fed
`top.slice(0, 5)`, i.e. newest, not most-read — this is an honesty problem, not
a design one); `FactCheckWidget` (needs the full evidence model);
`MastheadInfoStrip` (four third-party client calls, see security).

**Delete or replace:** `NewsFeed.astro`'s `buildCard()` duplication.

---

## 6. Principle conformance

| # | Principle | Status | Evidence |
|---|---|---|---|
| 1 | Evidence before confidence | ⚠️ Partial | Refuses to guess ✅, but there is **no confidence or evidence-strength field at all**. `basis` is the only proxy. |
| 2 | Never invent sources | ✅ Met | Evidence is always retrieved, never generated. |
| 3 | Never fabricate citations | ⚠️ Partial | Citations are real, but an `Evidence` entry is emitted even when the page fetch **failed** and only a Tavily snippet was read (`factcheck.ts:191-197`) — the reader is not told. |
| 4 | Distinguish fact from inference | ⚠️ Partial | `basis: certified \| ai_assessment \| none` is surfaced ✅. But supporting / contradicting / contextual evidence are not separated. |
| 5 | Never expose API keys | ✅ Met | All keys server-side via `cloudflare:workers` env; Tavily key in a header not a URL (`search.ts:52`); `.dev.vars*` gitignored; no hex or key literals in `src/`. |
| 6 | Never trust a single source | ❌ **Violated** | Stage 1 returns on the **first** Google claim review (`google.ts:14-27`). Stage 3 will issue a verdict from **one** passage. No corroboration requirement anywhere. |
| 7 | Preserve source URLs and dates | ❌ **Violated** | `Evidence` (`types.ts:3-8`) has **no date field**. Publication dates are never captured for fact-check evidence. (News articles do keep `publishedAt`.) |
| 8 | Mobile-first | ⚠️ Partial | Responsive ✅, but composed desktop-down; ~138px of chrome on mobile; primary CTA `hidden sm:flex`. |
| 9 | Accessibility mandatory | ⚠️ Partial | Strong foundation; 8 concrete gaps in §5.7, A-01 being the most serious. |
| 10 | Security mandatory | ⚠️ Partial | Strong foundation; 18 findings in [`NEWZWALE_SECURITY_AUDIT.md`](NEWZWALE_SECURITY_AUDIT.md), 3 rated High. |

---

## 7. 4→6 verdict migration inventory

**Current:** `'verified' | 'misleading' | 'false' | 'insufficient_evidence'`
**Target:** TRUE · FALSE · PARTLY TRUE · MISLEADING · UNVERIFIED · NEEDS CONTEXT

### 7.1 Why this is not a rename

Two of the four existing verdicts **split**:

```
verified              →  TRUE
false                 →  FALSE
misleading            →  MISLEADING  ⊕  PARTLY TRUE
insufficient_evidence →  UNVERIFIED  ⊕  NEEDS CONTEXT
```

- **MISLEADING vs PARTLY TRUE** requires knowing whether the inaccuracy is in
  the *framing* or in the *facts*. The current `MISLEADING_WORDS` list
  (`verdict.ts:10`) already conflates them — it maps `'partly'`, `'partially'`,
  `'half'`, `'mixture'` *and* `'misleading'`, `'exaggerated'`, `'out of
  context'` to one value.
- **UNVERIFIED vs NEEDS CONTEXT** are opposites in evidence terms. UNVERIFIED
  means *we found nothing*. NEEDS CONTEXT means *we found plenty, and the claim
  is literally accurate but materially incomplete*. The pipeline currently
  produces no signal that can tell those apart, because it captures no evidence
  strength, no stance, and no coverage measure.

**Conclusion: the 6-verdict system cannot be honestly delivered by an enum
change alone.** The enum change is mechanical (Phase 3); making
`PARTLY_TRUE` and `NEEDS_CONTEXT` *earned* requires the evidence model
(Phase 4). Shipping Phase 3 alone will produce a 6-value enum where two values
are almost never emitted. That is an acceptable intermediate state **only if
stated openly**.

### 7.2 Complete change surface

#### Backend / business logic
| Location | Change |
|---|---|
| `src/lib/factcheck/types.ts:1` | `Verdict` union: 4 → 6 members |
| `src/lib/factcheck/types.ts:10-17` | `FactCheckResult`: add `evidenceStrength`, `limitations`, `reasoning`, `id`, `checkedAt` |
| `src/lib/factcheck/types.ts:3-8` | `Evidence`: add `publishedAt`, `stance`, `quality`, `quotedPassage`, `readMethod` |
| `src/lib/factcheck/verdict.ts:6-11` | Rating word lists: split MISLEADING into two lists; move `'no evidence'` out of `FALSE_WORDS` (a "No evidence" rating means UNVERIFIED, not FALSE — **this is a live bug today**) |
| `src/lib/factcheck/verdict.ts:13-22` | `normalizeRating` → 6-way mapping |
| `src/lib/factcheck/verdict.ts:24` | `VALID` array |
| `src/lib/factcheck/verdict.ts:31-33` | `coerceVerdict` fallback → `unverified` |
| `src/lib/factcheck/verdict.ts:35-37` | `insufficient()` → rename `unverified()`, add `needsContext()` |
| `src/lib/factcheck/google.ts:13` | `!== 'insufficient_evidence'` skip condition |
| `src/pages/api/factcheck.ts:37-48` | SYSTEM prompt — 6 labelled definitions with disambiguation rules. **Must be re-tested against the live model in both directions** per the `PROGRESS.md` gotcha |
| `src/pages/api/factcheck.ts:238` | `if (verdict === 'insufficient_evidence')` basis branch → 2 values |

#### Database
None today. When D1 lands (Phase 2): `fact_checks.verdict` as a `TEXT` column
with a `CHECK` constraint listing all six, plus an index for
`/fact-check/history` filtering.

#### API schemas / validation
No schema files exist. Recommend introducing a single shared
`src/lib/factcheck/schema.ts` as the one source of truth for the enum, consumed
by the route, the UI, and the tests, so future values change in one place.

#### Cache
`src/lib/cache.ts:10-13` — bump `fc:v1:` → `fc:v2:`. **Mandatory**: 24-hour-old
entries contain 4-value verdict strings; without the bump, `coerceVerdict` will
silently downgrade every cached `verified` to `unverified`.
Fix the truncation at the same time (see security S-03).

#### Frontend / badges / colors
| Location | Change |
|---|---|
| `src/components/FactCheckWidget.astro:187-192` | `VERDICTS` map: 4 → 6 entries |
| `src/components/FactCheckWidget.astro:258` | Fallback `VERDICTS.insufficient_evidence` |
| `src/styles/global.css:56-59` | Only `success`/`error`/`warning` exist. Six verdicts need six distinguishable treatments **and must not rely on colour alone** (WCAG 1.4.1) — pair each with an icon and a text label |
| `tests/contrast.test.ts` | Every new verdict colour needs an assertion — this is a documented repo convention |

#### Filters / history / analytics
All **new surface**, not migration: verdict filter chips on
`/fact-check/history`, per-verdict counts, and a `factcheck_result` analytics
event with `verdict` and `basis` dimensions. No analytics events are emitted
today — GA is loaded (`Layout.astro:41`) but only for pageviews.

#### Tests
| File | Change |
|---|---|
| `tests/factcheck/verdict.test.ts:37` | "accepts the four valid enum values" → six |
| `tests/factcheck/verdict.test.ts:5-34` | New cases per verdict, including the `'no evidence'` correction |
| `tests/factcheck/google.test.ts:33` | Unrecognised-rating expectation |
| new | Cache-key versioning test; a golden-set test asserting a fixed claim+evidence corpus yields the expected verdict |

#### Documentation
`README.md` (4 verdicts stated), `docs/WEBSITE-DOCUMENTATION.md` §3,
`src/pages/verify.astro:67` ("one of four verdicts"),
`src/components/FactCheckPromo.astro:2-4`, and the `/verify` methodology
section.

### 7.3 Wire-format decision required

The label "TRUE" maps awkwardly to a wire value. Options:

| Option | Values | Trade-off |
|---|---|---|
| **A (recommended)** | `true`, `false`, `partly_true`, `misleading`, `unverified`, `needs_context` | Symmetric with the existing `'false'` string, which already works. Risk: `"true"`/`"false"` strings adjacent to booleans invite coercion bugs; mitigate with a lint rule and never `JSON.parse` into a boolean position |
| B | `accurate`, `inaccurate`, `partly_accurate`, `misleading`, `unverified`, `needs_context` | No boolean ambiguity; diverges from the label the reader sees |
| C | `verdict_true`, `verdict_false`, … | Unambiguous, verbose |

**This needs your decision** — see §10.

---

## 8. Major problems found

Ranked by product impact.

| # | Problem | Impact | Where |
|---|---|---|---|
| **P-01** | **No persistence layer.** No article identity, no fact-check IDs, no history, no index | Blocks `/news/[slug]`, `/fact-check/[id]`, `/fact-check/history`, `/trending`, `/search`, and any cross-device sync | Architectural |
| **P-02** | **Single-source verdicts.** Stage 1 early-returns on one review; stage 3 will rule on one passage | Directly violates principle 6 on the product's core differentiator | `google.ts:14`, `factcheck.ts:199` |
| **P-03** | **No publication dates on evidence** | Violates principle 7; a 2019 source can silently settle a 2026 claim | `types.ts:3-8` |
| **P-04** | **Prompt injection unmitigated.** Fetched page text goes straight into the model message | An attacker who controls any indexed page can flip a verdict. Worst possible failure for an evidence-first product | `factcheck.ts:216` |
| **P-05** | **No claim extraction.** A URL check feeds 4,000 chars of article body in as "the claim" | Verdicts on URLs are near-meaningless — the model is asked to judge a document, not a claim | `factcheck.ts:116-125` |
| **P-06** | **No evidence strength / confidence** | Principle 1 is unimplementable as specified; also blocks PARTLY TRUE vs NEEDS CONTEXT | `types.ts` |
| **P-07** | **7 self-subrequests per homepage render** | Latency, cost, and a real subrequest-limit risk | §4.1 |
| **P-08** | **`buildCard()` duplicates `ArticleCard.astro`** | Every card change must be made twice, by hand, in two languages | `NewsFeed.astro:148` |
| **P-09** | **`lang="en"` hardcoded across 13 content languages** | Accessibility (A-01) and SEO defect | `Layout.astro:22` |
| **P-10** | **"Most Read" is actually "newest 5"** | An honesty defect on a product whose entire pitch is honesty | `index.astro:74` |
| **P-11** | **URL-exact dedup only**; utm params defeat it; no story clustering | Blocks the "multiple-source coverage" element of the target IA | `feed.ts:23-37` |
| **P-12** | **`DECISIONS.md` is entirely stale** — describes Sarvam AI voice, `/admin`, grounded chat, FastAPI/Postgres. None exists | Actively misleads any agent or contributor who reads it. Already flagged in `PROGRESS.md` but never actioned | `DECISIONS.md` |
| **P-13** | **Regex RSS parser**, no `media:content` → RSS-sourced articles never have images | Degraded fallback experience | `rss.ts:10-20` |
| **P-14** | **CI never deploys.** `deploy.yml` runs test/check/build only | The filename promises something it does not do | `.github/workflows/deploy.yml` |
| **P-15** | **No API-route or component tests.** 134 tests, all pure-function units | The orchestrator (`factcheck.ts`, 246 lines of real branching logic) has zero direct coverage | `tests/` |
| **P-16** | **`/api/news` returns HTTP 200 on total failure** | Outages are invisible to monitoring and to the client | `news.ts:63-69` |
| **P-17** | **`Article.category` is the upstream value, not the site slug** | A card in the Sports rail can show a different badge | `newsdata.ts:18` |
| **P-18** | **Language switch reloads the whole page** and only changes headline language, never UI chrome | Acceptable by design, but combined with P-09 it is a half-built i18n story | `Navbar.astro:207-223` |

### Added in the second pass (master-brief alignment)

| # | Problem | Impact | Where |
|---|---|---|---|
| **P-19** | **Cloudflare Images is live in production and completely unused.** Verified in adapter source, not inferred | See correction below | [`ArticleCard.astro:27`](../src/components/ArticleCard.astro) |
| **P-20** | **Providers are hardcoded into the route.** The NewsData → Guardian → RSS chain is imperative control flow inside `api/news.ts:33-60`; NewsData is structurally privileged as the only paginated and multilingual source | Violates brief Part 9 ("do not tightly couple to NewsData.io"). Also the root cause of the free-tier quota cliff, since the architecture cannot prefer the uncapped RSS source | [`api/news.ts:33-60`](../src/pages/api/news.ts) |
| **P-21** | **Category taxonomy is 8, target is 11.** Science and Lifestyle are absent; `india` is mapped to upstream `politics`, conflating two distinct categories | Blocks the target IA. The `india` re-point needs its own verification pass — `politics` is *confirmed* to return distinct national-politics stories today, so changing it is not free | [`categories.ts:15-28`](../src/lib/news/categories.ts) |
| **P-22** | **No `/methodology` route.** The methodology lives as a section inside `verify.astro:47-71` | The document a sceptical reader is sent to is not linkable, not indexable on its own, and cannot be referenced from a verdict badge | [`verify.astro:47`](../src/pages/verify.astro) |

#### Correction to P-19 (verified in adapter source)

An earlier draft of this audit suggested the undeclared `IMAGES` binding might
break deploys, by analogy with the `SESSION` binding. **That was wrong.**
Verified in `@astrojs/cloudflare@14.1.7`:

```js
// node_modules/@astrojs/cloudflare/dist/wrangler.js:18
images: hasImagesBinding || !imagesBindingName ? void 0 : { binding: imagesBindingName }
```

The adapter **auto-injects** `images: { binding: "IMAGES" }` into the resolved
Wrangler config whenever `wrangler.jsonc` does not declare one — the same
mechanism it uses for `assets`. The `SESSION` case differed only because a KV
namespace requires a real `id` the adapter cannot invent; an Images binding
requires none. **No deploy risk.**

The real finding is the inverse, and it is more useful: `imageService` resolves
to `cloudflare-binding` by default (`dist/index.js:82-84`), so **Cloudflare
Images is already enabled in production** — resizing, format conversion, quality,
and responsive `srcset` are all available *right now*.

They are entirely unused. [`ArticleCard.astro:27`](../src/components/ArticleCard.astro)
renders a raw `<img src={article.imageUrl}>`; Astro's `<Image>` / `<Picture>` /
`getImage()` appear nowhere in `src/`. Every publisher thumbnail is hotlinked at
its original resolution and format.

Consequences: (a) **ImageKit is not required** — Part 15's checklist is already
satisfied by the incumbent stack; (b) there is an unclaimed performance win in
the news feed; (c) transformations are a **billed** Cloudflare product, so cost
must be sized against expected thumbnail volume before switching the feed over.

---

## 9. Security problems

Full detail, severities, and remediation in
[`NEWZWALE_SECURITY_AUDIT.md`](NEWZWALE_SECURITY_AUDIT.md). Summary:

**High (3):** unbounded article fetch — no timeout, no size cap, no
content-type check (S-04); prompt injection via fetched page content (S-06);
no security headers / no CSP (S-11).

**Medium (9):** non-atomic KV rate limiter (S-01); IP-keyed limiter with a
shared `'unknown'` bucket (S-02); truncated fact-check cache key causing
cross-claim collisions (S-03); unvalidated `href` scheme in the evidence list
(S-12); unratelimited, uncached `/api/ticker` acting as an open proxy (S-08);
three client-side third-party calls leaking IP and precise coordinates (S-09);
unconditional Google Analytics with no consent gate under India's DPDP Act
(S-10); no request-body size limit and no maximum claim length (S-07); no
`npm audit` gate in CI (S-16).

**Low / informational (6):** no content-type check on fetched articles (S-05);
`robots.txt` still disallows a removed `/admin` (S-18); unused `SESSION` KV
binding that will make CSRF live the moment sessions are used (S-14);
self-XSS surface via `localStorage`-sourced hrefs (S-13); image-upload
controls not yet specified (S-15); secrets hygiene is otherwise clean (S-17).

---

## 10. Decisions

Most of the originally-open decisions were settled by the master brief. The
full status table — settled, reversed, partially settled, and newly opened —
lives in [`NEWZWALE_IMPLEMENTATION_PLAN.md`](NEWZWALE_IMPLEMENTATION_PLAN.md)
§Decisions, which is the single place to look.

**Settled:** verdict wire format · adopt D1 · PWA (not native) · `/verify` →
`/fact-check` · no Supabase · Astro stays · `/methodology` becomes a route.

**Reversed:** source-grounded AI summaries are permitted under constraints
(was: prohibited).

**Still open:** `/news/[slug]` full-body confirmation · auth timing · the fate
of `DECISIONS.md` · 3-vs-5 source tiers · category expansion verification ·
Higgsfield adoption · Cloudflare Images vs ImageKit · regional expansion scope.
