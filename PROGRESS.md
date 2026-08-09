# PROGRESS.md

This is the handoff log. Read it before starting work, regardless of which
model or agent you are. Update it when you finish a task, hit a stopping
point, or are about to run out of context — so the next agent (possibly a
different model) can continue without the user re-explaining anything.

Full task list and rationale: `docs/superpowers/plans/2026-08-05-newzwale-rebuild.md`

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
| `GET /api/v1/ticker` | D1 | `?limit`; newest headlines, uncursored |
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
migration. `/api/v1/ticker` is a *different dataset* from `/api/ticker`
(headlines vs Sensex/Nifty) — the old name was not reused for a new meaning.

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
