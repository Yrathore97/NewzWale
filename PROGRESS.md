# PROGRESS.md

This is the handoff log. Read it before starting work, regardless of which
model or agent you are. Update it when you finish a task, hit a stopping
point, or are about to run out of context — so the next agent (possibly a
different model) can continue without the user re-explaining anything.

Full task list and rationale: `docs/superpowers/plans/2026-08-05-newzwale-rebuild.md`

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

- Custom domain (`newzwale.com` not yet owned).
- Image/screenshot OCR tab — UI exists, disabled with "coming soon"; no backend wiring.
- `DECISIONS.md` still needs its rewrite or deletion (see gotchas).
- Site UI translation. The language selector now fetches news content in the
  chosen language (real, not cosmetic), but the interface chrome — nav labels,
  buttons, "Read at source" — stays English by design. The control's `title`
  says so explicitly rather than over-promising.
- In-site article reading. Headlines still link out to the publisher; hosting
  article bodies is a licensing question, not an engineering one.
- Keyboard arrow-key navigation between fact-check tabs (roving tabindex) is not implemented; tabs are reachable by Tab and activate on Enter/Space, which is workable but not the full ARIA tabs pattern.

---

## Handoff protocol

1. On starting: read this file, then run `git log --oneline -10` and `git status` to confirm nothing changed since this was last updated.
2. On finishing a task, or before stopping (context limit, model switch, end of session): update **Status** and **Next task** above with the real state — which commit you're at, what's done, what's half-done. If you stopped mid-task rather than at a clean commit, say so explicitly; don't let a stale "Next task" imply the last commit is further along than it is.
3. Keep entries factual and current — this file describes *now*, not history. Delete/replace stale gotchas rather than accumulating them.
