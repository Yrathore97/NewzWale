# NewzWale — Operating Manual

This file is the durable operating context for Claude Code sessions on this
repository. It documents rules established and verified across Phases 4–10.
It is not a history log (see `PROGRESS.md`) and not a roadmap (see
`docs/NEWZWALE_IMPLEMENTATION_PLAN.md`) — it is the rules that apply
regardless of which phase is active.

## 1. Project identity

NewzWale is:

- Astro v7, SSR (`output: 'server'`), TypeScript
- Hosted on Cloudflare Workers (`@astrojs/cloudflare`)
- A live Indian news feed (13 languages) + an AI-assisted fact-checker
- Six-verdict fact-check model: `true`, `false`, `partly_true`, `misleading`,
  `unverified`, `needs_context` — evidence-gated, never a guess
- A PWA: installable, offline shell, explicit-allowlist service worker
- **Device-local only** for saved articles and fact-check history —
  `localStorage`, one browser, one device
- Tailwind CSS v4, token-based design system

NewzWale is **not**:

- An app with user accounts or sign-in of any kind
- A product with cross-device sync for anything
- A voice/audio product (no Sarvam AI, no TTS, no synthesis)
- A translator of its own interface (the language selector changes which
  language *news* is fetched in; UI chrome stays English)
- A generator of article bodies or summaries (publisher extracts are quoted
  verbatim, never rewritten)
- Backed by a wire-service feed (no PTI/ANI/PIB ingestion — real providers
  are NewsData.io, the Guardian, and RSS)

Do not describe or imply any of the above "not" items as existing, in code,
comments, commit messages, or documentation, unless a future phase
explicitly builds it and this file is updated to say so.

## 2. Source of truth — priority order

When sources disagree, prefer in this order:

1. **Actual shipped source code** — what's in `src/`, `public/`, `tests/`
2. **Tests** — what's asserted and passing
3. `docs/NEWZWALE_IMPLEMENTATION_PLAN.md` — the roadmap
4. `PROGRESS.md` — the handoff log
5. This file (`CLAUDE.md`)
6. Conversational instructions from the current session

**Never treat an old plan statement as proof a feature exists.** The plan
describes intent; the repository describes reality. If `PROGRESS.md` says a
phase is "complete," verify it against source/tests before relying on that
claim — don't inherit it.

If documentation conflicts with implementation, or the plan is internally
ambiguous: **flag the conflict explicitly and ask**, rather than silently
choosing an interpretation or inventing behavior to resolve it.

## 3. Phase discipline

Current verified status (re-verify before trusting, per §2):

| Phase | Status |
|---|---|
| P4 — Evidence engine | COMPLETE |
| P5 — Routes & IA | COMPLETE |
| P6 — UI redesign | COMPLETE |
| P7 — Search & trending | COMPLETE |
| P8 — History & saved (device-local) | COMPLETE |
| P9 — PWA | COMPLETE |
| P10.1 — About/Terms honesty fix | COMPLETE |
| P10.1b — Privacy policy honesty/data-flow correction | COMPLETE |
| P10 — remaining *unblocked* work (S-11 headers, robots.txt, S-16 audit gate, doc sync) | COMPLETE |
| P10 (overall) | **IN PROGRESS** — everything still open is blocked on credentials or a decision; see §17 |

Before starting any phase or sub-task:

1. Inspect the plan's requirements for it.
2. Inspect current implementation against those requirements.
3. Identify dependencies (what must already exist).
4. Identify protected paths the task might touch (§4).
5. Identify infrastructure blockers (credentials, provisioning — §16).
6. Produce a scoped implementation plan.
7. Wait for authorization unless the task is already explicitly authorized
   in the current instruction.

**Never start the next phase automatically after finishing one.** Stop and
report; let the user authorize what's next.

## 4. Protected paths

Require **explicit authorization before modification** — even when a task
seems to need it. If a requirement appears to require touching one of these,
**stop and explain why before editing**, don't proceed and report after.

```
src/pages/api/**
src/lib/factcheck/**
src/lib/db/**
src/lib/db/migrations/**
src/lib/security/**
wrangler.jsonc
package.json
package-lock.json
astro.config.mjs
```

**Treat these as protected too**, even though they're not config/API files,
because they are completed, tested, and load-bearing:

```
public/sw.js
src/lib/saved.ts
src/lib/history/**
```

...and these behaviors, regardless of which file implements them:

- PWA infrastructure (caching policy, kill switch, manifest)
- Six-verdict semantics
- Evidence-engine behavior (corroboration, gating, stance detection)

A task's diff should be checkable with `git diff <parent>..HEAD --stat`
against this list — zero lines over every path not explicitly authorized for
that task.

## 5. Fact-check invariants

- **Never change six-verdict semantics** without explicit authorization.
  Read the actual set from `src/lib/factcheck/schema.ts` — don't guess or
  recall it from memory; it has changed once already (four verdicts, retired).
- **Never reintroduce retired four-verdict terminology** (`verified`,
  `insufficient_evidence`) as if it were current — even in documentation.
- Preserve: the evidence model, corroboration rules (assertive verdicts
  require independent corroboration), the deterministic gate (has the final
  say, consults no model), Google Fact Check Tools integration, evidence
  rendering (`createElement`/`textContent`/`safeHref`, never `innerHTML`),
  verdict filters/counts on `/fact-check/history`.
- A prompt edit has flipped verdicts before (documented in `PROGRESS.md`) —
  treat prompt changes in `src/lib/factcheck/prompt.ts` as high-risk; the
  golden test set exists specifically to catch this.

## 6. Storage architecture

Saved articles and fact-check history are **device-local only**:

| Data | Key | Module |
|---|---|---|
| Saved articles | `nz_saved` | `src/lib/saved.ts` |
| Topic preferences | `nz_topics` | `src/lib/saved.ts` |
| Fact-check history | `nz_factcheck_history` | `src/lib/history/factcheck-history.ts` |

- No user accounts, no sign-in, no cross-device sync, no server persistence
  for saved/history.
- No IndexedDB, and no new storage backend, without a new explicit
  architectural decision authorized by the user (P8 already considered and
  rejected IndexedDB in favor of `localStorage` — don't re-litigate silently).
- Malformed `localStorage` must fail safely: use `Array.isArray` guards when
  reading collection-shaped storage (see `saved.ts:39,81`,
  `factcheck-history.ts:70` for the established pattern). Poisoned storage
  must never break site-wide functionality — this was a real shipped defect,
  fixed in the P8 hardening commit; don't regress it.

## 7. PWA rules

The PWA (`public/sw.js`, `src/pages/offline.astro`,
`public/site.webmanifest`) is implemented. Preserve:

- The kill switch (`KILL_SWITCH` constant, ships `false`)
- Allowlist route policy — unknown routes bypass caching by default
- `/api/*` — never cached, in either direction
- Fact-check verdict pages — network-only (`fresh`), never served stale
- Static assets — cache-first
- HTML documents — network-first
- Page cache bounded at `MAX_PAGES = 40`, oldest-first eviction
- `canCache()` safety gates (rejects non-200, redirected, opaque,
  cross-origin, `no-store`/`private` responses)
- Offline fallback page, precached at install
- Install prompt (shows once per device, suppresses the native mini-infobar)
- Manifest `start_url`/`scope`/`shortcuts`
- No false `maskable` icon declaration (the current artwork isn't
  safe-zone-padded — don't re-add `purpose: maskable` without new artwork)

**Never cache credentials, user-specific data, API responses, or fact-check
verdicts** unless explicitly authorized as a new decision. If a new route is
added elsewhere in the app, it is uncached by default until `public/sw.js`'s
`route()` allowlist is deliberately edited to include it.

## 8. Security rules

Never introduce:

- `innerHTML`, `outerHTML`, `document.write`, `insertAdjacentHTML` in
  application code
- `eval` or `new Function` in shipped application code (a test harness
  evaluating the repo's own `public/sw.js` via `new Function` — to test the
  real shipped file rather than a re-typed copy — is legitimate test
  infrastructure; don't confuse that with an application-code violation)
- Secrets or credentials in source (`.dev.vars`/`.env` are gitignored; only
  `.dev.vars.example` with empty values is tracked)
- Unsafe dynamic HTML construction of any kind

Preserve:

- `isSafeUrl()` / `safeHref()` (`src/lib/url.ts`) on every URL used for
  `href`/`src`
- CSP and security headers (`src/lib/security/headers.ts`, applied via
  `src/middleware.ts`)
- Permissions-Policy (`geolocation=()` etc.)
- Parameterized SQL (`.bind()`) — never interpolate user values into a query
- Existing API validation and rate limiting

**Never weaken a security assertion or test just to make the suite pass.** If
a security regression is discovered (new High/Medium finding, removed guard,
weakened header), investigate and report it explicitly — don't silently patch
around it or silently accept it. If a security issue is found outside the
current task's scope, flag it (severity, evidence, affected files) rather
than fixing it inline — see §15.

## 9. Testing requirements

Every code-touching task runs, at minimum:

```
npx vitest run
npx astro check
npm run build
```

Plus:

- Test-integrity scan: no `.only`, `.skip`, `xit`, `fdescribe`, `xdescribe`,
  `skipIf`, `.todo` introduced; no test deleted, renamed to hide it, or
  weakened
- A protected-path diff check against §4
- Browser QA for UI/PWA/storage/accessibility/navigation changes (§10)

**Never** delete a test to make the suite pass, weaken an assertion, or add a
skip/only marker. If a test is wrong, say so and ask before changing it.

When adding new behavior, prefer a regression test over a manual claim of
correctness. For storage behavior, unit-test the real module — don't
duplicate its logic inside the test. For a served-verbatim script like
`public/sw.js` (a classic worker, not importable normally), evaluate the real
file (e.g. via Vite `?raw` + a stubbed global) rather than re-typing its
policy in the test — the established pattern in `tests/pwa/sw.test.ts`.

## 10. Browser verification

When browser QA is required, verify both functional behavior and rendered
output — don't rely on source inspection alone. Check responsive behavior at
approximately 375px (mobile) and 1280px (desktop).

When screenshots or click simulation are unavailable in the environment
(e.g. a non-compositing browser pane), **say so explicitly** and use
programmatic navigation, rendered-text extraction, and computed-geometry
checks instead. Never claim a click, screenshot, or visual inspection was
performed if it wasn't — state the actual verification method used.

No AT (NVDA/VoiceOver) available in this environment means no screen-reader
pass can be claimed — report that as a limitation, not a pass.

## 11. Diff discipline

Before editing:

```
git status --short
git diff
git log --oneline -10
```

After editing:

```
git diff --stat
git diff
git status --short
```

Always inspect the complete diff before proposing a commit. Investigate any
unexpected file in the diff before proceeding — don't assume it's fine.
Explicitly check the protected-path diff (§4) rather than eyeballing the
full diff and hoping nothing protected slipped in.

## 12. Commit rules

- Never `amend`, `squash`, or otherwise rewrite existing commits without
  explicit authorization for that specific action.
- Never `reset --hard`, `revert`, `stash` destructively, or force-push
  without explicit authorization.
- Never push unless explicitly instructed.
- One focused commit per authorized change when practical — don't bundle an
  unrelated fix into a phase/task commit.
- Commit message should describe the actual change, not the phase label
  alone.
- **Do not commit until the verification gate (§9) passes and the user has
  explicitly authorized the commit** — passing gates is necessary, not
  sufficient; authorization is a separate, required step.

After committing:

```
git status --short
git rev-parse HEAD
git rev-parse HEAD^
```

Confirm the working tree is clean and report the new hash and its parent —
don't assume the pre-commit verification still describes what's on disk.

## 13. PROGRESS.md rules

`PROGRESS.md` is status documentation, not a substitute for source truth (see
§2's priority order — it ranks below source and tests).

- Keep phase status accurate; re-verify before writing a status, don't carry
  forward a stale claim.
- Correct stale wording (e.g. "(uncommitted)" on a phase that has since been
  committed) when noticed, rather than leaving it to compound.
- When a phase/task is complete, record: what was delivered, test/check/build
  results, important architectural decisions (especially where the plan was
  ambiguous and a choice was made), known limitations, and intentionally
  deferred issues.
- **Never mark work complete when verification has not actually passed.**
- Record undocumented deviations from the implementation plan explicitly,
  with reasoning — don't silently resolve an ambiguity and let it read as if
  the plan always said that.

## 14. Honesty / documentation rule

NewzWale's public documentation and UI copy must describe the product that
actually ships — this has been violated before (`/about`, `/terms`, and
`/privacy` all contained claims unsupported by source; `/about` and `/terms`
were corrected in P10.1, `/privacy` was corrected in P10.1b
(`c1e8376`)).

Before changing or writing public-facing documentation, **grep every
important factual claim against the source** — don't rely on the existing
copy being accurate, and don't write new copy from assumption.

Do not claim, without source support:

- Nonexistent AI models, voice synthesis, or capabilities (e.g. Sarvam AI)
- Nonexistent providers or ingestion sources (e.g. PTI/ANI/PIB wire feeds)
- Nonexistent accounts, sign-in, or authentication (including OAuth)
- Nonexistent synchronization (cross-device, cross-browser)
- Nonexistent interface translation
- Unsupported data collection or retention claims
- Unsupported traffic/user metrics ("millions of readers")
- Unsupported guarantees

When documentation is legally sensitive (privacy policy, terms of service),
**distinguish technical corrections** (a claim a grep can prove or disprove
against source) **from legal-policy decisions** (a business/compliance
commitment that code cannot verify, e.g. "we never sell your data," data
retention periods, regulatory compliance language). Only the former is safe
to correct as a documentation task; the latter needs the user's or counsel's
judgment — flag it, don't silently rewrite it.

## 15. Scope control

- Implement only the authorized task. A bug fix doesn't need surrounding
  refactor; a docs task doesn't need code changes beyond what's needed to
  verify the docs are accurate.
- Do not "clean up" unrelated code, rename things noticed mid-task, or touch
  a protected path because an improvement is visible there.
- If a real defect is discovered outside the requested scope: **do not
  silently fix it.** Report severity, reproducibility, evidence (file/line),
  affected files, a recommended fix, and whether it blocks the current task.
  Then continue the authorized task only if it remains safe to do so
  independent of the found defect.
- If the defect materially invalidates the current task's premise, stop and
  ask rather than proceeding on a shaky foundation.
- Distinguish an actual bug from a documented intentional design decision
  before proposing a fix (e.g. `/api/news` intentionally stays on the legacy
  provider chain rather than D1; search intentionally orders by recency, not
  relevance, given the Indic tokenizer finding).

## 16. Infrastructure boundaries

Do not invent, without the plan explicitly requiring it and the user
authorizing it:

- New APIs or endpoints
- New databases or storage backends
- Remote feature flags or polled kill-switches
- Authentication systems
- External infrastructure
- New dependencies (check stdlib / native platform / an already-installed
  dependency first — this is a 4-runtime-dependency project by design)

If a task requires credentials, Cloudflare resource provisioning (D1
`database_id`, deploy tokens), domain ownership, a GA consent decision, or
any other externally-gated action: **identify the blocker explicitly and ask
for the required action/credential** rather than fabricating a placeholder.
Never hard-code a credential, ever, even a fake one "to unblock testing."

## 17. Known open issues (tracked, not automatic work)

These are documented findings from prior audits. Do not fix any of them
without a specific authorization — they are listed here so they aren't
rediscovered from scratch every session, not as a standing to-do list:

- **CSP is still Report-Only** (S-11, partially open). The prerendered-route
  half was closed in P10 by `public/_headers`; enforcing the policy still needs
  build-time SHA-256 hashes for the six inline scripts. If you edit
  `src/lib/security/headers.ts`, `tests/security/headers-file.test.ts` will
  fail until `public/_headers` is updated to match — that is deliberate.
- Google Analytics loads unconditionally with no consent gate (S-10, open).
  This also blocks the P10 analytics events: there is no consent mechanism for
  them to respect.
- ~~`.github/workflows/deploy.yml` runs audit/tests/check/build but does not
  deploy (audit item P-14).~~ **CLOSED.** The workflow now runs
  `npx wrangler deploy` after the build, gated on
  `github.event_name == 'push' && github.ref == 'refs/heads/main'` so a
  pull_request run can never publish unreviewed (or fork-authored) code.
  Merging to `main` is now the release action; `npm run deploy` remains
  available for a manual push.
- **Cron ingestion is live and quota-sized.** `0 */2 * * *`, English only,
  8 categories — one NewsData request per category, so 96/day against a
  documented 200/day free tier. The remaining headroom is not spare: the
  on-demand read path (`/api/news`, still serving the homepage) spends from
  the SAME quota on a cache miss. **Do not raise the frequency or add
  languages without re-measuring that shared spend** — adding a language
  multiplies the cost by the number of languages, which is the trap Phase 2's
  risk note names. Schedule lives in `wrangler.jsonc`; the tick's logic is
  `src/lib/news/schedule.ts` (unit-tested), called from `scheduled()` in
  `src/worker.ts`.
- `wrangler.jsonc` `main` points at **`./src/worker.ts`**, not the adapter —
  a cron trigger calls `scheduled()` on the default export and the adapter's
  entrypoint exports only `fetch`. `src/worker.ts` spreads the adapter's
  handler so the request path is unchanged. If you change `main` back, cron
  silently stops working while the site keeps serving.
- The implementation plan references a "P8 performance budget" for P10's
  performance-check gate; Phase 8's own section defines no such budget — it
  does not exist anywhere in the plan.
- `src/layouts/Layout.astro:77` hardcodes `<meta name="robots" content="index,
  follow">` with no per-page override, so `/offline`, `/saved` and
  `/fact-check/history` advertise as indexable. They are absent from
  `sitemap.xml`, so discovery is unlikely; a `noindex` prop would be the
  honest fix.

Closed in P10 (kept here only so they are not "rediscovered" as regressions):
`public/robots.txt` `/admin` disallow, the missing `npm audit` CI gate, the
prerendered-route security-header gap, retired four-verdict terminology in
`README.md`/`docs/WEBSITE-DOCUMENTATION.md`, and the README-vs-PROGRESS domain
contradiction (README was correct — the site is live at
`https://www.newzwale.com`).

Closed after the full production audit: an unlayered `body{}` rule in
`global.css` was silently defeating `BottomNav`'s safe-area padding on every
mobile route (PR #23); D1 provisioning and the `0002` migration gap (PR #25);
a fact-check evidence blockquote with no word-break protection could overflow
the page when a source's extracted text had no natural break points (PR #25);
a freshly-disclosed high-severity `nanoid` advisory in the Tailwind/PostCSS
build toolchain, unrelated to any of this work (PR #25).

## 18. Current state

As of this update: P4–P9 complete and committed. P10.1 (`8ed5759`) and P10.1b
(`c1e8376`) corrected the unsupported product claims on `/about`, `/terms` and
`/privacy`; the legal-policy provisions in those pages (data-selling
commitment, retention/access language, regulatory-compliance language) were
deliberately left untouched as decisions for the user or counsel, not
technical corrections.

**All P10 work that can be done without credentials or a pending decision is
now complete** — prerendered-route security headers (S-11), the `robots.txt`
`/admin` removal (P1), the `npm audit` CI gate (S-16), and the
README/WEBSITE-DOCUMENTATION/AGENTS sync.

P10 overall remains **in progress**. What is still open is blocked on a
product/legal decision (GA consent, and therefore the analytics events), a
protected-path authorization (the `package.json` migration-script fix), or a
missing definition (the performance budget). See §17.

**The site IS deployed, and deployment is now automatic.** Superseding the
long-standing "nothing has been deployed" note:

- `wrangler` is authenticated on this machine by **OAuth**, not
  `CLOUDFLARE_API_TOKEN`. Checking only for that env var reports a blocker
  that does not exist — check `npx wrangler whoami` before claiming deploy is
  impossible.
- Production carries all four secrets (`TAVILY_API_KEY`,
  `GOOGLE_FACTCHECK_API_KEY`, `NEWSDATA_API_KEY`, `GUARDIAN_API_KEY`) as
  Worker secrets. `.dev.vars` is local-only and is NOT what production reads;
  a new key must be added with `wrangler secret put`, never by editing
  `.dev.vars` alone.
- Remote D1 is provisioned, migrated and populated by the 2-hourly cron.
- **Merging to `main` now deploys.** Treat `main` as production: a merge is a
  release, not a checkpoint.

Do not begin P11, or any item in §17, without explicit authorization for that
specific task.
