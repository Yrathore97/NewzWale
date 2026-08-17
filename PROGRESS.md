# PROGRESS.md

This is the handoff log. Read it before starting work, regardless of which
model or agent you are. Update it when you finish a task, hit a stopping
point, or are about to run out of context — so the next agent (possibly a
different model) can continue without the user re-explaining anything.

Full task list and rationale: `docs/superpowers/plans/2026-08-05-newzwale-rebuild.md`

---

## Status — Fact-check retrieval fixes MERGED AND LIVE; CI now auto-deploys

**Deployed to production.** PR #31 merged to `main` as `15342e8` and shipped
(Worker version `35f184b1-6fbb-448d-89e6-8c86fe55ef53`). Verified against the
live site: `https://www.newzwale.com/api/v1/factcheck` returns
`pipelineVersion 5 / evidenceVersion 5` with a single honest
`insufficient_corroboration` and no fabricated contradictions.

**Deploy was never actually blocked.** Prior notes said it needed
`CLOUDFLARE_API_TOKEN`; that env var is indeed unset, but `wrangler` is
authenticated by **OAuth** (`workers_scripts: write`, `d1: write`). Check
`npx wrangler whoami` before recording a deploy blocker again. All four API
keys were already present as Worker secrets — `.dev.vars` is local-only and is
not what production reads.

**Releases are now automatic** (`claude/ci-auto-deploy`, closes P-14):
`.github/workflows/deploy.yml` runs `npx wrangler deploy` after the existing
audit/test/check/build gate, restricted to `push` events on `main` so a
pull_request run can never publish unreviewed or fork-authored code. **Merging
to `main` is now a release.**

**1098 tests pass** (1074 + 24 new), `astro check` 0/0/0, build PASS, golden
set 15/15 with no verdict flips.

### The reported symptom

"When I do a fact check it shows an evidence list but nothing on the evidence
bar, and still says unverified." Investigated against a real claim — *"The Agra
Lucknow Expressway was built by the state government of Uttar Pradesh, not the
BJP government"* — using live Tavily + Google Fact Check credentials. Four
genuine defects, all in RETRIEVAL and CONTRADICTION handling. None in the gate.

1. **Query targeting** (`faa054d`). The claim was sent to search verbatim, so
   the trailing clause it REFUTES ("not the BJP government") was weighted like
   any other keyword and pulled results toward the denied party. A trailing
   contrastive clause is now dropped before retrieval; Tavily's pool went 5→8.
   `extracted.text` is unchanged, so nothing downstream judges a different
   claim.
2. **Cache identity not bumped** (`8f09ed8`). #1 changed what is retrieved
   without moving a version constant, so every previously-checked claim would
   have kept serving its pre-fix verdict and the fix would have looked inert.
   Exactly the failure `version.ts` already documents against PIPELINE_VERSION
   3. EVIDENCE_VERSION 3→4.
3. **HTML attribute payloads leaking in as article text** (`17d89ba`).
   Wikipedia's Parsoid HTML stores a page's infobox and citation wikitext in a
   SINGLE-quoted `data-mw='{...}'` attribute whose JSON contains both `>` and
   nested double quotes (~1,200 chars on the article in question). The naive
   `<[^>]+>` tag strip — in THREE separate copies — ended the tag inside that
   JSON, and `stripChrome`'s non-chrome branch re-emitted the remainder as
   prose. The stance classifier was handed `{{cite news|...}}"},"state":...`
   and correctly returned "unclear", so a relevant source contributed nothing.
   Fixed with one shared quote-aware pattern. Also excludes a measured
   junk-domain list from Tavily. EVIDENCE_VERSION 4→5.
4. **Unqualified disagreements vetoing every verdict** (`b1af356`). gate.ts
   RULE 2 forbids an assertive verdict on a material contradiction and runs
   BEFORE every corroboration floor, but two paths reached it unvalidated. The
   live claim collected FOUR spurious vetoes: three numeric conflicts between
   pages measuring different roads (302 km vs 8.3 km vs 49.96 km — a different
   2025 project), none of which counted toward corroboration; and one
   model-reported contradiction citing a single source whose text actually
   SUPPORTED the claim. Now: a numeric conflict where neither side cleared the
   corroboration bar is `minor`; a model contradiction naming fewer than two
   distinct sources is `minor`. Both demote-only. PIPELINE_VERSION 4→5.

### Architectural decisions recorded

- **Evidence sourcing stays Google Fact Check + Tavily.** Noozra and raw Google
  Search were both evaluated and DECLINED by the user this session. Noozra
  re-aggregates outlets under sub-brand labels, which corrupts independent-source
  counting; raw Search has no gating (its top source for this very claim was a
  political party's own site). Do not re-propose either without new reasoning.
- **No new dependency was added.** The junk-domain fix uses Tavily's existing
  `exclude_domains` request field, not a new provider.
- **No floor, tier rule or verdict semantic was weakened.** Every fix is
  demote-only or retrieval-only. This was checked deliberately, because three
  of the four fixes make assertive verdicts *more* reachable.

### Outcome, stated honestly

The test claim **still returns UNVERIFIED**, and that is correct — 1 independent
supporting domain against a floor of 2. What changed is that the reason is now
true: a single `insufficient_corroboration` ("No independent source established
this claim either way") instead of four fabricated "credible sources materially
disagree" findings about three different roads. Evidence strength moved
`none` → `weak`; `upeida.up.gov.in` (tier1) is now retrieved and supporting,
and Wikipedia now yields real prose.

### Known-remaining, NOT fixed

- **Retrieval is topic-scoped, not event-scoped.** A 2025 expressway-expansion
  article is still retrieved for a claim about a 2016 construction. The
  contradiction fix stops it vetoing, but it still occupies an evidence slot.
  A real fix needs the pipeline to reason about whether two sources describe
  the same event before comparing their figures. Unscoped, unbuilt.
- **The model reads "UPEIDA" as distinct from "the state government of UP"**,
  when UPEIDA is a UP state authority. Visible in the summary text. Fixing it
  means touching `prompt.ts`, which §5 flags as high-risk; deliberately not
  attempted, and note it was NOT what blocked this claim.

---

## Status — Cron ingestion live; /trending, /search, /news/[slug] now have real data

Built on the D1 activation (`5be9d21`) and the fact-check banner fix
(`1a142c4`). **1074 tests pass** (1067 + 7 new), `astro check` 0/0/0/0,
build PASS.

### The reported symptom, and what it actually was

Reported: "trending fact check and search nothing is working." Three
different causes, only one of which was a code defect:

1. **Fact Check — a real bug** (`1a142c4`, PR #27). The error wrapper was a
   `<p>` containing `<ErrorState>`, whose root is a block-level `<div>`. The
   HTML parser auto-closes an open `<p>` before a block child, so the browser
   hoisted the banner OUT of the wrapper and left it empty. `hidden` toggled
   an empty `<p>` while the real banner stayed permanently visible — every
   visitor to `/fact-check` saw "Couldn't check that claim" at all times,
   *including next to a valid verdict*, which is what made a working checker
   look broken. The API was never at fault (both `/api/factcheck` and
   `/api/v1/factcheck` returned 200 with a correct verdict throughout).
   The same bug silently killed the line-305 selector that swaps in a
   specific API error message. Grepped for the same invalid nesting
   elsewhere — this was the only instance.
2. **Search and Trending — not broken, genuinely empty.** See below.
3. (No third defect — `/news/[slug]` 404s had the same cause as 2.)

### Why the feed was empty: `ingest()` had no caller

D1 was provisioned and migrated last session, but **nothing ever wrote to
it**. `ingest()` existed, was tested, and was called from nowhere. Activating
the database was necessary but not sufficient — a fact the previous status
entry understated.

`src/lib/news/schedule.ts` (new) is that missing caller, invoked from a new
`scheduled()` handler in `src/worker.ts`. `wrangler.jsonc` `main` now points
at `./src/worker.ts` (a cron trigger calls `scheduled()` on the default
export; the adapter's entrypoint exports only `fetch`) and the cron trigger
is enabled.

### The schedule is quota-sized, which is why it was never on by default

One tick spends one NewsData request per category:

```
8 categories × 12 ticks/day = 96 NewsData requests/day
```

against a documented 200/day free tier. Deliberately ~half, because the
on-demand read path (`/api/news`) spends from the **same** quota on a cache
miss. **English only** for the same reason — adding a language multiplies the
cost by the number of languages, exactly the trap Phase 2's risk note names.
The other twelve languages remain served on-demand, as before.

`runScheduledIngest` is contractually non-throwing: Cloudflare retries a cron
invocation that rejects, and a retry would re-spend metered quota on the
categories that already succeeded. Categories run sequentially, each
independently guarded, and `failedProviders` is carried through so a degraded
provider is visible in the log rather than hidden behind a healthy `ok: true`.

### Verified against the real cron tick (20:00 UTC), not a simulation

`wrangler dev --remote --test-scheduled` does **not** intercept
`/__scheduled` — the request passes through to the app and 404s. And the
provider keys exist only as Cloudflare secrets (no local `.dev.vars`), so
ingestion cannot be run locally at all. The first real scheduled tick was
therefore waited for and observed:

- **143 articles**, **141 clusters** (2 with ≥2 independent sources)
- `/api/v1/trending` → ranked multi-source stories, not `[]`
- `/api/v1/search?q=india` → real headlines
- `/trending` renders a ranked list; `/search` renders real results
- `/news/[slug]` → **200** for a real slug (was 404 for every id)

### Known, expected: trending is sparse at first

Only 2 clusters currently clear the ≥2-independent-source floor, because
clustering is deliberately conservative (Jaccard ≥0.75, under-merges on
purpose — a missing "also reported by" beats claiming corroboration that does
not exist). Breadth builds as successive ticks accumulate coverage. This is
the designed behaviour, not a defect.

### Deployment

`main`@`6c1cd47`, Worker version `9bae4fdf-ae27-4569-a8c2-bbffe153b8b9`,
`schedule: 0 */2 * * *` registered. Site verified healthy under the new
entrypoint (`/`, `/news`, `/fact-check`, `/trending`, `/search`, `/about`,
`/saved` all 200).

## Status — D1 activated in production COMPLETE

Built on the audit's fix (`67b8255`). Cloudflare D1 provisioned and wired
for the first time — the last "PREPARED, NOT YET ACTIVE" gap in
`wrangler.jsonc`, open since Phase 0.

**1067 tests pass** (unchanged), `astro check` 0/0/0/0, production build
PASS, `npm audit --audit-level=high` 0 vulnerabilities.

### What changed

- **D1 provisioned:** `wrangler d1 create newzwale` (region APAC), database
  `6093befe-8889-4e28-bb1d-471d07d8c18d`, bound as `NEWZ_DB`. Confirmed empty
  before migrating.
- **Both migrations applied to the remote database**, not just local:
  `0001_init.sql` and `0002_nullable_published_at.sql`. Verified against the
  live schema, not just assumed: six-verdict `CHECK` rejects the retired
  `'verified'` value and accepts all six current ones; `DELETE` and
  substantive `UPDATE` on `fact_checks` both blocked by the append-only
  triggers; `published_at` accepts `NULL`.
- **`db:migrate:local`/`:remote` fixed** — previously applied only `0001`,
  silently skipping `0002`. Now chains both. Both are independently
  idempotent (confirmed by `tests/db/migration-0002.test.ts`), so this is
  safe even against an already-migrated database.
- **Fact-check persistence verified end-to-end** with a synthetic test
  claim ("NASA confirmed a new comet named Halley-2..." — obviously
  fictional, not real personal data, per the instruction to use synthetic
  data): submit → parallel evidence retrieval → verdict → D1 insert →
  public shareable `/fact-check/[id]` page → FTS search match. Confirmed the
  persisted row stores `user_id: NULL`, `device_hash: NULL` — no IP, no
  fingerprint, matching `/privacy`'s disclosure. **This synthetic row is
  permanent** by design — `fact_checks` is append-only and the append-only
  trigger was itself verified live by attempting (and having Cloudflare
  reject) a `DELETE` on it.
- **A real defect found during verification, fixed:** the first real
  evidence ever rendered on `/fact-check/[id]` (an Instagram source) had a
  quoted passage that was raw bundler JSON with no whitespace — no natural
  break point — which forced the page wider than the viewport below
  `1024px`. Fixed with `[overflow-wrap:anywhere]` on the shared evidence
  blockquote (`EvidenceItem.astro`). Does **not** touch
  `src/lib/factcheck/extract.ts` (protected, and a separate, larger
  question about content quality on JS-rendered source pages — flagged
  below, not fixed).
- **An unrelated, freshly-disclosed dependency advisory caught by CI**
  (`nanoid <3.3.18`, high severity, GHSA-2v37-7h3g-55p8) — disclosed after
  the audit's last clean run, not introduced by this work. `nanoid` is a
  transitive, build-time-only dependency of PostCSS (Tailwind's pipeline),
  never bundled into the deployed Worker. `npm update nanoid` resolved it
  in a 4-line lockfile diff.

### D1-dependent routes: 503 → 200 (honestly empty, not fabricated)

`/api/v1/trending`, `/api/v1/search`, `/api/v1/news` all now return `200`
instead of `503 UPSTREAM_UNAVAILABLE`. Because **no ingestion job has ever
run** (Cron is still commented out, still out of scope), the database has
zero articles — so `/trending` and `/search` correctly render their
documented empty states ("Not enough coverage yet to rank stories", "No
indexed headlines match that search"), not an error and not fabricated
content. `/news/[slug]` still 404s for any article id, because no articles
exist yet to look up — also correct, not a regression.

### Deployment

`main`@`89a92df`, Worker version `9737a542-6c57-4594-8d52-6230e0644c72`.
Deployed and verified live, including the header/console/overflow checks
above, on the actual production domain.

### Deliberately not done — Cron/ingestion is a separate task

D1 being active does not mean the site has content yet. Populating
`/trending`, `/search` and `/news` with real articles needs the Cron
ingestion pipeline, which stays commented out in `wrangler.jsonc` — its
schedule is explicitly documented as needing to be set only after measuring
provider quota (143 category×language combinations against a free tier),
and that measurement has not been done. Not attempted here; out of scope.

## Status — Full production health audit (post-P10) COMPLETE — one P1 fixed

Built on the P10 merge (`944adeb`). Full end-to-end audit of every route, API,
service integration, PWA behavior and security header against the live
production deployment — not just source inspection. One real defect found and
fixed; everything else audited came back healthy.

**1067 tests pass** (unchanged — the fix is pure CSS with no behavioral
assertions to add), `astro check` 0/0/0/0, production build PASS, `npm audit`
0 vulnerabilities.

### P1 bug found and fixed: BottomNav safe-area padding silently defeated

`src/styles/global.css:168` declared `body { margin: 0; padding: 0; ... }`
**outside any `@layer`**. Tailwind's utilities live in `@layer utilities`
(loaded via `@import "tailwindcss"`), and per the CSS Cascade Layers spec an
unlayered declaration beats a layered one regardless of specificity or source
order. This unconditionally defeated `Layout.astro`'s
`pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))]` on `<body>`, on every
route under `lg:` — meaning the last ~56-90px of every mobile page was
trapped under the fixed `BottomNav` with no way to scroll to it. This is the
exact failure the padding utility's own comment says it prevents, and it
almost certainly dates to P6 (when that safe-area padding was introduced),
not to anything in this session.

**Verified live on production before the fix:** computed `padding-bottom` on
`<body>` at 375px width was `0px`; at max scroll the footer's bottom sat
56-90px below `BottomNav`'s top.

**Fix:** removed the redundant, conflicting `margin`/`padding` from the
unlayered rule. Tailwind Preflight (enabled by default) already zeroes
`body`'s margin/padding inside its own `@layer base`, so deleting the
duplicate lets the utility classes win as the cascade intends.
`font-family`/`background-color`/`color`/`transition` untouched.

**Verified live on production after the fix:** `padding-bottom: 56px` at
375px in both themes, `0px` at 1280px (`lg:pb-0` — nav is `lg:hidden`, no
clearance needed), footer clears `BottomNav` exactly at max scroll (footer
bottom `755.6px` vs. nav top `755.2px`).

Shipped as [PR #23](https://github.com/Yrathore97/NewzWale/pull/23) →
`393873b`, deployed as Worker version `c29e1334-5e60-4c14-92e2-4ac8321a0715`.

### Everything else audited — no other defects found

- **All 19 page routes + 12 API routes** — every static/prerendered route
  200s; dynamic routes (`/news/[slug]`, `/fact-check/[id]`,
  `/api/v1/{news,search,trending}`) correctly 503/404 while D1 is
  unprovisioned, never a fake empty success; `/verify` 301s to `/fact-check`.
- **Fact-check pipeline, live, real claims:** a real claim ("RBI kept the
  repo rate unchanged") returned `true` with 4 independently-sourced,
  corroborating citations in ~15s; the identical claim repeated hit the 24h
  KV cache and returned in 0.35s; a nonsense claim ("purple goats run the
  Belgian postal service") correctly returned `unverified` with zero
  fabricated evidence. No `id` returned on either — correct, since D1 being
  unprovisioned means no shareable record is created.
- **Search:** SQL-injection and wildcard-abuse payloads produce no anomalous
  behavior (D1 unreachable in production to test the live path further;
  safety is covered by 133 passing D1/repository tests including a dedicated
  multilingual-search suite, run against real SQLite).
- **Saved / history device-local storage, live:** save → unsave → poison
  `localStorage` with wrong-shape JSON → app recovers cleanly to an empty
  array, both for saved articles and for the rendered `/fact-check/history`
  page (all six verdict counters correctly show 0, no crash).
- **PWA, live:** service worker registered and active at scope `/`;
  `/offline/` precached at `status: 200` (not a redirect); real navigations
  populate the page cache correctly while plain `fetch()` calls correctly do
  not (matches the `mode === 'navigate'` gate in `sw.js`); `KILL_SWITCH =
  false` confirmed in the deployed file; manifest icons confirmed `purpose:
  any`, never a false `maskable` claim.
- **Security headers, live, all 11 prerendered routes:** full CSP/
  Permissions-Policy/X-Frame-Options/X-Content-Type-Options/Referrer-Policy/
  HSTS present on every one, both before and after the CSS fix deploy.
- **CI/CD:** confirmed by reading the workflow, not assumed — push/PR to
  `main` runs `npm audit --audit-level=high` → tests → `astro check` →
  build; it does **not** deploy, matching every prior audit's finding.
- **Cross-site DELETE to `/api/news` returns 403 from Cloudflare's own edge
  CSRF protection** ("Cross-site DELETE form submissions are forbidden") —
  not an application-level finding, noted so a future session doesn't
  mistake it for one.

### Not independently re-verifiable this session

- **True network-kill offline testing.** No network-throttle API was
  exposed by the available browser tooling. Re-confirmed via cache
  inspection (`/offline/` precached, correct status) rather than an actual
  live disconnect; the real disconnect test was performed and passed in the
  P9 session (see that entry above) and nothing in this session's changes
  touches `public/sw.js`.

## Status — P10 UNBLOCKED WORK COMPLETE — P10 AS A WHOLE IS NOT

Built on P10.1b (`c1e8376`). Four items, four commits, no protected path
touched by any of them. **1067 tests pass** (1056 → 1067, +11 new; 0 removed,
weakened or skipped), `astro check` 0/0/0/0, production build PASS.

### Delivered

**S-11 — security headers for prerendered routes** (`f66b8c6`).
`prerender = true` pages are served by the Workers Assets binding and never
reach `src/middleware.ts`, so eleven routes shipped with no CSP, no
Permissions-Policy, no `X-Frame-Options` and no HSTS. The gap was recorded at
`src/middleware.ts:10-14` and widened with every phase that added a static
page. New `public/_headers` closes it.

Because the policy now lives in two places, `tests/security/headers-file.test.ts`
parses the shipped `_headers` and asserts it equals `securityHeaders()`
exactly — drift fails the suite instead of silently weakening the policy on the
pages nobody re-tests. `src/lib/security/headers.ts` itself was **not** touched.

Verified against `wrangler dev`: all eleven prerendered routes plus `/404` now
carry the full set; SSR routes still get theirs from middleware; the adapter's
immutable `/_astro/*` Cache-Control injection still happens (it *prepends* to
our file and skips injection entirely if we declared Cache-Control, which is
why `_headers` must not).

**P1 — robots.txt** (`42135c0`). Dropped `Disallow: /admin`, a route deleted in
Phase 0 with the auth it guarded. Verified before removing: zero `/admin`
references in `src/`, route returns 404. `Disallow: /api/` kept — those exist.

**S-16 — npm audit CI gate** (`91cfca4`). Added
`npm audit --audit-level=high`, exactly the remediation the security audit
prescribes, placed **before** the build's Dependabot `if:` guard so it also
gates dependency-bump PRs (it needs no secret). `npm audit` currently reports
**0 vulnerabilities**, so no dependency version was changed to make it pass.

**Documentation sync** (`9ba7822`). `README.md`,
`docs/WEBSITE-DOCUMENTATION.md`, `AGENTS.md`. Retired four-verdict terminology
removed everywhere; six verdicts, parallel retrieval and the deterministic gate
described as they actually work. Test count 131 → 1067. Node ≥ 22.12 → ≥ 23.4.
`GUARDIAN_API_KEY` added to the env template. D1 documented *with* its
unprovisioned status rather than implied working. PWA, `/search`, `/trending`,
`/fact-check/history`, `/saved` and `public/_headers` documented for the first
time. `AGENTS.md` no longer points at `astro dev --background`, which is not a
real command.

### Corrected a long-standing contradiction

`README.md` claimed a live site; this file's "Deferred" section said the domain
was not owned. **README was right.** `https://www.newzwale.com` returns 200 and
`docs/WEBSITE-DOCUMENTATION.md` §6 independently records the domain as bound to
the Worker via the Cloudflare dashboard. The stale line below is struck through
rather than deleted, so the correction is visible.

### Deployment — BLOCKED, not done

`npm run build` passes and the output is deployment-ready. `npm run deploy`
(`astro build && wrangler deploy`) was **not run**: it needs Cloudflare
credentials that are not present in this environment, and `CLAUDE.md` §16
forbids fabricating them. Nothing was deployed; the live site is unchanged by
this work.

### Still blocked / deferred (unchanged by this pass)

- Cloudflare deploy — needs `CLOUDFLARE_API_TOKEN`.
- D1 provisioning — needs `wrangler d1 create newzwale` and the real
  `database_id`.
- `db:migrate:local`/`:remote` apply only `0001_init.sql`; `0002` never runs.
  Fixing it means editing `package.json`, a protected path — needs
  authorization.
- Analytics events — depend on the unresolved GA consent decision (S-10).
- Performance budget — the plan references a "P8 budget" that does not exist.

### Unrelated finding, not acted on

`src/layouts/Layout.astro:77` hardcodes `<meta name="robots" content="index,
follow">` with no per-page override, so `/offline`, `/saved` and
`/fact-check/history` advertise as indexable. They are absent from
`sitemap.xml`, so discovery is unlikely, but a `noindex` prop would be the
honest fix. Out of scope for the authorized items; not changed.

## Status — P10.1b (Privacy policy honesty/data-flow correction) COMPLETE — P10 AS A WHOLE IS NOT

Built on the CLAUDE.md commit (`5f445cb`). Copy-only, one prerendered page.
**Zero diff** over every protected path listed in `CLAUDE.md` §4. No new
dependency, no new token, no new contrast pairing.

**1056 tests pass** (unchanged — no logic added), `astro check` 0/0/0/0,
production build PASS.

### Unsupported claims removed

`src/pages/privacy.astro` described a product with accounts. Verified by grep,
not assumed:

| Claim | Reality |
|---|---|
| "account credentials (name and email when you sign up)" | No signup, no auth anywhere in `src/`; deleted in Phase 0 |
| "authenticating your account" | Same |
| "Google for authentication (OAuth)" | No OAuth flow, library or callback route exists |
| "delivering your saved bookmarks **across devices**" | `src/lib/saved.ts` is `localStorage`-only; directly contradicted `/saved`'s own copy |
| "delete… from your account settings" | No account-settings route exists |
| "retain account data for as long as your account remains active" | No accounts to retain data for |
| "…local storage to remember your theme, language preference, **and authentication session**" | No auth session to store |
| "Minimal cookies may be used" | No `document.cookie`/`Set-Cookie` anywhere in `src/` |
| "communicated… via our news feed" | No feed-announcement mechanism exists |

### localStorage keys verified against source

The policy now enumerates only keys that actually exist: `theme`,
`userLanguage` + `userLanguageName` (`Navbar.astro:296-297`), `nz_saved` and
`nz_topics` (`saved.ts:23-24`), `nz_factcheck_history`
(`factcheck-history.ts:17`), `nz_install_prompted` (`Layout.astro:277`).
Sync is stated as absent, matching the device-local P8 interpretation.

### Honest disclosures added (each source-backed)

- **Cookies:** NewzWale sets none of its own; Google Analytics sets its own.
- **Analytics consent — limitation disclosed, not invented.** GA loads on
  every page and there is no in-product consent control (S-10, still open).
  The policy says so plainly and points at browser-level blocking, rather
  than describing a consent mechanism that does not exist.
- **IP / rate limiting:** `ratelimit.ts:79` reads `cf-connecting-ip`.
- **Weather location:** city-level approximation from `request.cf`, used
  server-side only and never passed to a third party
  (`api/v1/weather.ts:27`); precise geolocation stays disabled via
  `permissions-policy: geolocation=()`.
- **Third-party fact-check processing:** a submitted claim reaches Google
  Fact Check Tools (`google.ts:4`), Tavily (`search.ts:31`) and Cloudflare
  Workers AI (`version.ts:84`).
- **Caching:** 24 h, per `CACHE_TTL` (`factcheck/route.ts:30`).
- **Fact-check persistence / public record:** `persistFactCheck` writes the
  claim text to D1 and `/fact-check/[id]` renders it publicly. Worded as
  "where the public fact-check archive is enabled" — accurate today (D1 is
  unprovisioned, so nothing persists) and still accurate once it is
  provisioned, so the policy does not go stale on that switch.
- **Explicit user warning added:** do not submit personal, confidential or
  identifying information as a fact-check claim.

### Browser QA (wrangler dev, port 8787)

`/privacy` at **375×812** and **1280×900**: no horizontal overflow at either
width. 10 sections render. All nine retired phrases absent from rendered
text; the new disclosures present. Light and dark both render with existing
tokens only. All seven footer internal links resolve 200.

**Not verified:** no screenshots (the browser pane was not compositing, so
frame capture and coordinate clicks were unavailable) — rendered-text
extraction and computed-geometry checks were used instead. No screen-reader
pass (no AT available in this environment).

### NOT independently verified — legal/policy questions still open

These were left alone because code cannot confirm or deny them, and this pass
made no attempt to validate them: the data-selling commitment (the old
"we never sell your personal data" sentence went with its section and was
**not** re-asserted — restoring it as an explicit promise is a decision for
you), "access restricted to authorized personnel", the regulatory-compliance
language, and "our editorial and data-protection team" in Contact Us (implies
a formal DPO structure). Treat all of these as unreviewed.

### Correction to an earlier audit note

The P10.1b discovery pass recorded that the language preference "is a query
param, not stored". **That was wrong** — `Navbar.astro:296-297` writes
`userLanguage`/`userLanguageName` to `localStorage`. Caught before writing;
the policy lists it among device-local data.

## Status — P10.1 (About/Terms honesty fix) COMPLETE — P10 AS A WHOLE IS NOT

Built on P9 (`6d378cd`). Copy-only, two prerendered pages. **Zero diff** over
every protected path: `src/pages/api/`, `src/lib/factcheck/`, `src/lib/db/`,
`src/lib/security/`, `wrangler.jsonc`, `package.json`, `package-lock.json`,
`astro.config.mjs`, `public/sw.js`, `src/lib/saved.ts`, `src/lib/history/`.
No new dependency, no new token, no new contrast pairing.

**1056 tests pass** (unchanged — this phase adds no logic), `astro check`
0/0/0/0, production build PASS.

### Why this was needed

`/about` described a product that does not exist. Verified by grep against
`src/`, not assumed:

| Claim on the page | Reality |
|---|---|
| "Sarvam AI voice synthesis" + a "Sarvam AI Voice Integration" card citing the "Bulbul V3 model" | **Zero** occurrences of `sarvam`/`bulbul` anywhere in `src/`. Retired pre-rebuild architecture. |
| "combining official wire streams (PTI, ANI, PIB)" | No such ingestion. `PROVIDERS` = NewsData.io, Guardian, RSS (The Hindu, Indian Express, NDTV, Mint). `aninews.in` appears only in `factcheck/sources.ts` as a credibility-tier entry, never as a feed. |
| "10 Indian languages" | `LANGUAGES` ships **13**. |
| "Every summary … generated by NewzWale" | Summaries are the publisher's own, quoted verbatim (`news/[slug].astro:17`). Nothing is generated. |
| "empower millions of readers" | No traffic data exists to support a user count. |

README's own changelog records the homepage copy being cleaned of the Sarvam
and 10-language claims. **This page was missed**, which is exactly the
cross-cutting risk the plan names: "Losing the honesty the codebase already
has."

`/terms` carried the same wire-service claim plus three more unsupported
premises: "automated summarization" and "multilingual translation" (the
language selector changes which language news is *fetched* in —
`languages.ts:1` says explicitly "This is NOT interface translation"), and an
entire "User Accounts & Content" section about "account credentials" when
**there are no accounts and no sign-in** (auth was deleted in Phase 0).

### Delivered

- **`/about` rewritten.** Every claim now traces to a file. The language count
  is read from `LANGUAGES.length` at build time rather than typed as a
  literal, so adding a language cannot make this page lie again.
- **Methodology link added** (P10 requires it) — `/methodology`, in its own
  "Read the method" section.
- **Device-local / no-sync disclosure added** (P8 §Risks requires it be in
  `/about` and "not buried"): no accounts, `localStorage` on one device,
  nothing sent to a server, nothing syncs between devices, clearing browser
  data clears the list. Mirrors the wording already on `/saved` and
  `/fact-check/history`.
- **A "What NewzWale does not do" section** stating the absences plainly: no
  voice synthesis, no interface translation, no accounts/sync, no hosted
  article bodies, no PTI/ANI/PIB feed.
- **`/terms`**: corrected the four false premises above. Legal provisions
  (liability, governing law, IP framework, third-party links) were **not**
  rewritten — only the factual claims about what the service does. Section 5
  retitled "User Accounts & Content" → "Your Submissions".

### Browser QA (wrangler dev, port 8787)

- `/about` and `/terms` at **375×812** and **1280×900**: no horizontal
  overflow at either width on either page (`scrollWidth === clientWidth`).
- Grid collapses 1-col → 2-col (412px each) at 1280; 4 cards, 5 list items.
- Methodology link present, visible, `href="/methodology"`, underlined,
  `--color-primary-strong`; destination returns 200 and renders.
- Dark and light both render with existing tokens (dark: bg `rgb(35,35,32)` /
  h1 `rgb(245,244,241)`; light: card `#fff` / h1 `rgb(17,17,17)` / link
  `rgb(204,68,48)`). No new pairing, so `tests/contrast.test.ts` needed no
  addition.
- Rendered-text assertions: `sarvam`, `bulbul`, `10 indian languages`,
  `official wire streams`, `pti, ani, pib`, `automated summarization`,
  `multilingual translation`, `account credentials` — **all absent**;
  `13 languages` present.

**Not verified:** no click-through of the methodology link and no screenshots
— the browser pane was not displaying, so coordinate input and frame capture
were unavailable. Link presence, visibility, href and destination status were
verified programmatically instead. No screen-reader pass (no AT available).

### Defect found and fixed during QA

The first draft lost the space before four inline elements (`<strong>`,
`<a>`, `<em>`) — Astro collapsed the newline, rendering "True andFalse",
"themethodology page", "thenews". Caught by reading the rendered HTML rather
than trusting the source, fixed with explicit `{' '}`, re-verified in the
built output.

### Remaining P10 work — NOT done

P10 is **not** complete. Still outstanding: README, `docs/WEBSITE-DOCUMENTATION.md`
and `AGENTS.md` updates; the four analytics events
(`factcheck_submitted`, `factcheck_result`, `search_performed`,
`article_opened` — none exist); `npm audit` in CI (S-16); a real deploy step
(audit P-14); security headers for the 11 prerendered routes that bypass
middleware (S-11); GA consent gate (S-10); `robots.txt` `/admin` removal
(an unfinished **P1** item); D1 provisioning; performance budget (the plan
references a "P8 budget" that **does not exist** — Phase 8 defines none).

### Out of scope, found during this pass — NOT fixed, needs a decision

**`src/pages/privacy.astro` is worse than `/terms` was.** It states NewzWale
collects "account credentials (name and email when you sign up)", uses them
for "authenticating your account", delivers "saved bookmarks **across
devices**", retains "account data … as long as your account remains active",
and offers deletion "from your account settings". None of that exists: there
is no signup, no auth, no server-side storage, and no cross-device sync. The
cross-device claim directly contradicts `/saved`'s own on-page copy. A privacy
policy is a representation to users and regulators, so this is the highest-
severity copy defect remaining. It was **not** touched — `privacy.astro` was
outside the authorized P10.1 scope. **Addressed subsequently in P10.1b** (see
the section above).

## Status — Doc-Phase P9 (PWA) COMPLETE

Built on P8 (`1b4e0c1`). Frontend/static-asset only — **zero diff** over
`src/pages/api/`, `src/lib/factcheck/`, `src/lib/db/`, `src/lib/security/`,
`wrangler.jsonc`, `package.json`, `package-lock.json`, `astro.config.mjs`.
No new dependency, no new API route (the plan's §Phase 9 says "API: None").

**1056 tests pass** (1029 → 1056, +27 in `tests/pwa/`; 0 removed/weakened/
skipped), `astro check` 0/0/0/0, production build PASS.

### Delivered

- **Manifest** (`public/site.webmanifest`). Added `id`, `start_url`, `scope`,
  `description`, `lang`, `dir`, `orientation`, and three `shortcuts`
  (Fact Check / Trending / Saved — taken from the existing IA in
  `BottomNav.astro`, not invented). Both icons moved from `purpose: maskable`
  to `purpose: any`, which is the defect the plan names verbatim.
- **Service worker** (`public/sw.js`, new). Classic script served verbatim from
  `public/`; not bundled. `route()` is an explicit **allowlist** that returns
  `bypass` for anything it does not positively recognise.
  - `/api/*` — **never cached, in either direction.** Verified in-browser.
  - `/fact-check` and `/fact-check/*` — network-only, falling back to the
    offline page rather than to a stale verdict. `/fact-check/history` is the
    single exception: a prerendered shell that reads the visitor's own
    `localStorage`, so caching it exposes no server-rendered verdict.
  - `/_astro/*`, `/fonts/*` and the enumerated icon/manifest files —
    cache-first (content-addressed or immutable).
  - Document navigations — network-first; the cache is a failure fallback, not
    a source of truth. Page cache bounded at 40 entries, oldest-first.
  - Second gate `canCache()` rejects non-200, redirected, opaque/cross-origin,
    and `no-store`/`private` responses before anything is written.
- **Offline fallback** (`src/pages/offline.astro`, new). Prerendered and
  precached at install. Deliberately omits `MastheadInfoStrip`, which calls
  `/api/v1/weather` and would render an error strip on the one page guaranteed
  to be shown without a network. Uses only existing tokens — no new contrast
  pairings.
- **Registration + install prompt** (`Layout.astro`). Registration deferred to
  `load`; a failed registration is swallowed, because the site works without
  the worker. The install banner suppresses the browser mini-infobar, shows
  **once** per device (`nz_install_prompted`, set on accept, dismiss, and
  `appinstalled`), and sits above `BottomNav` rather than over it.
- **Tests** (`tests/pwa/`, 27). `sw.test.ts` evaluates the **real**
  `public/sw.js` via Vite `?raw` + `new Function` with a stubbed `self`, so the
  policy under test is the policy that ships — no re-typed copy. Follows the
  project's existing no-`@types/node` rule (`tests/types.d.ts`) rather than
  adding a dependency.

### Two plan ambiguities, resolved explicitly (not silently)

1. **Kill-switch trigger.** §Rollback says "Unregister the service worker and
   serve an empty `sw.js`", and §Phase 9 says "API: None" — which rules out a
   remote-checked flag. Implemented as the `KILL_SWITCH` constant at
   `public/sw.js:41`: flip to `true` and deploy, and the worker deletes every
   cache, unregisters, reloads open clients, and **registers no `fetch`
   handler at all**. The trigger is a deploy; there is nothing to poll.
2. **Shortcut destinations.** Not specified by the plan. Used the existing
   top-level routes only.

### Kill switch — TESTED BEFORE SHIPPING, as §Rollback demands

Not merely unit-tested. The flag was flipped to `true`, rebuilt, and run in a
real browser against three seeded caches (`nz-pages-v1`, `nz-static-v1`,
`nz-legacy-v0`): all three were deleted, the registration was removed, and
`navigator.serviceWorker.controller` went `null`. Flipping it back and
rebuilding restored normal registration and re-precached `/offline/`. Ships at
`false`.

### Browser-verified (wrangler dev, port 8787)

- SW registers at scope `/`, reaches `activated`; caches `nz-static-v1` +
  `nz-pages-v1` populate.
- After visiting `/fact-check/` and calling `/api/v1/weather` + `/api/ticker`,
  **nothing** under `/api` or `/fact-check` is in any cache.
- Server stopped → `/saved/` serves from cache; `/trending` (never visited)
  serves the offline page; `/fact-check/` serves the offline page, not a
  verdict.
- Install banner: hidden by default, `preventDefault()` on the event, shows
  once, stays hidden on a second firing, and a double-click on Install calls
  `prompt()` exactly once.
- At 375×812 the banner occupies y 616–744 against a `BottomNav` starting at
  755 — no overlap; both buttons 44px tall.

### Known limitation (not a defect — deliberately not invented)

There is still **no true maskable icon**. The existing artwork is a coral tile
with its own baked-in rounded corners, so under a square Android mask those
corners read as notches, and `public/` contains no safe-zone-padded variant.
Declaring `maskable` without that artwork is exactly the bug the plan flagged,
so the manifest now declares `any` only and Android applies its default
treatment. Adding a real maskable variant needs new 192/512 artwork with the
40% safe zone respected — a design task, not a code one. Pinned by
`tests/pwa/manifest.test.ts`.

### Note for whoever bumps the worker

`VERSION` (`public/sw.js:38`) scopes both cache names. Bumping it is also a
full cache flush — that is the intended lever, and `activate` deletes every
cache not in `CURRENT_CACHES`.

## Status — Doc-Phase P8 (History & saved) COMPLETE — localStorage interpretation

**Interpretation chosen:** device-local storage, per
`NEWZWALE_IMPLEMENTATION_PLAN.md:486-487` ("Database: None if device-local
(recommended). API: None if device-local"). **IndexedDB / `src/lib/store.ts`
(the same plan's `:481,488`) was deliberately NOT implemented** — that line
contradicts the "device-local recommended" line in the same section; the
device-local reading was chosen and approved. Do not re-open without a new
decision. P8's functional deliverables (saved page, device-local fact-check
history capped at 50 with oldest-first eviction, verdict filters + counts,
not-synced messaging, malformed-storage recovery, `window.NZ`) all shipped in
P6 (`7c88d95`); there is no separate P8 commit.

**Malformed-storage defect — FIXED.** The `window.NZ`
saved/topics readers caught invalid JSON but not valid JSON of the wrong shape,
so a poisoned `nz_saved = {"corrupted":true}` threw and silently disabled
saving site-wide. The read/write helpers were extracted verbatim from
`Layout.astro`'s inline block into `src/lib/saved.ts` (mirroring
`factcheck-history.ts`, so the guards are unit-testable) and both readers now
verify `Array.isArray` before returning. Keys, events, and the `window.NZ` API
are unchanged. Browser-verified: from a poisoned state, saving recovers, the
store becomes a valid array, and `/saved` no longer throws. Regression covered
by `tests/saved.test.ts` (15 tests).

## Status — Doc-Phase P6 (UI redesign) COMPLETE

Built on P5 (`8f36570`). Frontend/UI only — no D1 schema, migration, API
envelope, cursor-semantics, evidence-engine, verdict-semantics, or legacy-API
change (all verified by an empty `git diff` over those paths).

**1029 tests pass** (976 → 1014 in P6, +15 in the P8 malformed-storage fix; 0
removed/weakened/skipped), `astro check` 0/0/0, production build PASS.

### Delivered

- **Foundation.** Self-hosted Inter + JetBrains Mono (`public/fonts/*`,
  `src/styles/fonts.css`); the render-blocking Google Fonts `@import` and both
  third-party font origins are gone from the CSP. Dynamic `<html lang>`/`dir`
  from the content language (`languageDir()` — Urdu is RTL, the other 12 LTR),
  closing A-01. Two new verdict tokens only (`--color-verdict-misleading`
  orange, `--color-verdict-context` blue), chosen by measurement; 32 new
  contrast assertions (16 pairings/colour × the four surfaces × two themes,
  plus reuse/CVD/stance checks).
- **Shared primitives.** `Dialog` (one focus-trap implementation for all three
  overlays — closes A-03/A-04/A-05), `Skeleton`, `EmptyState`, `ErrorState`.
- **Shell.** `BottomNav` (straight cutover, Fact Check centred, safe-area,
  44×44, `aria-current`), reworked `Navbar` (five destinations = BottomNav),
  masthead weather moved to `/api/v1/weather` — the three browser-side
  third-party calls and the gesture-less geolocation prompt are deleted,
  closing S-09/A-07; CSP `connect-src` and `permissions-policy: geolocation=()`
  tightened, with the old assertions inverted to lock it.
- **News.** `NewsFeed` `buildCard()`/dup helpers deleted — server and
  "Load more" paths now clone one `ArticleCard` template. Card: category out of
  the image (A-06), 44×44 `aria-pressed` save, 16/9 aspect-ratio CLS
  reservation. `CategoryRail` empty state. New `CoverageList`, `TrendingList`,
  `FactCheckChip`, `ReadingTime`, `StoryHeader`, `ArticleGrid`.
  `MostReadSidebar` → honest "Latest" + link to ranked `/trending`. `HeroMesh`
  fake DOM-filter replaced with a real `/fact-check` claim input + paste.
- **Fact check.** Twelve documented components; single-input flow
  (detect→confirm→staged progress→result); six verdicts as icon+label+form
  (PARTLY_TRUE solid vs MISLEADING outline — CVD-safe, not hue-alone);
  four-segment evidence-strength meter (never a %); contradicting evidence
  never collapsed; `aria-live="polite"` stage announcements. The old
  incomplete `role="tablist"` is gone (A-02 resolved by removal — the flow is
  sequential steps, not tabs). Evidence rendering stays
  `createElement`/`textContent`/`safeHref`; no `innerHTML`.
- **History/Saved.** `src/lib/history/factcheck-history.ts` — localStorage
  only, capped at 50 (oldest evicted), written only on a persisted success;
  `/fact-check/history` with verdict filter chips + counts, "stored on this
  device / not synced" copy, honest empty/malformed-storage states. `/saved`
  kept as a full page (BottomNav "You" links to it); `window.NZ` unchanged.

### QA results (2026-08-13)

- **Responsive 320/640/1024/1280** — homepage verified at all four (no
  horizontal overflow; 2-col@640, 3-col+sidebar@1024, BottomNav cutover at
  1024). `/news`, `/search`, `/saved`, `/methodology`, `/fact-check` verified
  at 320. No document horizontal scroll at 320px on any page tested.
- **Keyboard/ARIA** — skip link present (target exists; the harness pane could
  not register `:focus` programmatically, markup is the unchanged standard
  Layout pattern); all three `Dialog` variants verified: focus-in, trap wrap,
  Escape, focus restoration, body scroll lock, `aria-modal`/`role`/labelling;
  BottomNav all five links tab-reachable with `aria-current`; no `role="tab"`
  anywhere (A-02 resolved by removal); touch targets ≥44×44.
- **Screen-reader** — a true AT (NVDA/VoiceOver) was **not available in this
  environment**; ARIA semantics were inspected and keyboard/focus were
  browser-tested. Not claimed as a screen-reader pass.
- **Reduced-motion** — CSS coverage verified structurally: the global block
  targets `.animate-marquee` plus a universal `*,::before,::after` rule with
  `!important` collapsing every animation/transition (skeleton pulse, dialog
  transitions included). Dialogs and progress are state-driven, not
  animation-gated, so they function with instant transitions; JS peek-nudges
  are `matchMedia`-guarded. Live media emulation was not available in the pane.
- **RTL** — en `ltr`, hi `ltr`, ur `rtl` all verified; Urdu nav reverses at
  mobile (Home→right) and desktop (logo→right), no overflow, no clipped
  headlines.
- **Contrast** — 28 assertions pass; blue/orange pairings and the
  PARTLY_TRUE-vs-MISLEADING form distinction verified live in the browser.
- **Security/regression** — full suite 1014, security/adversarial 208,
  migration 55, golden 15, `astro check` clean, build clean. No `innerHTML` in
  tracked source, no browser weather/geolocation call, no hardcoded secret, no
  new dependency, legacy/`/api/v1`/D1/evidence-engine paths untouched.

### Known limitations

- D1-backed *populated* states (`/news`, `/news/[slug]`, `/trending`,
  `/search` results, `/fact-check/[id]`) cannot render locally without a D1
  binding, so their live population and the "Check this as a claim →"
  successful-empty-search state were code-verified rather than browser-verified
  in this session. The controlled 404/503/error states on those routes *were*
  browser-verified. The homepage (legacy `/api/news`) and the full fact-check
  flow (legacy `/api/factcheck`) render real data locally and were exercised
  end to end.
- `/methodology` retains P5's 14px body text (not in the P6 changed-file set;
  has no form inputs, so the 16px iOS-zoom rationale does not apply). Left
  untouched to avoid out-of-scope edits.
- Screen-reader pass not performed (no AT in environment) — see above.

---

## Status — Doc-Phase P5 (Routes and IA) COMPLETE (uncommitted)

Committed baseline: `c6a724e` (5A+5B+5C+P7). This section is everything since.
**976 tests pass** (961 → 976), astro check 0/0/0 (159 files), build PASS.

### Route map delivered

| Route | Kind | Notes |
|---|---|---|
| `/news` | SSR page | D1-backed, `/api/v1/news`; category filter chips |
| `/news/[slug]` | SSR page | AD-09 shape (below) |
| `/trending` | SSR page | `/api/v1/trending`, ranking formula unchanged |
| `/search` | SSR page | `?q&type=news\|factcheck\|all` |
| `/fact-check` | SSR page | renamed from `/verify`; FAQ preserved in place |
| `/fact-check/[id]` | SSR page | OG title/description vary by verdict |
| `/fact-check/history` | Static shell | honest empty state — see limitation below |
| `/methodology` | Static | extracted from `verify.astro:47-71`, verbatim |
| `/saved` | Static shell | reuses existing `window.NZ` localStorage API |
| `/verify` | 301 | `Astro.redirect('/fact-check', 301)` |
| `GET /api/v1/news/[slug]` | API | story + cluster coverage + linked fact-checks |
| `POST /api/v1/factcheck` | API | wraps the extracted pipeline handler |
| `GET /api/v1/factcheck/[id]` | API | `FactCheckRepository.findById` |
| `GET /api/v1/search` | API | `type=news\|factcheck\|all` added |
| `GET /api/v1/ticker` | API | **corrected**, see below |

### AD-09 — treated as resolved

`NEWZWALE_ARCHITECTURE.md` marks AD-09 "Status: Requires your approval" and
never revisits it. But `NEWZWALE_UI_UX_SPEC.md` §4.3 opens with "Per
architecture AD-09" and lays out the exact layout AD-09 proposed — headline,
publisher, timestamp, attributed extract, prominent read-full-story link,
coverage cluster, fact-check panel, related stories. A later design document
adopting a decision's exact proposed shape is the resolution; `/news/[slug]`
was implemented to that layout precisely. No article body is fetched,
generated, or hosted — the publisher's own `summary` is quoted verbatim.

**Flag: this reading is mine, not a written approval from you.** If you
intended AD-09 to remain open, `/news/[slug]` and its API route are the two
files to revert.

### `/api/v1/ticker` — corrected, not preserved

The audit found this route serving D1 headlines. No planning document names
a headline endpoint at this path; the arch doc's API table and security
finding S-08 both define `/api/v1/ticker` as the **market ticker**
(Sensex/Nifty), KV-cached 60s, rate-limited. Serving headlines there was a
naming mistake from 5C, not a contract worth preserving.

Rebuilt to match: KV-cached 60s, rate-limited, and — this took a self-caught
fix — **does not use the shared `cached()` helper**, because that helper
falls back to a stale KV entry on fetch failure. S-08 explicitly says market
data must hide rather than show a stale number on failure; `cached()`'s
fallback would have violated that. The route now does a plain get/put with no
stale path: a fetch failure is always a 503, never an old price.

`fetchMarketTicker()` (Yahoo quote logic) was extracted to `src/lib/market.ts`
so v1 can reuse it — `src/pages/api/ticker.ts` (legacy) is untouched, byte
for byte, since its own S-08 remediation (cache + rate-limit *that* route) is
out of P5 scope and importing from a shared module without applying the fix
would disturb a file with no documented reason to change.

`listRecent()` on `ArticleRepository`, written for the original (wrong)
ticker meaning, is no longer called by any route. Left in place: it is a
reasonable general-purpose repository primitive and is tested; deleting it
would mean discarding passing test coverage to remove ~25 lines of unused-for-now
code.

### Fact-check pipeline: extracted, not duplicated

`src/lib/factcheck/route.ts` now holds `runFactCheckRequest()` — the exact
logic previously inline in `/api/factcheck.ts` (validate → rate-limit → cache
→ pipeline → persist), moved verbatim. Both `/api/factcheck` (bare JSON,
unchanged shape) and `/api/v1/factcheck` (envelope) call this one function.
Confirmed identical by diff: the legacy route is a line-for-line
re-expression of the old handler, not a behavioural change.

Append-only is untouched — persistence still goes through
`FactCheckRepository.create()`, which has no update/delete path.

### `/fact-check` — content preserved, not deleted

`verify.astro` held three things: the checker, methodology, and an FAQ. D8
resolves the checker → `/fact-check`. The arch doc resolves methodology →
`/methodology` (verbatim, moved). **The FAQ's destination was never
documented anywhere.** Per instruction, undocumented is not license to
delete: the FAQ stays on `/fact-check`, alongside the checker, where it
already was.

One correction made in the methodology move: the old copy said "one of four
verdicts: Verified, Misleading, False, or Not enough evidence to judge" —
stale text from before the Phase 3 six-verdict migration (the six verdicts
were already live in `FactCheckWidget.astro`'s own `VERDICTS` map). The
architecture doc requires methodology to "state which verdicts are in active
use," so the list was corrected to the actual six. This is a correction to
match already-shipped behaviour, not new methodology.

Internal links updated to `/fact-check` (Navbar × 3, Footer × 3,
FactCheckPromo, the floating CTA in `Layout.astro`, `SeoContentSection`) —
minimal href edits, no redesign.

### Sitemap

`public/sitemap.xml` (hand-maintained, stale `lastmod: 2026-08-07` on every
entry, listed `/verify`) replaced by `src/pages/sitemap.xml.ts`, a plain XML
template — no dependency added; `@astrojs/sitemap` would solve a problem 15
static/category entries don't have. `<lastmod>` is omitted entirely rather
than filled with another value nobody will keep current. `/verify` removed;
`/fact-check` and the new P5 pages added. Per-article/per-fact-check entries
are **not** generated — undocumented, and inventing an update frequency and
cap would be exactly the kind of unspecified requirement this pass must not
invent.

### Known limitation: `/fact-check/history` has no data to show

No client-side history storage exists anywhere in the codebase —
`FactCheckWidget.astro` does not write completed checks to `localStorage`
under any key. Wiring it to do so is a change to that component's check
flow, which the instructions explicitly placed out of P5's page-shell scope
("do not turn P5 into a component redesign") and forbade inventing a new
storage schema for. The page therefore shows an honest, permanent-looking
empty state rather than a fabricated list. `/saved` had the opposite
situation — `window.NZ.getSaved()/toggleSaved()` already existed — and reuses
it directly.

### Testing

`route.ts` (shared fact-check handler) and the four new/changed API routes
that import `env` from `'cloudflare:workers'` **cannot be unit-tested by
direct import** — that module has no resolution under plain Node/vitest, the
same constraint that already applied to the pre-P5 `/api/factcheck.ts` (no
existing test ever imported it). Consistent with that boundary, this pass
tests the composition each route performs — `ArticleRepository.findBySlug` +
`listByCluster` + the new `FactCheckRepository.listByArticle`, executed
together exactly as `/api/v1/news/[slug]` calls them — against real SQLite
running both real migrations, rather than the route file itself.
`fetchMarketTicker()` has no such import and is tested directly with a
stubbed `fetch`, matching the existing convention in
`tests/news/provider-integration.test.ts`.

---

## Status — Phase 5A / 5B / 5C + P7 search fallback COMPLETE (uncommitted)

> **Naming.** The plan in `docs/NEWZWALE_IMPLEMENTATION_PLAN.md` uses NUMBERED
> phases P0–P10. The 5A/5B/5C lettering below came from the working prompts,
> not from the plan, and there is no "Phase 5D" in any project document. The
> search work recorded here is **P7 — Search and trending** (its search half).
> Doc-phase P5 (Routes and IA) is still outstanding: every page shell
> (`news/index`, `news/[slug]`, `trending`, `search`, `fact-check/*`,
> `/methodology`), the `/verify` → `/fact-check` 301, the generated sitemap,
> and `/api/v1/{news/[slug],factcheck,factcheck/[id]}`.

### P7 (search half) — Indic search fallback

Follows the plan's own prescription verbatim
([NEWZWALE_IMPLEMENTATION_PLAN.md:466](docs/NEWZWALE_IMPLEMENTATION_PLAN.md)):
"fall back to `LIKE`-based matching for scripts FTS handles poorly rather than
shipping search that silently fails for 12 of 13 languages." ICU was never an
option — D1 runs stock SQLite with no loadable extensions.

**Measured first.** Full-word queries turned out to work under FTS5 in *every*
script. The real failure is STEM queries, which are the normal case in
agglutinative Indic languages where the postposition attaches to the noun:

| query | printed form | FTS5 | LIKE |
|---|---|---|---|
| flood | floods | MISS | HIT |
| बारिश | बारिश से | HIT | HIT |
| বৃষ্টি | বৃষ্টিতে | HIT | HIT |
| கனமழை | கனமழையால் | HIT | HIT |
| వర్షాల | వర్షాలతో | **MISS** | HIT |
| కేరళ | కేరళలో | **MISS** | HIT |
| بارش | بارش سے | HIT | HIT |

So the defect was never "FTS fails on Indic" — it is that FTS is
**inconsistent between scripts**. Devanagari/Bengali/Tamil get *accidental*
substring behaviour (the query shatters into the same consonant fragments as
the text and phrase-matches a prefix), Telugu does not, English gets strict
token matching. Same user action, different meaning per language.

**Implemented:** `needsLikeFallback()` routes any query containing a non-Latin
letter to LIKE substring matching; Latin queries stay on the indexed FTS path.
A Latin allowlist rather than a "bad scripts" blocklist, because forgetting to
extend a blocklist fails silently for that language. Digits and punctuation
never move a query off the fast path.

**No migration.** Nothing about the schema changed.

**Security — new surface, closed.** `%` and `_` are LIKE wildcards; unescaped,
a query of `%` returns every row (measured: 7 of 7 rows, versus 0 escaped) —
a full-table read from a public endpoint. Terms are now split on any
non-alphanumeric character, so wildcards cannot reach a pattern at all, and
`likePattern()` still escapes them as defence in depth. Term count capped at 8.

**Bug found by test:** the LIKE path first split on whitespace only, so
`मानसून, बाढ़` searched for the literal `%मानसून,%` and found nothing while
the English equivalent matched — re-introducing the very cross-script
inconsistency the change removes. Both paths now strip punctuation identically.

**Known cost:** `%term%` cannot use an index, so the LIKE path scans, bounded
by LIMIT. Fine at current corpus size; the upgrade is a normalised search
column plus a trigram index, not a smaller LIMIT. Marked `ponytail:` in code.

**Still not done:** English stemming. `flood` does not match `floods` — FTS5's
porter tokenizer would fix it, but that is a separate decision. Asserted as a
test so it cannot be mistaken for an accident.

Search stays ordered by **recency, not relevance**: BM25 `rank` exists only on
the FTS path, so ranking by it would order Latin results by relevance and
non-Latin results by nothing.

---

## Status — Phase 5A / 5B / 5C COMPLETE (uncommitted)

- **Branch:** `claude/newzwale-phase-5-1a3d8c`
  (worktree `.claude/worktrees/wonderful-panini-6eac28`)
- **Phase 4 merge:** `fb1e702` (recovered Phase 4 commit `dfcdd01`)
- **Verification:** `npm test` **931 pass** (741 after the Phase 4 merge, 769
  after 5A, 853 after 5B), `npx astro check` **0 errors / 0 warnings / 0
  hints** (141 files), `npm run build` PASS.
- **Not deployed.** D1 is still unprovisioned — see "manual step" below.

### 5A — D1 foundation

Phase 4 had already built the repositories, so 5A added only the gaps:
`getDb()` (one typed narrowing of `NEWZ_DB` instead of a raw cast per call
site), keyset cursor helpers, `findById`, and FTS-backed `search` on both
articles and claims. `npm run db:migrate:local` / `:remote` added.

**Measured, not assumed:** FTS5 `unicode61` treats Devanagari and Bengali
matras as token SEPARATORS, so `मानसून` shatters into `म | नस | न`.
`remove_diacritics` makes **no difference** — the token list is identical at
`0` and `2`, correcting the claim in the 0001 comment. Whole-word queries
still resolve, but matching turns substring-like and BM25 `rank` is computed
over fragments, so relevance is untrustworthy in those scripts. English is
unaffected. Pinned by tests; a real fix needs an ICU tokenizer.

### 5B — news persistence

New `src/lib/news/{canonical,cluster,ingest}.ts`. Providers fan out
concurrently (`Promise.allSettled`) rather than first-success — ingestion wants
breadth, the read path wants one answer, so `fetchFromChain` is untouched.
Article identity is `sha256(canonical_url)`; re-ingestion is a no-op.

Clustering is deterministic (no model): category + language + 48 h window,
stopwords incl. India/government/PM/Delhi/today, ≥3 shared significant tokens,
Jaccard **≥0.75**. The threshold sits above the worst measured FALSE pair
(0.714, "Karnataka *hijab*" vs "*mining*" verdict), which is higher than three
of four true pairs — the distributions overlap and no threshold separates
them. It therefore under-merges on purpose: a missing "also reported by" beats
claiming corroboration that does not exist. Both directions are asserted.

RSS image extraction added (`media:content`, `media:thumbnail`, type-checked
`enclosure`, nested `<image><url>`) — the parser previously hardcoded
`imageUrl: null` and discarded every publisher image.

Two bugs the tests caught: ingestion using `upsert` would have overwritten
curated `tier`/`owner_group` on every run (silently downgrading a tier1 source
and weakening fact-check corroboration) — now `ensureExists`; and splitting on
`[^\p{L}\p{N}]` shattered Devanagari in slugs and cluster tokens, so every
Hindi headline would have collided on one slug. `\p{M}` is load-bearing.

### Migration 0002 — `articles.published_at` is now NULLABLE

`0001` declared it NOT NULL, which forced ingestion to either fabricate a date
or drop the article. Neither is acceptable, so the column was relaxed via a
table rebuild (SQLite cannot drop NOT NULL in place).

Two hazards, both handled and both asserted:
- `fact_checks.article_id` is `ON DELETE SET NULL`. A naive `DROP TABLE
  articles` blanks the article link on published, append-only fact-checks —
  and the UPDATE trigger does **not** guard it, because `article_id` is
  deliberately outside its column list. Foreign keys are disabled for the
  rebuild and `PRAGMA foreign_key_check` runs before they go back on.
  `defer_foreign_keys` does NOT work here: it only applies inside an explicit
  transaction and silently does nothing under autocommit. The first draft used
  it and the test caught the nulled row.
- `articles_fts` is external-content, keyed on `articles.rowid`, which a
  rebuild can renumber. The index is rebuilt rather than trusted.

Ingestion now persists undated articles with `published_at = NULL` and reports
`undatedArticles` in its summary. `ingested_at` remains NOT NULL and never
stands in for it.

Pagination consequence: `published_at < ?` is NULL for an undated row, so those
articles would have become unreachable past page 1. All paginated queries sort
on `COALESCE(published_at, '')` — an ordering key only, never returned — which
puts undated articles last and restores a total order.

### 5C — API v1

| Route | Backing | Notes |
|---|---|---|
| `GET /api/v1/news` | D1 | `?category ?language ?limit ?cursor`; keyset, not OFFSET |
| `GET /api/v1/search` | D1 FTS | `?q` required + bounded; `?category ?language ?limit ?cursor` |
| `GET /api/v1/trending` | D1 clusters | `?limit`; published formula below |
| `GET /api/v1/ticker` | KV + Yahoo | market ticker (Sensex/Nifty); corrected in P5, see below |
| `GET /api/v1/weather` | `request.cf` + Open-Meteo | closes S-09 server half; keyless |

Envelope is the existing `ok()` / `fail()` from `src/lib/api/response.ts`; no
second format was introduced. `meta.cursor` is present **only** when a further
page exists, so `'cursor' in meta` is a reliable "has more".

**Cursor semantics.** Opaque base64 of `sortValue \0 id`. NUL because SQLite's
`DEFAULT (datetime('now'))` writes `YYYY-MM-DD HH:MM:SS` — with a space — so a
space separator would split the sort value in half. A malformed cursor is a
`BAD_REQUEST` (400), never a silent restart from page 1, which would leave a
paging client looping over the first page forever. Cursors are unsigned: both
fields are only ever bound as SQL parameters, so tampering shifts position in a
public feed and nothing else.

**Search orders by RECENCY, not relevance** — deliberate, given the Indic
tokenizer finding above. Ranking a multilingual product by a score sound in
English and arbitrary in Hindi would be worse than not ranking. Recency is also
the only total order available, which keyset pagination requires.

**Trending formula, published because readers see it:**

```
score = log2(1 + independentSources) × 0.5 ^ (ageHours / 12)
```

with a minimum of 2 independent sources. Breadth is sub-linear (twenty outlets
to twenty-two is not evidence); recency half-life is 12 h. `articleCount` is
returned but **not** ranked on — it counts rows, and four outlets running one
wire story are four rows from one newsroom. No model, no click data: there is
none, and inventing a popularity proxy would be dishonest. Scored at read time,
not from the stored `trending_score`, because a decaying score is stale the
moment it is written.

**Backward compatibility.** `/api/news`, `/api/ticker`, `/api/factcheck`,
`/verify` and every component are **byte-identical** — verified by `git
status`. `/api/news` keeps its bare `{articles, nextPage}` shape and still
reads KV + the provider chain; it was deliberately NOT re-pointed at D1,
because that changes what the homepage renders and belongs with the UI
migration. `/api/v1/ticker` originally served D1 headlines under this path —
**corrected in P5**, see below: no document names a headline endpoint here,
and the arch doc's API table + S-08 both define `/api/v1/ticker` as the
market ticker.

**Fallback when D1 is absent** (which is the case today): every D1-backed v1
route returns `UPSTREAM_UNAVAILABLE` (503) with a message naming no binding,
path or account detail. Never an empty success envelope, which would say
"there is no news" instead of "this is not available yet".

### Manual step still required

D1 is unprovisioned; no ID has been invented. To activate:

```
npx wrangler d1 create newzwale
```

Paste the returned `database_id` into the commented `d1_databases` block in
`wrangler.jsonc`, then `npm run db:migrate:remote` (0001, then 0002).

### Open risks

- Indic FTS fragmentation (above) — needs an ICU tokenizer, i.e. a schema
  migration, and its own evidence.
- Clustering under-merges by design; raising recall needs entity awareness,
  not a lower threshold.
- Cluster stopwords are English-only, so Indic headlines have a weaker
  over-merge guard.
- Wire syndication is not collapsed in `source_count` (needs body text we
  deliberately do not store).
- S-09 is only half closed: `MastheadInfoStrip.astro` still calls
  `ipapi.co`, `bigdatacloud.net` and open-meteo from the browser. Deleting
  those is a UI change for a later phase.

---

## Status — NewzWale 2.0, Phase 0 (Foundations) COMPLETE

- **Branch:** `claude/install-ui-ux-pro-max-skill-fb49bc`
  (worktree at `.claude/worktrees/install-ui-ux-pro-max-skill-fb49bc`)
- **Deployed:** NOT deployed. All work is local and uncommitted to `main`.
- **Verification (2026-08-08):** `npm test` **240/240 pass** (was 134),
  `npx astro check` **0 errors / 0 warnings**, `npm run build` completes.
  News flow, fact-check flow and `/verify` verified working in a live dev
  server, not merely compiled.

### Current architecture (as built)

Astro 7 SSR on Cloudflare Workers · Tailwind v4 · KV (`NEWZ_CACHE`) ·
Workers AI · Cloudflare Images (active via the adapter, currently unused) ·
4 runtime dependencies · no database · no auth · localStorage user state.

### Approved target architecture

Same stack, extended incrementally — **no rewrite, no React, no Supabase,
no second backend**:

- **Cloudflare D1** as system of record (KV demoted to a TTL cache)
- **Durable Object** for atomic rate limiting (KV has no atomic increment)
- **Cron** scheduled ingestion, off the read path
- **`/api/v1/*`** versioned contract, shared by web / PWA / future native
- **`NewsProvider` abstraction**, RSS as a first-class ingestion layer
- Six canonical verdicts: `true`, `false`, `partly_true`, `misleading`,
  `unverified`, `needs_context`

### Audit — complete and approved

Eight planning documents in `docs/`. Start with
`docs/NEWZWALE_AUDIT.md`; `docs/NEWZWALE_IMPLEMENTATION_PLAN.md` is the
phase plan. `docs/NEWZWALE_DESIGN_DIRECTION.md` is an **approval gate** that
must be signed off before any UI work.

### Phase 0 — what landed

| Area | Change |
| --- | --- |
| Docs | `DECISIONS.md` archived to `docs/archive/` with a superseded header (history preserved via `git mv`) |
| Config | `wrangler.jsonc` documents D1 / Durable Object / Cron blocks **commented out** — they need real resource ids, and inventing placeholders would fail at deploy |
| API | `src/lib/api/{errors,response,request}.ts` — v1 envelope, error codes, method validation, bounded body reads |
| Service layer | `src/lib/news/service.ts` — one read path for pages *and* routes; `/api/news` migrated onto it |
| Providers | `src/lib/news/providers.ts` — `NewsProvider` interface wrapping the existing newsdata/guardian/rss modules verbatim |
| Schema | `src/lib/db/migrations/0001_init.sql` — 5 tables + 2 FTS indexes, written and **executed in tests**, not yet applied |
| Cache | `fc:v1` truncated key → `fc:v2:sha256(claim \| pipeline \| evidence \| model)` |
| Bug fix | `'no evidence'` no longer maps to `FALSE` |

### Next phase — Phase 1 (Security), awaiting approval

Bounded fetch (timeout / size / content-type), manual redirects with per-hop
private-host revalidation, atomic rate limiting on a Durable Object,
CSP + security headers, prompt-injection fencing, evidence URL validation.

Phase 2 (D1 data layer) may run in parallel.
**Do not start Phase 3+ before the foundation is reviewed.**

### Known risks carried forward

1. **Provider coverage is unmeasured.** 11 categories × 13 languages = 143
   combinations is far beyond any free tier. Measure before locking the cron
   schedule.
2. **FTS5 tokenisation for Indic scripts is unproven.** `unicode61
   remove_diacritics 2` is set in the migration but must be tested against
   real Devanagari / Tamil / Urdu content before search ships.
3. **Story clustering can over-merge.** Under-merging is a missing feature;
   over-merging is a factual error. Start conservative.
4. **`node:sqlite` needs Node ≥ 23.4.** CI pins Node 22, so the 24 schema
   tests **skip in CI** while passing locally on Node 24. Bump CI to Node 24
   or that coverage is imaginary.
5. **Prompt edits flip verdicts.** Already happened once (see below). Build
   the golden set before touching the prompt in Phase 3.

### Verified live against real APIs (2026-08-06)

Both keys now set locally (`.dev.vars`) and in prod (`wrangler secret list` shows
`NEWSDATA_API_KEY`, `GOOGLE_FACTCHECK_API_KEY`, `TAVILY_API_KEY`). Everything the
earlier RSS-fallback runs could not confirm is now confirmed:

| Check | Result |
| --- | --- |
| Category differentiation | Real. `sports` returns Neeraj Chopra/CWG, `business` returns e-commerce policy, `health` returns medical stories — genuinely distinct feeds. |
| In-language headlines | Real. `/?language=hi` renders Devanagari headlines (3/3 sampled), `<select>` stays on `hi` after reload. |
| Lead story images | Real. 22 images render on the homepage; the imageless fallback path is no longer the only one exercised. |
| Load more | Real. Homepage grid 6 → 16 cards on one click, all unique, `data-next-page` token advanced, console clean. Category pages also confirmed (10 → 20 on `/category/sports`). |
| Homepage dedup | 26 cards, 26 unique — no repeats across lead / rails / grid. |
| Fact-check pipeline | Real verdicts with real citations, see below. |

### NewsData.io free-tier constraints (verified 2026-08-06)

| Question | Answer |
| --- | --- |
| Articles per request | 10 |
| `nextPage` token present | yes |
| Page 2 works with that token | yes — 0 overlap between page 1 and page 2 results, confirmed genuinely advancing |
| Categories returning results | all 7: politics, world, business, sports, entertainment, technology, health (plus `top`, the default) |
| Categories returning nothing | none |
| Languages returning results | all 13: en, hi, bn, mr, te, ta, gu, kn, ml, pa, or, as, ur — native-script headlines confirmed for each |
| Languages returning nothing | none |
| Daily request cap on this plan | not tested |

No categories or languages need to be dropped from the allowlists. The `india`
slug's provisional mapping to `politics` (see `src/lib/news/categories.ts`) is
confirmed reasonable — it returned real India-relevant political headlines.

**Decision: build Load more (Task 10) as planned** — the free tier's `nextPage`
token is real and advances correctly.

### Known local-dev gotcha: stale KV cache

`/api/news` caches per category+language+page in KV for 20 minutes. During the
keyless phase of development, RSS-fallback responses (115 articles,
`nextPage: null`) were cached under several keys. After adding the real API key,
those entries keep serving until their TTL expires — which looks exactly like
"the category param is broken" or "Load more is missing".

If a category returns 115 articles with a null `nextPage`, that is the stale
cache, not a bug. Wait out the TTL or use an uncached category/language combo to
check. Do not "fix" the code in response to it.

### Task 21 checklist results (run 2026-08-05 against production)

| # | Check | Result |
| --- | --- | --- |
| 1 | `ls dist/server` non-empty | pass |
| 2 | `POST /api/factcheck` returns 200 not 405 | pass |
| 3 | `wrangler secret list` correct names only | pass — `NEWSDATA_API_KEY`, `GOOGLE_FACTCHECK_API_KEY` |
| 4 | "COVID vaccines contain microchips" | pass — `false`, `basis: certified`, cites FactCheck.org, URL resolves 200 |
| 5 | The goats claim | pass — `insufficient_evidence` |
| 6 | Home page headlines live | pass — NewsData.io serving (hash IDs, images, `category` respected) |
| 7 | `/admin`, `/profile`, `/settings`, `/saved` | pass — all 404 |
| 8 | grep for `api/v1/tts` / `factcheck/*/chat` | pass — no output |

Local: `npm test` 99/99 pass, `npx astro check` 0 errors, CI green on PR #4.

### Fact-check stage 2: switched from Cloudflare Web Search to Tavily — CONFIRMED WORKING

**Verified live 2026-08-06** against `TAVILY_API_KEY` (set locally in `.dev.vars`
and in prod via `wrangler secret put`). Four claims tested through `/api/factcheck`:

| Claim | Verdict | Basis |
| --- | --- | --- |
| "COVID vaccines contain microchips" | `insufficient_evidence` (unreadable, one cold-start request) | none |
| "Chocolate cures the common cold within 24 hours" | `misleading`, correct nuanced reasoning | `ai_assessment` |
| "RBI kept the repo rate unchanged..." | `verified`, 3 real citations | `ai_assessment` |
| "Purple goats secretly run the postal service in Belgium" | `insufficient_evidence` | none |

Stage 2 now returns real evidence (3 URLs with titles/publishers per query) instead
of `[]` every time. Stage 3 reasons over it correctly — verdicts and citations are
real, not guessed. The nonsense-claim guard still holds: no invented verdict.

The old `WEBSEARCH` binding threw
`Error: account_disabled` on every call — an account entitlement problem, not a
code bug. Stage 2 returned `[]` every time, stage 3 never ran, and any claim
without a published fact-check came back `insufficient_evidence`.

`search()` in `src/lib/factcheck/search.ts` now posts to Tavily instead. The
`SearchHit` interface is unchanged, so stages 1 and 3 were untouched — the diff
to `src/pages/api/factcheck.ts` is 5 lines, all inside stage 2. The `websearch`
binding is removed from `wrangler.jsonc`.

Tavily is also better evidence: its `content` field is a query-relevant extract,
whereas Web Search only ever returned the page-level meta description.

**Do not restore the Cloudflare binding** without first confirming it works on
the account — that history is recorded in the comment at the top of `search.ts`
so it does not get re-litigated.

---

## What's built

- SSR on Cloudflare Workers (`output: 'server'`), KV cache (`NEWZ_CACHE`), Workers AI binding, Google Fact Check + NewsData secrets set in production.
- `/api/news` — NewsData.io with RSS fallback, KV-cached with stale-on-error.
- `/api/factcheck` — 3-stage pipeline: Google Fact Check Tools → web search → Workers AI reasoning over fetched article text. Never guesses; unmatched or unclear claims return `insufficient_evidence`, not a soft "verified".
- `/api/ticker` — live Sensex/Nifty; the masthead strip hides itself on failure instead of showing stale/invented numbers.
- `/verify` (fact-check widget) — 3 tabs (Text, URL, Image disabled/"coming soon"), all wired to `/api/factcheck`. Renders all 4 verdicts distinctly plus a certified/AI-assessment basis notice. No fake confidence score, no dead chat UI.
- Homepage ticker and SEO copy now describe only real features (live NewsData.io headlines, the 3-stage fact-check pipeline) — no more Sarvam AI, 10-language, or "grounded chat" claims.
- CI (`.github/workflows/deploy.yml`) actually gates on `npm test`, `npx astro check`, `npm run build` — no more `|| true`, no dead pytest job.
- Auth (`btoa(email)` sessions), the unguarded `/admin`, and the undeployed FastAPI backend are deleted.

## Known gotchas (read before touching these areas)

- Workers AI model id `@cf/meta/llama-3.1-8b-instruct` is deprecated on the live binding; the endpoint uses `-fp8` instead. Comment explaining this is in `src/pages/api/factcheck.ts`.
- The fact-check system prompt is deliberately verbose about grading the CLAIM, not the evidence passages — a terser version was verified (against the live model) to flip verdicts on debunked claims (`false` → `verified`). Re-test both directions before editing that prompt.
- `Response.json()` resolves to `unknown` project-wide (Cloudflare Workers types override `lib.dom`), not `any`. Cast it explicitly (`as { ... }`) or `astro check` fails — this is now a required CI gate.
- `DECISIONS.md` has been **archived** to `docs/archive/DECISIONS.md` with a superseded header (Phase 0). It describes the pre-rebuild architecture (Sarvam AI voice, `/admin`, grounded chat, FastAPI/Postgres) and reflects nothing in the current codebase. Kept as history only — never as a source of truth.
- `factCheckCacheKey()` is now **async** (SubtleCrypto) and returns `fc:v2:<sha256>`. It binds the pipeline identity from `src/lib/factcheck/version.ts`, so **bumping `PIPELINE_VERSION` or `EVIDENCE_VERSION` invalidates every affected cached verdict automatically**. That is the intended mechanism — do not work around it.
- `MODEL` moved from `src/pages/api/factcheck.ts` to `src/lib/factcheck/version.ts`, because the model id is part of the cache identity: a different model can reach a different verdict on identical evidence.
- The `fact_checks` table is **append-only, enforced by SQL triggers**, not by convention. Only `superseded_by` may be updated. A re-check inserts a new row. Tests assert this.
- Page components still self-fetch `/api/news`; only the API route was migrated onto `src/lib/news/service.ts` in Phase 0. Moving the pages changes what renders and needs UI verification, so it belongs in a later phase.
- `normalizeRating()` vs `coerceVerdict()` in `src/lib/factcheck/verdict.ts` are not interchangeable — the first parses human ratings like "Pants on Fire", the second validates an already-typed `Verdict` enum value. Mixing them up silently breaks unknown-claim handling.

## Deferred / not built

- ~~Custom domain (`newzwale.com` not yet owned).~~ **Stale — corrected in P10.**
  `https://www.newzwale.com` returns 200; the domain is bound to the Worker via
  the Cloudflare dashboard, not declared in `wrangler.jsonc`
  (`docs/WEBSITE-DOCUMENTATION.md` §6 records the same). Still worth doing:
  a canonical redirect, since apex and `www` both resolve 200 with no redirect
  between them.
- Image/screenshot OCR tab — UI exists, disabled with "coming soon"; no backend wiring.
- `DECISIONS.md` still needs its rewrite or deletion (see gotchas).
- Site UI translation. The language selector now fetches news content in the
  chosen language (real, not cosmetic), but the interface chrome — nav labels,
  buttons, "Read at source" — stays English by design. The control's `title`
  says so explicitly rather than over-promising.
- In-site article reading. Headlines still link out to the publisher; hosting
  article bodies is a licensing question, not an engineering one.
- ~~Keyboard arrow-key navigation between fact-check tabs (roving tabindex)~~ — **resolved in P6 by removing the tabs.** The fact-check UI is now a
  single-input sequential flow (input → confirm → progress → result), so there
  is no tablist to give an ARIA tabs pattern to. No `role="tab"` remains
  anywhere in the app.

---

## Handoff protocol

1. On starting: read this file, then run `git log --oneline -10` and `git status` to confirm nothing changed since this was last updated.
2. On finishing a task, or before stopping (context limit, model switch, end of session): update **Status** and **Next task** above with the real state — which commit you're at, what's done, what's half-done. If you stopped mid-task rather than at a clean commit, say so explicitly; don't let a stale "Next task" imply the last commit is further along than it is.
3. Keep entries factual and current — this file describes *now*, not history. Delete/replace stale gotchas rather than accumulating them.
