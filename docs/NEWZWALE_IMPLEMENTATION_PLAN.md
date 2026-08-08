# NewzWale — Implementation Plan

**Date:** 2026-08-08
**Status:** Proposal. **Awaiting approval. Nothing has been implemented.**
**Baseline:** `npm test` → 134/134 passing; `npx astro check` clean; build OK.

Read with: [`NEWZWALE_AUDIT.md`](NEWZWALE_AUDIT.md) ·
[`NEWZWALE_ARCHITECTURE.md`](NEWZWALE_ARCHITECTURE.md) ·
[`NEWZWALE_PRODUCT_SPEC.md`](NEWZWALE_PRODUCT_SPEC.md) ·
[`NEWZWALE_UI_UX_SPEC.md`](NEWZWALE_UI_UX_SPEC.md) ·
[`NEWZWALE_FACTCHECK_SPEC.md`](NEWZWALE_FACTCHECK_SPEC.md) ·
[`NEWZWALE_SECURITY_AUDIT.md`](NEWZWALE_SECURITY_AUDIT.md)

---

## Decisions — status after the 2026-08-08 master brief

The master brief answered most of the original open decisions. Recorded here so
the reasoning is not re-litigated.

### Settled

| # | Decision | Settled as | Source |
|---|---|---|---|
| **D1** | Verdict wire format | `true`, `false`, `partly_true`, `misleading`, `unverified`, `needs_context` — **the only canonical wire/DB values** | Brief Part 3 |
| **D2** | Adopt Cloudflare D1 | **Yes.** D1 is the system of record; KV stays a TTL cache and must not be the primary database | Brief Part 7 |
| **D6** | Mobile: PWA or native | **PWA.** No separate native app yet; no second backend ever | Brief Part 18 |
| **D8** | `/verify` → `/fact-check` | **Yes**, with a permanent 301 | Brief Part 11 |
| — | Supabase | **Explicitly excluded.** Cloudflare-native only | Brief Part 7, 21 |
| — | Framework | **Astro stays.** No React/Next unless genuinely required | Brief Part 21 |
| — | `/methodology` | **New top-level route**, extracted from the section currently inside `verify.astro:47-71` | Brief Part 11 |

### Reversed by the brief

| # | Was | Now | Consequence |
|---|---|---|---|
| **D4** | "No generated summaries — conflicts with principle 2" | **Source-grounded summaries are permitted**, under hard constraints: must use retrieved source content, must not invent facts, must preserve qualifiers and uncertainty, must not change meaning, must identify and link the source. **Fall back to source metadata/headline when a safe summary cannot be generated** | Adds a *summarisation* sub-pipeline to Phase 2 with its own grounding tests. See `NEWZWALE_PRODUCT_SPEC.md` §4.3 |

My earlier recommendation was more conservative than the brief requires. The
brief's constraint set is coherent — a grounded, qualifier-preserving,
attributed summary with an honest fallback does not violate "never invent". The
risk moves from *policy* to *verification*, so the plan now carries a grounding
test suite instead of a prohibition.

### Partially settled — refinement still needed

| # | Question | Brief says | Still open |
|---|---|---|---|
| **D3** | What is `/news/[slug]`? | Summaries link to the original source; images must respect licensing | **Confirm: no hosted full article bodies.** Recommended shape unchanged — headline, grounded summary, coverage cluster, fact-check panel, prominent link out |
| **D5** | Accounts / auth | `users` table listed; "authentication architecture when introduced"; `/profile` marked future | **Recommended: architect for it, defer building it.** History and saved stay device-local in Phase 8; schema reserves a nullable `user_id` so migration later is additive, not destructive |
| **D7** | `DECISIONS.md` | "Do not delete useful historical documentation" | It is stale (Sarvam AI, `/admin`, FastAPI, Postgres — none exist) but it *is* history. **Revised recommendation: move to `docs/archive/DECISIONS-2026-pre-rebuild.md` with a header stating it is superseded.** Preserves the record, stops it misleading agents that read the repo root |

### New — opened by this brief

| # | Decision | Recommendation |
|---|---|---|
| **D9** | Source tiers: 3 or 5? | Brief Part 4 specifies **3** (Primary/Authoritative · High-quality secondary · Discovery/contextual). My earlier spec had 5. **Adopt the brief's 3 as the canonical public model**, and keep `ifcn_factchecker` + `low_reliability` as *internal flags* on the source record rather than tiers. Readers see 3; the engine can still special-case an IFCN review or a known fabricator |
| **D10** | Category expansion | Brief Part 2 names 11 categories incl. **Science** and **Lifestyle**, and separates India from Politics. Current code has 8, with `india` mapped to upstream `politics` ([categories.ts:21](../src/lib/news/categories.ts)). **Each new category must be verified against real provider output before being added** — the repo has a documented rule that a category returning nothing gets removed rather than shipped empty |
| **D11** | Higgsfield | **Not installed.** Verified: no skill, no MCP entry, no plugin. An official MCP + CLI exists at `higgsfield.ai/mcp` and requires an account and credentials. **Awaiting your go-ahead**; will not self-install. See `NEWZWALE_ARCHITECTURE.md` §AD-11 |
| **D12** | Image pipeline: Cloudflare Images or ImageKit? | **SETTLED — Cloudflare Images.** Verified in adapter source: it is already enabled in production and auto-injects its own binding. It covers resizing, optimisation, transformation, responsive images, and caching — Part 15's entire checklist. It is simply **unused** (`ArticleCard.astro:27` hotlinks raw `<img>`). **No ImageKit.** Remaining work is to size transformation billing against thumbnail volume |
| **D13** | Regional/multilingual expansion scope | Brief names "regional coverage" and "multilingual expansion". 13 content languages already work. **Recommendation: defer regional (state-level) sourcing to post-launch** — it needs a provider that actually carries regional feeds, which NewsData's free tier does not |

---

## Phase sequencing

Aligned to the master brief Part 22.

```
P0 Foundations ──┬── P1 Security ────────────────────────────┐
                 │                                           │
                 └── P2 Data layer (D2) ──┬── P5 API & Routes─┼── P6 UI redesign
                                          │                   │      ▲
                 P3 Verdicts 4→6 (D1) ────┼── P4 Evidence ────┤      │
                                          │                   │   [DD GATE]
                                          └── P7 Search/Trend ┴── P8 History/Saved
                                                                      │
                                                              P9 PWA ─┴── P10 Launch
```

**Critical path:** P0 → P2 → P5 → DD → P6.
**Parallel-safe:** P1 alongside P0/P2; P3 alongside P2; **DD alongside P2–P5**.
**Hard ordering:** P4 after P3 (the enum must exist first). P7 after P2. P9 after P6.

Every phase ends green: `npm test`, `npx astro check`, `npm run build`. No
phase leaves `main` in a worse state than it found it.

### DD — Design Direction gate (brief Part 24)

**No UI implementation code is written until a coherent design direction is
approved.** This is a hard gate on Phase 6, not a suggestion.

Deliverable — a single `docs/NEWZWALE_DESIGN_DIRECTION.md` plus rendered
artefacts, covering: brand identity and visual personality · colour palette
(brand, semantic, **six verdict colours**) · typography · spacing · component
language · navigation · news card system · fact-check card system · evidence
cards · verdict system · responsive behaviour at all nine breakpoints · mobile
navigation · landing page structure · news page structure · fact-check page
structure · fact-check result structure · loading / empty / error states ·
accessibility · motion rules.

Produced with the `ui-ux-pro-max` skill. Verdict colours are chosen **against
contrast testing**, not picked and hoped — every pairing lands an assertion in
`tests/contrast.test.ts`, which is an existing repo convention.

DD runs in parallel with P2–P5 because it touches no runtime code. It costs
nothing on the critical path and de-risks the largest phase.

### Phase deltas introduced by the master brief

| Phase | Added work | Why |
|---|---|---|
| **P0** | Canonical schema + version constants; **provider abstraction interfaces** (`NewsProvider`, `FactCheckProvider`); declare the `IMAGES` binding (D12); archive `DECISIONS.md` (D7) | Brief Parts 9, 22 |
| **P1** | Redirect-count limits and post-redirect re-validation; upload policy written before any upload endpoint exists | Brief Part 6, 20 |
| **P2** | Refactor NewsData/Guardian/RSS behind `NewsProvider`; **source-grounded summarisation sub-pipeline** with grounding tests; RSS promoted to a first-class provider, not just a fallback | Brief Part 9 + D4 reversal |
| **P3** | Explicit assertion that "no evidence" never maps to `false` — currently a live bug at [verdict.ts:8](../src/lib/factcheck/verdict.ts) | Brief Part 3 |
| **P4** | **Contradiction detection** and **context analysis** as named pipeline stages; 3-tier source model (D9) | Brief Part 2, 4 |
| **P5** | `/methodology` as a real route | Brief Part 11 |
| **P6** | **Landing page** as a first-class deliverable; DD gate must be approved first | Brief Part 12, 24 |
| **P7** | Honest metric labelling enforced — "newest" is never called "most read" | Brief Part 22 |

---

## Phase 0 — Foundations

**Objective.** Remove the structural blockers that make every later phase more
expensive. No user-visible change.

**Files.**
- New `src/lib/http.ts` — fetch with timeout, byte cap, content-type allowlist
- New `src/lib/url.ts` — `isSafeUrl` (moved from `news/feed.ts:4`) +
  canonicalisation (strip `utm_*`, `fbclid`, `gclid`, trailing slash, fragment)
- New `src/lib/news/service.ts` — the single server-side read path
- Modify `src/pages/index.astro:27`, `HeroMesh.astro:8`,
  `CategoryRail.astro:21`, `NewsFeed.astro:30` — call the service, not
  `fetch('/api/news')`
- Modify `NewsFeed.astro` — delete `buildCard()` (`:148-242`) and the duplicated
  `formatPublished`/`isSafeUrl`; render "Load more" cards from the same
  template as `ArticleCard.astro`
- Modify `src/pages/api/news.ts` — thin wrapper over the service; return real
  status codes instead of 200-with-empty-array
- Modify `src/layouts/Layout.astro:22` — `lang` and `dir` from the content
  language
- Delete `DECISIONS.md` (D7); add a pointer from `AGENTS.md` to `docs/NEWZWALE_*`

**Dependencies.** None. Start immediately.
**Database.** None.
**API.** `/api/news` gains correct status codes. Response shape unchanged.
**Frontend.** One card implementation instead of two. `lang`/`dir` correct.
**Tests.** `http.ts` timeout + size cap + content-type; `url.ts`
canonicalisation table; existing 134 must stay green; a test asserting
`/api/news` returns non-200 on total upstream failure.

**Risks.**
- *Card refactor regresses "Load more".* Mitigate: verify visually and via DOM
  assertion that server-rendered and client-appended cards produce identical
  markup.
- *Removing self-fetch changes caching behaviour.* The `cached()` helper is
  reused unchanged, so KV semantics are preserved; verify a cold homepage
  makes ≤ 2 upstream calls.

**Rollback.** Every item is independently revertible. The card refactor is the
only one with user-visible surface; revert that commit alone if needed.

---

## Phase 1 — Security hardening

**Objective.** Close all three High findings and the top Mediums. Runs in
parallel with P0/P2.

**Files.**
- `src/lib/factcheck/extract.ts:67` — adopt `lib/http.ts` (**S-04, S-05**)
- `src/lib/ratelimit.ts` — rewrite onto a Durable Object or the native
  rate-limiting binding (**S-01**); reject missing `cf-connecting-ip`, key IPv6
  on /64 (**S-02**)
- `src/lib/cache.ts:10-13` — SHA-256 the full claim, bump `fc:v1` → `fc:v2`
  (**S-03**)
- `src/pages/api/factcheck.ts:130,149` — body size limit, `MAX_CLAIM_CHARS`
  (**S-07**)
- `src/components/FactCheckWidget.astro:206` + server-side evidence filter —
  scheme validation (**S-12**); `SavedArticlesDrawer.astro:79` (**S-13**)
- New `src/middleware.ts` — CSP, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, `frame-ancestors` (**S-11**)
- `src/pages/api/ticker.ts` — KV cache 60 s + rate limit (**S-08**)
- New `src/pages/api/v1/weather.ts` using `request.cf`;
  `MastheadInfoStrip.astro` — delete the `ipapi.co` and `bigdatacloud.net`
  calls; geolocation only on explicit action (**S-09, A-07**)
- `src/layouts/Layout.astro:38-48` — consent gate or swap to Cloudflare Web
  Analytics (**S-10**)
- `.github/workflows/deploy.yml` — `npm audit --audit-level=high` (**S-16**)
- `public/robots.txt` — drop the stale `/admin` line (**S-18**)
- `wrangler.jsonc` — Durable Object binding

**Dependencies.** `lib/http.ts` and `lib/url.ts` from P0. The `v2` cache bump
should land with P3 if P3 is close, to avoid two invalidations.
**Database.** None (DO storage for counters).
**API.** New `/api/v1/weather`. `/api/factcheck` gains 413. `/api/ticker`
gains 429.
**Frontend.** Weather sourced server-side; no unprompted geolocation; possibly
a consent control.

**Tests.** Oversized body rejected; non-HTML content-type rejected; timeout
fires; prefix-colliding claims produce different cache keys; `javascript:` URL
never reaches the response or the DOM; middleware sets every expected header;
rate limiter is atomic under concurrency.

**Risks.**
- *CSP breaks inline scripts.* Four exist (`Layout.astro`). Mitigate: deploy
  `Content-Security-Policy-Report-Only` first, collect violations, then
  enforce. **Do not enforce on first deploy.**
- *Bounded fetch rejects legitimate slow publishers.* Mitigate: 5 s is
  generous; log rejections and tune. Failure degrades to `unverified`, which is
  honest.
- *Cache bump invalidates 24 h of results.* Acceptable and expected.
- *Rate-limit rewrite could lock out real users.* Mitigate: log-only mode for
  one day, compare against KV counts, then enforce.

**Rollback.** Middleware and the rate limiter are single files behind flags.
The cache bump is not rollback-able in a meaningful sense (old keys just go
cold) — harmless.

---

## Phase 2 — Data layer

**Objective.** Introduce D1 and move ingestion off the read path. Unblocks P5,
P7, P8. **Gated on D2.**

**Files.**
- `wrangler.jsonc` — D1 binding, Cron Trigger (`*/10 * * * *`)
- New `src/lib/db/client.ts`, `src/lib/db/migrations/0001_init.sql`,
  `src/lib/db/queries/{articles,clusters,factchecks}.ts`
- New `src/lib/news/ingest.ts` — scheduled job; reuses `newsdata.ts`,
  `guardian.ts`, `rss.ts` **unchanged**, plus the NewsData → Guardian → RSS
  fallback chain lifted verbatim from `api/news.ts:33-60`
- New `src/lib/news/canonical.ts` (slug + canonical URL),
  `src/lib/news/cluster.ts` (title-similarity + time-window clustering)
- Modify `src/lib/news/service.ts` — read D1, KV in front as a hot cache
- Modify `src/lib/news/types.ts` — `Article` gains `slug`, `clusterId`,
  `readingTimeSeconds`; `category` becomes our slug (fixes P-17)
- New `src/index.ts` or adapter hook for the `scheduled()` handler

**Dependencies.** P0 (`service.ts`, `url.ts`). Decision D2.
**Database.** First migration: `sources`, `articles`, `story_clusters`,
`fact_checks`, `fact_check_evidence`, the two FTS5 tables. Schema in
[`NEWZWALE_ARCHITECTURE.md`](NEWZWALE_ARCHITECTURE.md) §5.
**API.** `/api/v1/news` with cursor pagination. `/api/news` kept as an alias.
**Frontend.** None visible. Cards may gain reading time and coverage count once
the data exists.

**Tests.** Migration applies to an empty DB; canonicalisation table (utm
variants → one URL); clustering (same story from 4 sources → 1 cluster;
different stories → separate); ingest is idempotent (running twice creates no
duplicates); service returns the same shape the old API did.

**Risks.**
- *Clustering over-merges distinct stories.* This is the hardest correctness
  problem in the phase. Mitigate: start conservative (high similarity
  threshold, short time window), measure against a hand-labelled sample, tune
  toward merging. Under-merging is a missing feature; over-merging is a
  factual error.
- *NewsData free-tier quota.* Scheduled ingest at 10-minute intervals across
  8 categories × 13 languages is 144 combinations — far beyond free-tier
  limits. **Mitigate: ingest only `top` + the 4 rail topics in `en` + `hi` on
  the schedule (≈10 combos/run), and keep on-demand cached fetching for the
  long tail.** This must be sized against the real quota before building.
- *D1 write throughput during ingest.* Mitigate: batch inserts, `INSERT OR
  IGNORE` on the canonical-URL unique index.

**Rollback.** `service.ts` keeps its live-fetch path behind a flag; flip back
to it and the site works exactly as today. The D1 binding can stay unused.

---

## Phase 3 — Verdicts 4 → 6

**Objective.** Widen the enum end to end, correctly and honestly. **Gated on
D1.** No new evidence capability — that is P4.

**Files.** Full inventory in [`NEWZWALE_AUDIT.md`](NEWZWALE_AUDIT.md) §7.2.
- New `src/lib/factcheck/schema.ts` — the enum, defined once
- `types.ts:1`, `verdict.ts:6-37`, `google.ts:13`
- `api/factcheck.ts:37-48` (prompt), `:238` (basis branch)
- `FactCheckWidget.astro:187-192,258`
- `global.css` — verdict colour roles; `tests/contrast.test.ts` assertions
- `cache.ts` — `fc:v2` (coordinate with P1)
- Copy: `verify.astro:67`, `FactCheckPromo.astro:2-4`, `README.md`,
  `docs/WEBSITE-DOCUMENTATION.md`

**Also fix here:** `'no evidence'` is currently in `FALSE_WORDS`
(`verdict.ts:8`) — a "No evidence" rating means `UNVERIFIED`, not `FALSE`.
This is a live correctness bug, not a migration artefact.

**Dependencies.** Decision D1. Independent of P2.
**Database.** If P2 has landed: `CHECK` constraint on `fact_checks.verdict`.
**API.** Response `verdict` may now be any of six values. **Breaking for any
consumer** — versioning under `/api/v1` contains the blast radius.
**Frontend.** Six badges, each icon + label + colour.

**Tests.** Every rating string → expected verdict; `coerceVerdict` accepts six
and rejects the rest; the `'no evidence'` correction; contrast assertions for
every new pairing; cache-key versioning.

**Risks.**
- *Prompt change flips verdicts.* **This has already happened once** —
  `PROGRESS.md` records a terser prompt turning debunked claims from `false` to
  `verified`. Mitigate: build the golden set (30–50 claims, recorded evidence)
  **before** touching the prompt, and gate on zero confidently-wrong verdicts.
  Test both directions.
- *Two verdicts rarely emitted until P4.* `PARTLY_TRUE` and `NEEDS_CONTEXT`
  need the evidence model to be earnable. Mitigate: **say so on the methodology
  page.** Shipping a verdict the pipeline cannot reach, silently, would be the
  exact kind of small dishonesty this product opposes.
- *Stale cached results carry old verdict strings.* Mitigate: the `v2` bump is
  mandatory, not optional.

**Rollback.** Enum widening is additive at the type level; the UI falls back to
`unverified` for unknown values. Revert prompt and enum together — never
separately, or the model will emit values the code rejects.

---

## Phase 4 — Evidence model

**Objective.** Make the six verdicts *earned*. Implements principles 1, 3, 4,
6, 7 in code. Closes security S-06.

**Files.**
- New `src/lib/factcheck/claim.ts` — claim extraction (audit P-05)
- New `src/lib/factcheck/sources.ts` — provenance tiers
- New `src/lib/factcheck/evidence.ts` — dates, stance, quoted passages,
  read-method
- New `src/lib/factcheck/corroborate.ts` — independent domains, wire
  collapsing, strength. **Pure and exhaustively tested**
- New `src/lib/factcheck/prompt.ts` — fenced, injection-resistant construction
- New `src/lib/factcheck/pipeline.ts` — orchestrator lifted out of the route
- `types.ts` — `Evidence` gains `publishedAt`, `stance`, `qualityTier`,
  `quotedPassage`, `readMethod`, `injectionFlagged`; `FactCheckResult` gains
  `evidenceStrength`, `reasoning`, `limitations`, `id`, `independentDomainCount`
- `google.ts:6` — return **all** matching reviews, not the first
- `api/factcheck.ts` — thin route over `pipeline.ts`; certified and web
  retrieval run in **parallel** rather than short-circuiting

**Dependencies.** P3 (enum), P1 (`lib/http.ts`), P2 (persistence — or results
stay ephemeral).
**Database.** `fact_check_evidence` populated; `fact_checks.evidence_strength`,
`independent_domain_count`, `pipeline_version`, `model_id`.
**API.** `/api/v1/factcheck` returns the full evidence model.
**Frontend.** Result page rebuilt: strength meter, three evidence sections,
source chips, dates, read-method chips, limitations panel, claim confirmation
step.

**Tests.** Corroboration table test (domains × tiers × dates → strength); wire
collapsing; every verdict-gating downgrade rule including its `limitations`
entry; **injection fixture → verdict is not `true` and the flag is set**; date
extraction from all four metadata shapes with NULL when genuinely absent;
golden set at zero confidently-wrong.

**Risks.**
- *More model calls (stance per passage) → latency and cost.* Mitigate:
  parallelise; cap `MAX_SOURCES` at 5–6; measure p95 against the 6 s/12 s
  budget before shipping.
- *Verdict gating makes `unverified` far more common.* This is **correct
  behaviour**, but it will read as a regression. Mitigate: the limitations
  panel explains every downgrade, and the methodology page explains the
  corroboration rule.
- *Source tiering is a maintained list that will be wrong sometimes.* Mitigate:
  version-controlled, definitions shown to the reader, `other` as a safe
  default. Never guess a tier.
- *Claim extraction picks the wrong claim.* Mitigate: **that is exactly why the
  user confirms it** before the check runs.

**Rollback.** `pipeline.ts` is versioned; keep the P3 path behind
`pipeline_version` and fall back. Evidence fields are additive — the UI
tolerates their absence.

---

## Phase 5 — Routes and IA

**Objective.** Build the target route map.

**Files.** New `src/pages/news/index.astro`, `news/[slug].astro`,
`trending.astro`, `search.astro`, `fact-check/index.astro`,
`fact-check/[id].astro`, `fact-check/history.astro`, `saved.astro`.
Redirect `/verify` → `/fact-check` (301). `public/sitemap.xml` → generated, not
hand-maintained. New API routes under `/api/v1/`.

**Dependencies.** P2 (all data-backed routes), P4 (`/fact-check/[id]` needs the
full result), D3, D8.
**Database.** Read-only against P2's schema.
**API.** `/api/v1/{news,news/[slug],trending,search,factcheck,factcheck/[id]}`.
**Frontend.** New page shells; components arrive in P6.

**Tests.** Route smoke tests for status codes; unknown slug → 404 (matching the
existing `category/[slug].astro:15` pattern); `/verify` → 301; sitemap
generation; OG tags per verdict on `/fact-check/[id]`.

**Risks.**
- *SEO disruption from the `/verify` rename.* Mitigate: 301, update the
  sitemap, keep internal links pointing at the new URL, monitor Search Console.
- *Thin `/news/[slug]` pages get flagged as low-value by search engines.*
  Mitigate: the coverage cluster and fact-check panel are the original value —
  do not ship the page before clustering works.

**Rollback.** New routes are additive; the redirect is one line.

---

## Phase 6 — UI redesign

**Objective.** Implement [`NEWZWALE_UI_UX_SPEC.md`](NEWZWALE_UI_UX_SPEC.md).
Tokens unchanged.

**Files.** New `components/shell/BottomNav.astro`,
`components/shared/{Dialog,Skeleton,EmptyState,ErrorState}.astro`,
`components/factcheck/*` (11 new), `components/news/{CoverageList,TrendingList,
FactCheckChip,ReadingTime}.astro`. Rework `Navbar`, `MastheadInfoStrip`,
`HeroMesh`, `MostReadSidebar`, `FactCheckWidget`, `ArticleCard`.
Self-host fonts (replace `global.css:1`).

**Dependencies.** P5 (routes to put components in), P4 (evidence model to
render), P3 (six badges).
**Database.** None.
**API.** None.
**Frontend.** Everything.

**Tests.** Contrast assertions for every new pairing (**mandatory repo
convention**); keyboard-only pass per overlay; 320 px no-horizontal-scroll
check; Lighthouse against the P8 budget; visual check of server-rendered vs
client-appended cards.

**Risks.**
- *Scope creep into a full rewrite.* Mitigate: `ArticleCard`, `LeadStory`,
  `CategoryRail`, `LogoIcon`, `SavedArticlesDrawer` are **extended, not
  rebuilt**. The token layer is frozen.
- *Bottom nav collides with iOS Safari's chrome.* Mitigate: `safe-area-inset`,
  test on a real device.
- *One shared `Dialog` changes three existing behaviours at once.* Mitigate:
  migrate one overlay per commit.

**Rollback.** Per-component. `BottomNav` is additive and can be feature-flagged.

---

## Phase 7 — Search and trending

**Objective.** Real search over both corpora; transparent trending.

**Files.** New `src/lib/search.ts`, `src/lib/news/trending.ts`, FTS5 triggers
in a migration, `/api/v1/{search,trending}`, the two page bodies.

**Dependencies.** P2, P5.
**Database.** FTS5 virtual tables + sync triggers; `story_clusters.trending_score`.
**API.** `/api/v1/search?q&type&cursor`, `/api/v1/trending`.
**Frontend.** Search page, trending page, header search entry point. The
`HeroMesh` fake search is finally replaced.

**Tests.** FTS ranking; multilingual tokenisation (Devanagari, Tamil, Urdu —
**verify FTS5's default tokenizer actually handles these; it may need
`unicode61` tuning**); empty-query handling; trending score determinism;
injection-safe query construction.

**Risks.**
- *FTS5 tokenisation for Indic scripts is weak by default.* Mitigate:
  test with real Hindi/Tamil/Urdu content **early in the phase**; fall back to
  `LIKE`-based matching for scripts FTS handles poorly rather than shipping
  search that silently fails for 12 of 13 languages.
- *Trending looks empty at launch.* Needs ingest history. Mitigate: a
  well-designed empty state ("Not enough coverage yet to rank stories").

**Rollback.** Both routes are additive.

---

## Phase 8 — History and saved

**Objective.** Make HISTORY and SAVED real product areas. **Gated on D5.**

**Files.** New `src/lib/store.ts` (IndexedDB, migrating existing
`localStorage` keys), `fact-check/history.astro`, `saved.astro`, verdict filter
chips. Retire the drawer in favour of the page, or keep both.

**Dependencies.** P5, P6, D5.
**Database.** None if device-local (recommended).
**API.** None if device-local.
**Frontend.** Two new pages; migration of `nz_saved`/`nz_topics` from
`localStorage` with the old keys read as a fallback so nothing is lost.

**Tests.** Migration preserves existing saved articles; filters; quota
exhaustion handled; empty states.

**Risks.**
- *Users expect sync and there is none.* Mitigate: say so plainly in the empty
  state and in `/about` — do not bury it.
- *IndexedDB in private browsing.* Mitigate: feature-detect, fall back to
  `localStorage`, degrade honestly.

**Rollback.** Keep `localStorage` writes in parallel for one release.

---

## Phase 9 — PWA

**Objective.** Installable, offline-capable mobile experience. **Gated on D6.**

**Files.** New `public/sw.js`, registration in `Layout.astro`, update
`public/site.webmanifest` (add `start_url`, `scope`, `shortcuts`, and non-maskable
icon variants — currently **both** icons are `purpose: maskable`, which is
wrong for the standard display context), offline fallback page, install prompt.

**Dependencies.** P6.
**Database.** None.
**API.** None.
**Frontend.** Service worker; offline reading for saved articles.

**Tests.** Offline shell loads; cache versioning; update flow does not serve a
stale shell indefinitely; install prompt appears once.

**Risks.**
- *A buggy service worker can serve stale content permanently — the classic PWA
  footgun.* Mitigate: network-first for HTML and API, cache-first only for
  static assets; ship a kill-switch that unregisters on demand.

**Rollback.** Unregister the service worker and serve an empty `sw.js`. Test
this path **before** shipping, not after.

---

## Phase 10 — Documentation, analytics, launch

**Objective.** Close the loop.

**Files.** Update `README.md`, `docs/WEBSITE-DOCUMENTATION.md`, `AGENTS.md`,
`PROGRESS.md`; add `/about` methodology; analytics events; a real deploy step
in `.github/workflows/deploy.yml` (audit P-14 — the file is named `deploy.yml`
and does not deploy).

**Dependencies.** All.
**Tests.** Full suite; manual accessibility pass; performance budget check;
security re-review confirming zero open Highs.

**Analytics** (privacy-preserving, no PII): `factcheck_submitted` (input type),
`factcheck_result` (verdict, basis, strength, duration), `search_performed`
(result count, not query text), `article_opened` (category, source).

---

## Files that will eventually need modification

Consolidated. **Nothing in this list has been touched.**

### Modified
```
src/lib/factcheck/types.ts          P3 P4    verdict enum, evidence + result fields
src/lib/factcheck/verdict.ts        P3       6-way mapping; 'no evidence' bug
src/lib/factcheck/google.ts         P3 P4    skip condition; return all reviews; languageCode
src/lib/factcheck/search.ts         P4       MAX_SOURCES; date capture
src/lib/factcheck/extract.ts        P1 P4    bounded fetch; metadata extraction
src/pages/api/factcheck.ts          P1 P3 P4 limits; prompt; thin route over pipeline.ts
src/lib/cache.ts                    P1 P3    SHA-256 key; fc:v2
src/lib/ratelimit.ts                P1       Durable Object rewrite
src/lib/news/types.ts               P2       slug, clusterId, readingTime; our category
src/lib/news/feed.ts                P0 P2    isSafeUrl → lib/url.ts; canonical dedup
src/lib/news/categories.ts          P2       category mapping on write
src/pages/api/news.ts               P0 P2    thin wrapper; real status codes
src/pages/api/ticker.ts             P1       cache + rate limit
src/pages/index.astro               P0 P6    no self-fetch; recomposed
src/pages/verify.astro              P3 P5    copy; → /fact-check
src/pages/category/[slug].astro     P2 P6
src/layouts/Layout.astro            P0 P1 P6 lang/dir; analytics; nav; fonts
src/components/NewsFeed.astro       P0 P6    delete buildCard() and the dup helpers
src/components/ArticleCard.astro    P2 P6    reading time, coverage, fact-check chip
src/components/FactCheckWidget.astro P3 P4 P6 six verdicts; evidence model; one input
src/components/Navbar.astro         P6       split; focus management
src/components/MastheadInfoStrip.astro P1 P6 remove 3rd-party calls; relocate controls
src/components/HeroMesh.astro       P0 P6    no self-fetch; real search
src/components/MostReadSidebar.astro P6      make it real or rename it
src/components/FactCheckPromo.astro P3       verdict copy
src/components/SavedArticlesDrawer.astro P1 P6 URL validation; dialog semantics
src/styles/global.css               P3 P6    verdict roles; self-hosted fonts
wrangler.jsonc                      P1 P2    D1, DO, cron bindings
.github/workflows/deploy.yml        P1 P10   npm audit; an actual deploy step
public/robots.txt                   P1       drop /admin
public/sitemap.xml                  P5       generate it
public/site.webmanifest             P9       start_url, scope, icon purposes
README.md · docs/WEBSITE-DOCUMENTATION.md · AGENTS.md · PROGRESS.md   P3 P10
tests/factcheck/verdict.test.ts     P3       six values; 'no evidence'
tests/factcheck/google.test.ts      P3
tests/contrast.test.ts              P3 P6    every new pairing
```

### New
```
src/middleware.ts
src/lib/{http,url,search,store}.ts
src/lib/db/{client.ts,migrations/,queries/}
src/lib/news/{service,ingest,canonical,cluster,trending}.ts
src/lib/factcheck/{schema,claim,sources,evidence,corroborate,prompt,pipeline}.ts
src/pages/api/v1/{news,news/[slug],trending,search,factcheck,factcheck/[id],weather,ticker}.ts
src/pages/{news/index,news/[slug],trending,search,saved}.astro
src/pages/fact-check/{index,[id],history}.astro
src/components/shell/BottomNav.astro
src/components/shared/{Dialog,Skeleton,EmptyState,ErrorState}.astro
src/components/factcheck/*        (11 components)
src/components/news/{CoverageList,TrendingList,FactCheckChip,ReadingTime}.astro
public/sw.js
tests/**                          (~15 new files)
```

### Deleted
```
DECISIONS.md                       D7 — stale, actively misleading
NewsFeed.astro buildCard()         P0 — duplicate of ArticleCard.astro
MastheadInfoStrip ipapi/bigdatacloud calls   P1 — S-09
```

---

## Cross-cutting risks

| Risk | Mitigation |
|---|---|
| **Prompt regression flipping verdicts** — has happened before | Golden set built **before** any prompt edit; test both directions; gate CI on it |
| **`unverified` rate rises after P4** and reads as a regression | It is correct behaviour. Explain every downgrade in `limitations`; document the corroboration rule publicly |
| **NewsData free-tier quota** cannot cover 8 categories × 13 languages on a schedule | Size against the real quota in P2 planning; schedule a small core, keep on-demand caching for the tail |
| **Clustering over-merges distinct stories** | Start conservative; hand-labelled sample; under-merging is a missing feature, over-merging is a factual error |
| **FTS5 tokenisation for Indic scripts** | Test with real content early in P7; fall back rather than ship silently-broken search |
| **Scope creep into a rewrite** | Tokens frozen; five components extended not rebuilt; the news and fact-check provider modules are reused verbatim |
| **CSP breaking the site** | Report-Only first, always |
| **Service worker serving stale content forever** | Network-first for HTML/API; ship and *test* a kill-switch |
| **Losing the honesty the codebase already has** | Every phase re-reads the principle conformance table in `NEWZWALE_AUDIT.md` §6 |

---

## Definition of done, per phase

1. `npm test` green, with new tests covering the phase's logic
2. `npx astro check` — zero errors
3. `npm run build` completes
4. No new High or Medium security finding
5. Contrast assertions added for any new colour pairing
6. Keyboard-only pass on any new interactive pattern
7. `PROGRESS.md` updated per its own handoff protocol
8. No existing functionality silently removed
