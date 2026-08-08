# NewzWale — Target Architecture

**Date:** 2026-08-08
**Status:** Proposal. Awaiting approval. Nothing here is implemented.
**Supersedes:** [`DECISIONS.md`](../DECISIONS.md), which describes an
architecture (Sarvam AI voice, `/admin`, grounded chat, FastAPI + Postgres)
that has not existed since the rebuild. See
[`NEWZWALE_AUDIT.md`](NEWZWALE_AUDIT.md) §P-12.

Current-state architecture is documented in
[`NEWZWALE_AUDIT.md`](NEWZWALE_AUDIT.md) §2. This document describes only the
target and the delta.

---

## 1. Principles that constrain the architecture

These are not preferences; they rule out designs.

| Principle | Architectural consequence |
|---|---|
| Evidence before confidence | Every verdict must carry a machine-readable evidence-strength value derived from the evidence set, not from the model's self-report |
| Never invent sources / citations | No generative step may produce a URL, a publisher name, or a date. Those fields are only ever copied from a retrieval response |
| Distinguish fact from inference | The result schema must separate *what a source said* from *what the system concluded*. `basis` is retained and extended |
| Never trust a single source | Corroboration is a schema-level requirement, not a prompt instruction. A verdict object records how many independent domains supported it |
| Preserve URLs and dates | `publishedAt` becomes a required field on evidence. Missing dates are recorded as missing, never inferred |
| Mobile-first | The API contract must be usable by a client that is not the website. Server rendering must not be the only path to content |
| Security mandatory | Untrusted fetched content is a distinct trust tier with its own handling rules throughout |

---

## 2. Shape of the system

```
                        ┌───────────────────────────────────────┐
                        │  Clients                              │
                        │  • Web (Astro SSR + islands)          │
                        │  • PWA (same origin, installable)     │
                        │  • Native (optional, later)           │
                        └───────────────┬───────────────────────┘
                                        │  HTTPS, same contract
                        ┌───────────────▼───────────────────────┐
                        │  /api/v1/*  — versioned JSON contract  │
                        │  Zod-validated in and out             │
                        └───────────────┬───────────────────────┘
                                        │
    ┌───────────────────────────────────┼───────────────────────────────────┐
    │                                   │                                   │
┌───▼─────────────┐          ┌──────────▼──────────┐           ┌────────────▼───────┐
│ News domain     │          │ Fact-check domain   │           │ Shared platform    │
│ src/lib/news    │          │ src/lib/factcheck   │           │ src/lib/*          │
│                 │          │                     │           │                    │
│ ingest          │          │ extract claim       │           │ cache (KV)         │
│ normalize       │          │ retrieve evidence   │           │ ratelimit (DO)     │
│ dedupe/cluster  │          │ score sources       │           │ url safety         │
│ categorize      │          │ compare             │           │ http (timeout/cap) │
│ rank (trending) │          │ verdict + strength  │           │ logging            │
│ index (search)  │          │ explain             │           │ headers/CSP        │
└───┬─────────────┘          └──────────┬──────────┘           └────────────────────┘
    │                                   │
    └───────────────┬───────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────────────────────┐
    │  Storage                                                             │
    │  D1 (SQLite)   articles, sources, story_clusters, fact_checks,       │
    │                fact_check_evidence, claims                           │
    │  KV NEWZ_CACHE upstream response cache, hot reads, TTL only          │
    │  Durable Object  rate-limit counters (atomic)                        │
    │  R2 (later)      uploaded images for image fact-checking             │
    └──────────────────────────────────────────────────────────────────────┘
                    │
    ┌───────────────▼──────────────────────────────────────────────────────┐
    │  External                                                            │
    │  NewsData.io · Guardian · publisher RSS · Google Fact Check Tools ·  │
    │  Tavily · Workers AI · Open-Meteo (server-side) · Yahoo (cached)     │
    └──────────────────────────────────────────────────────────────────────┘
```

**Everything stays on Cloudflare.** No new runtime, no separate backend
service, no container. The delta from today is: a database, a Durable Object,
a versioned API layer, and a scheduled worker.

---

## 3. Key architectural decisions

### AD-01 · Adopt Cloudflare D1 as the system of record

**Status:** Requires your approval.

Today there is no persistence. The target route set is impossible without it:

| Route | Why it needs storage |
|---|---|
| `/news/[slug]` | An article needs a stable identity and a slug |
| `/trending` | Ranking needs observations over time, not a point-in-time feed |
| `/search` | Needs an index; filtering already-loaded DOM cards is not search |
| `/fact-check/[id]` | A permalink needs a persisted, addressable result |
| `/fact-check/history` | History needs records |
| "Multiple-source coverage" | Needs cross-source story clustering, which needs a corpus |
| "Fact Check Available" on a card | Needs a claim↔article link |

**Why D1 over the alternatives:**

| Option | Verdict |
|---|---|
| **D1 (SQLite)** | ✅ Native binding, zero new infra, SQL joins for clustering and history, real indexes, FTS5 for search. Free tier covers this workload comfortably |
| KV only | ❌ No queries, no joins, no ordering, eventually consistent. Already the current constraint |
| Durable Objects as store | ❌ Excellent for counters, wrong shape for a queryable corpus |
| External Postgres | ❌ Adds a second provider, egress cost, connection pooling from Workers, and latency. No benefit at this scale |

**Consequence:** D1 is eventually consistent for *read replicas* and has write
throughput limits. Both are fine here — writes are batched by a scheduled
ingest, not by user traffic.

### AD-02 · Keep KV, narrow its job

KV becomes strictly an **upstream response cache with a TTL**. It stops being
the system of record for fact-check results (which move to D1) and stops
holding rate-limit counters (which move to a Durable Object, per security
S-01). The existing `cached()` helper with its stale-on-error behaviour
(`src/lib/cache.ts:17-35`) is good and is retained unchanged.

### AD-03 · Introduce a versioned `/api/v1/*` contract

Today's endpoints are website-internal. A mobile client — PWA or native —
needs a stable, documented, validated contract.

- All new endpoints land under `/api/v1/`.
- Request and response shapes validated with a schema library at **both** the
  boundary and in tests, so the contract cannot drift silently.
- Existing `/api/news`, `/api/factcheck`, `/api/ticker` are kept as thin
  aliases during migration, then removed after the web client moves.

**Dependency note.** This is the one place the plan may justify a new runtime
dependency (Zod or Valibot, ~14 KB). Per the repo's own rule — check whether an
existing dependency solves it first — the honest assessment is that
hand-written type guards *do* work (`isValidCategory`, `coerceVerdict` are
already good examples) and cost nothing. **Recommendation: hand-written guards
in a single `schema.ts` per domain, no new dependency**, revisited only if the
guard code exceeds ~200 lines.

### AD-04 · Stop the self-subrequest fan-out

Pages currently `fetch()` their own API (audit §4.1) — seven round trips per
homepage render. Target: page components import a shared server module
(`src/lib/news/service.ts`) that reads D1/KV directly. `/api/v1/news` becomes a
thin HTTP wrapper over the same module, for external clients only.

This is a pure refactor with no user-visible change and it removes a real
subrequest-limit risk. It is the first thing in Phase 0.

### AD-05 · Move ingestion to a scheduled worker

Today, news is fetched **on the read path**, cached for 20 minutes, and a cold
cache makes the user wait for NewsData. Target: a Cron Trigger runs ingestion
every 10 minutes, writes normalised articles to D1, and the read path only ever
queries D1. The upstream fetch leaves the user's critical path entirely.

This is also what makes deduplication, clustering, trending, and search
possible — all of them need a corpus, not a single response.

The existing NewsData → Guardian → RSS fallback chain
(`src/pages/api/news.ts:33-60`) moves into the scheduled job unchanged. Its
logic is sound; only its trigger changes.

### AD-06 · Three trust tiers for content

Made explicit because the security findings all trace back to this being
implicit today:

| Tier | Examples | Rules |
|---|---|---|
| **Trusted** | Our own DB rows, our config, our allowlists | Render freely |
| **Semi-trusted** | Upstream API responses (NewsData, Tavily, Google FC) | Validate shape; URL-scheme check before any `href`/`src`; never `innerHTML` |
| **Untrusted** | HTML fetched from arbitrary URLs; user input | Fetch with timeout + size + content-type caps; fence before sending to a model; never treat as instructions; never render |

Every module handling untrusted content documents which tier it operates on.

### AD-07 · Ship the mobile experience as a PWA first

**Status:** Requires your approval.

The requirement is "website and mobile app share the same backend, APIs,
database, authentication and fact-checking engine wherever practical". A PWA
shares **all** of them by construction, because it *is* the web app.

| Option | Shares backend | New stack | Store presence | Effort |
|---|---|---|---|---|
| **PWA** (recommended) | Fully, by definition | None | Installable; can be wrapped for stores later | Low |
| React Native / Expo | Via `/api/v1` | Full second stack | Yes | High |
| Flutter | Via `/api/v1` | Full second stack | Yes | High |

A `site.webmanifest` already exists with correct icons
([`public/site.webmanifest`](../public/site.webmanifest)). What is missing for
a real PWA: a service worker (offline shell, saved-articles offline reading),
`display: standalone` navigation handling, and an install prompt.

`/api/v1` (AD-03) is built regardless, so a native client remains a later
option with no rework — that is the "wherever practical" hedge.

### AD-08 · Defer accounts; make the local-only stance explicit

**Status:** Requires your approval.

`/fact-check/history` and cross-device saved articles are the only features
that need identity.

Recommended sequencing:
1. **Now:** history and saved articles stay device-local (IndexedDB, upgraded
   from today's `localStorage`), and the UI *says so plainly*. `/fact-check/[id]`
   permalinks make individual results shareable without an account.
2. **Later, only if demanded:** optional accounts. If added, use a hosted
   identity provider — do not hand-roll. The repo has been here before: the
   rebuild deleted a `btoa(email)` session scheme (`PROGRESS.md`).

Building auth now would add the largest security surface in the project to
serve a feature no one has asked for yet.

---

### AD-10 · Provider abstraction — decouple from NewsData.io

**Status:** Required by brief Part 9. Not previously specified.

Today the three news sources are three imperative function calls inside
[`api/news.ts:33-60`](../src/pages/api/news.ts), with the fallback chain
hardcoded into the route. NewsData is structurally privileged: it is the only
paginated source, the only multilingual one, and the only one the cache key
shape assumes.

Target — an interface, with the chain as configuration rather than control flow:

```ts
interface NewsProvider {
  readonly id: string;
  readonly capabilities: {
    paginated: boolean;
    languages: readonly string[];
    categories: readonly string[];
  };
  fetch(opts: FetchNewsOptions): Promise<NewsPage>;
}

interface FactCheckProvider {
  readonly id: string;
  readonly tier: SourceTier;
  search(claim: string, lang: string): Promise<ProviderResult>;
}
```

```
NewsProvider          FactCheckProvider
├── RSSProvider       ├── GoogleFactCheckProvider
├── NewsDataProvider  ├── SearchProvider (Tavily)
├── GuardianProvider  ├── DirectSourceProvider
└── FutureProvider    └── FutureProvider
```

Two consequences worth stating:

1. **RSS is promoted to a first-class provider**, not a last-resort fallback.
   The brief says the free/base architecture should prioritise RSS. That also
   removes the quota cliff identified in Phase 2's risk list, because RSS has
   no per-day cap.
2. **The existing `newsdata.ts`, `guardian.ts`, and `rss.ts` modules are
   reused as-is** and simply wrapped. Their parsing logic is tested and
   correct; only their invocation changes. This is a wrapping refactor, not a
   rewrite.

The RSS parser does need real work — it is a regex parser
([`rss.ts:10-20`](../src/lib/news/rss.ts)) with no `media:content` support, so
RSS articles never carry images. Promoting RSS to primary makes that a
blocking defect rather than a cosmetic one.

### AD-11 · Higgsfield — verified, not installed

**Status:** Awaiting your decision (D11).

Verified on 2026-08-08:

| Check | Result |
|---|---|
| `~/.claude/skills` | No Higgsfield skill |
| `~/.claude/plugins/installed_plugins.json` | Not present (installed: superpowers, frontend-design, code-review, ponytail) |
| Project + user MCP config | No Higgsfield server |
| Vendor site | An official **MCP + CLI** integration exists at `higgsfield.ai/mcp` |

Installation requires a Higgsfield account and credentials. Per brief Part 19
— *"do NOT silently install random packages, first verify the available
integration"* — verification is done and **installation is not proceeding
without your go-ahead**.

**Scope if adopted.** Higgsfield is a *creative asset* tool and sits entirely
outside the evidence path:

| Permitted | Forbidden |
|---|---|
| Brand assets, illustrations, hero visuals, onboarding graphics, promotional and social graphics, decorative media | Fact-check verdicts, evidence, source validation, news ingestion, factual claims, database logic, auth, security decisions |

Hard rule, recorded in the architecture because it is an integrity boundary:
**no generated image may ever depict or imply a source, a document, a
screenshot, or a citation.** Fabricated evidence visuals are exactly the
failure mode this product exists to oppose. Generated media is confined to
brand and decorative surfaces and is never rendered inside a fact-check result.

If Higgsfield is not needed for a given surface, it is not used there.

### AD-12 · Image pipeline — evaluate Cloudflare Images before adding a vendor

**Status:** Awaiting your decision (D12). **New finding.**

`astro check` emits:

```
[@astrojs/cloudflare] Enabling image processing with Cloudflare Images
                      for production with the "IMAGES" Images binding.
```

The adapter auto-enables Cloudflare Images, but
[`wrangler.jsonc`](../wrangler.jsonc) declares **no `images` binding**. This is
the identical trap the `SESSION` binding hit — the file already carries a
comment explaining that the adapter injects a binding which must be declared or
deploys fail. This one has not been declared. **Verify against a real deploy.**

Consequence for the ImageKit question: an image transformation and optimisation
path may already be present in the stack, unused and undeclared.

**Recommended order:** declare `IMAGES`, confirm it works, and evaluate it
against the Part 20 requirements (source thumbnails, safe proxying and caching,
CDN transformation, attribution, user-uploaded fact-check images). Adopt
ImageKit only if a concrete requirement Cloudflare Images cannot meet is
identified. Adding a second media vendor to satisfy a need the incumbent
already covers is exactly the kind of dependency the brief's Part 21 rules out.

Either way, the licensing rule from Part 20 holds: **publisher images are not
blindly downloaded and redistributed.** The architecture supports hotlinking
with attribution, or proxy-with-cache where terms permit — that is a per-source
decision recorded on the `sources` row, not a global default.

---

## 4. Target route map

### 4.1 Pages

| Route | Type | Purpose | New? | Blocked on |
|---|---|---|---|---|
| `/` | SSR | Home. Lead story, topic rails, fact-check entry | Exists | — |
| `/news` | SSR | Full chronological feed, filterable | New | — |
| `/news/[slug]` | SSR | **Story page** — see AD-09 | New | D1, decision |
| `/category/[category]` | SSR | Category feed | Exists | — |
| `/trending` | SSR | Ranked by velocity + coverage breadth | New | D1, ingest history |
| `/search` | SSR | Full-text over indexed articles + fact-checks | New | D1 FTS5 |
| `/fact-check` | SSR | The checker (today's `/verify`) | Rename | Redirect from `/verify` |
| `/fact-check/[id]` | SSR | Permalink to one completed check | New | D1 |
| `/fact-check/history` | SSR shell + client | Your past checks | New | Local store |
| `/saved` | SSR shell + client | Saved articles (today: a drawer) | New | Local store |
| `/about` | Static | Mission, team, limitations | Exists | — |
| `/methodology` | Static | **How fact-checking works** — extracted from the section currently inside `verify.astro:47-71`. Must state which verdicts are in active use | New | — |
| `/contact` `/privacy` `/terms` | Static | Retained | Exists | — |
| `/404` `/500` | Prerendered | Retained | Exists | — |
| `/profile` | — | Future, gated on auth (D5) | Future | Accounts |

`/methodology` earns its own route rather than staying a page section: it is
the document a sceptical reader is sent to, it needs to be linkable from every
verdict badge, and burying the product's credibility argument inside a tool
page undersells it.

**`/verify` → `/fact-check`** must be a permanent 301, not a replacement:
`/verify` is in `public/sitemap.xml`, linked from the footer, from
`FactCheckPromo`, from the floating CTA, and is presumably indexed.

### 4.2 API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/news` | GET | `category`, `language`, `cursor`, `limit` |
| `/api/v1/news/[slug]` | GET | One story + its coverage cluster + linked fact-checks |
| `/api/v1/trending` | GET | Ranked stories |
| `/api/v1/search` | GET | `q`, `type=news\|factcheck\|all`, `cursor` |
| `/api/v1/factcheck` | POST | Submit a claim or URL → full result with `id` |
| `/api/v1/factcheck/[id]` | GET | Retrieve a persisted result |
| `/api/v1/weather` | GET | Server-side, using `request.cf`; replaces 3 client-side third-party calls (security S-09) |
| `/api/v1/ticker` | GET | KV-cached 60 s, rate-limited (security S-08) |

All responses share an envelope so clients handle errors uniformly:
```jsonc
{ "data": { /* ... */ }, "meta": { "cursor": "…", "cached": true } }
{ "error": { "code": "RATE_LIMITED", "message": "…" } }   // non-2xx
```

### 4.3 Mobile equivalents

| Web route | Mobile surface |
|---|---|
| `/` | Home tab |
| `/news`, `/category/*` | Home tab, category chips |
| `/trending` | Trending tab |
| `/search` | Search tab |
| `/fact-check` | **Fact Check tab — the primary differentiator, given its own tab** |
| `/fact-check/[id]` | Result screen; deep-linkable, shareable |
| `/fact-check/history`, `/saved` | You tab |
| `/news/[slug]` | Story screen |

Bottom tab bar: **Home · Trending · Fact Check · Search · You**.
The same five destinations exist on the web as top-level nav, so the two
experiences do not diverge conceptually.

### AD-09 · `/news/[slug]` is a story page, not a reproduction

**Status:** Requires your approval.

`README.md` states NewzWale links out to publishers with "no rewritten copy, no
invented summaries", and `PROGRESS.md` defers in-site article reading
explicitly as *a licensing question, not an engineering one*. Hosting article
bodies would reverse both.

Proposed content for `/news/[slug]` — a page that adds value **without**
reproducing the article:

- Headline, publisher, timestamp, category, estimated reading time
- A short attributed extract (the publisher's own `description`, quoted and
  credited — not rewritten)
- **Prominent "Read full story at &lt;publisher&gt;" link**
- **Coverage cluster:** "Also reported by" — the same story from other sources,
  which is the genuine reader value and is only possible once clustering exists
- **Fact-check panel:** any checked claims from this story, or a "Check a claim
  from this story" action
- Related stories

This is a defensible, original page. It is also the thing that makes
"multiple-source coverage" in the target IA real.

---

## 5. Data model (D1)

Illustrative DDL. Column-level detail is settled in Phase 2, not here.

```sql
-- Publishers, with the quality signals the fact-check pipeline needs.
CREATE TABLE sources (
  id            TEXT PRIMARY KEY,        -- 'thehindu'
  domain        TEXT NOT NULL UNIQUE,    -- 'thehindu.com'
  display_name  TEXT NOT NULL,
  country       TEXT,
  -- Provenance-based, NOT political-lean based. See the fact-check spec.
  quality_tier  TEXT NOT NULL CHECK (quality_tier IN
                  ('primary','ifcn_factchecker','established_news','other','low_reliability')),
  ifcn_signatory INTEGER NOT NULL DEFAULT 0,
  notes         TEXT
);

CREATE TABLE articles (
  id            TEXT PRIMARY KEY,        -- sha256(canonical_url)
  slug          TEXT NOT NULL UNIQUE,
  canonical_url TEXT NOT NULL UNIQUE,    -- utm/fbclid stripped
  title         TEXT NOT NULL,
  summary       TEXT,                    -- publisher's own, verbatim
  image_url     TEXT,
  source_id     TEXT REFERENCES sources(id),
  category      TEXT NOT NULL,           -- OUR slug, not upstream's (fixes P-17)
  language      TEXT NOT NULL,
  published_at  TEXT NOT NULL,           -- ISO 8601
  ingested_at   TEXT NOT NULL,
  cluster_id    TEXT REFERENCES story_clusters(id),
  reading_time_seconds INTEGER
);
CREATE INDEX idx_articles_feed ON articles(category, language, published_at DESC);
CREATE INDEX idx_articles_cluster ON articles(cluster_id, published_at DESC);

-- One real-world story, covered by many articles. Powers "Also reported by",
-- trending breadth, and honest deduplication.
CREATE TABLE story_clusters (
  id             TEXT PRIMARY KEY,
  representative_article_id TEXT,
  headline       TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  article_count  INTEGER NOT NULL DEFAULT 1,
  source_count   INTEGER NOT NULL DEFAULT 1,
  trending_score REAL NOT NULL DEFAULT 0
);

CREATE TABLE fact_checks (
  id             TEXT PRIMARY KEY,       -- sha256(normalized_claim), stable + shareable
  claim          TEXT NOT NULL,
  claim_source   TEXT NOT NULL CHECK (claim_source IN ('text','url','image')),
  origin_url     TEXT,
  verdict        TEXT NOT NULL CHECK (verdict IN
                   ('true','false','partly_true','misleading','unverified','needs_context')),
  evidence_strength TEXT NOT NULL CHECK (evidence_strength IN
                   ('strong','moderate','weak','none')),
  basis          TEXT NOT NULL CHECK (basis IN ('certified','ai_assessment','none')),
  summary        TEXT NOT NULL,          -- one line
  reasoning      TEXT NOT NULL,          -- "why this verdict"
  limitations    TEXT,                   -- what we could NOT establish
  independent_domain_count INTEGER NOT NULL DEFAULT 0,   -- principle 6, enforced
  model_id       TEXT,
  pipeline_version TEXT NOT NULL,
  checked_at     TEXT NOT NULL,
  article_id     TEXT REFERENCES articles(id)
);
CREATE INDEX idx_fc_verdict ON fact_checks(verdict, checked_at DESC);

CREATE TABLE fact_check_evidence (
  id            TEXT PRIMARY KEY,
  fact_check_id TEXT NOT NULL REFERENCES fact_checks(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  publisher     TEXT NOT NULL,
  source_id     TEXT REFERENCES sources(id),
  published_at  TEXT,                    -- NULL = genuinely unknown, never guessed
  stance        TEXT NOT NULL CHECK (stance IN ('supporting','contradicting','contextual')),
  quality_tier  TEXT NOT NULL,
  quoted_passage TEXT,                   -- the exact text relied on
  read_method   TEXT NOT NULL CHECK (read_method IN ('full_page','search_snippet')),
  injection_flagged INTEGER NOT NULL DEFAULT 0,
  rating        TEXT                     -- publisher's own rating, certified path only
);

-- Full-text search over both corpora.
CREATE VIRTUAL TABLE articles_fts USING fts5(title, summary, content=articles, content_rowid=rowid);
CREATE VIRTUAL TABLE claims_fts   USING fts5(claim, summary, content=fact_checks, content_rowid=rowid);
```

### 5.1 Conventions required by brief Part 8

- Every table carries `created_at` and `updated_at` (ISO 8601 TEXT).
- `fact_checks` additionally carries `pipeline_version`, `model_id`, and
  `evidence_version`. **Fact-check rows are append-only**: a re-check under a
  new pipeline version writes a *new* row and supersedes rather than mutating,
  so an old shared permalink still resolves to the result the reader saw.
  Auditability is the requirement; immutability is the mechanism.
- `sources` carries `retrieved_at` alongside `published_at`, per principle 7.
- `user_id` is present and **nullable** on `saved_items`, `history`, and
  `fact_checks` from the first migration. It stays NULL while the product is
  device-local (D5); adding accounts later becomes an additive change rather
  than a destructive migration. This costs one nullable column now and saves a
  data migration later.

### 5.2 Deferred tables

Named in the brief but **not created in the first migration**, per its own
instruction not to blindly create every table:

`users` (until D5), `saved_items` / `history` (device-local in Phase 8 — created
only if sync is adopted), `related_claims` (derived from `claims_fts` at query
time; a table only if the query proves too slow), `verdicts` (an enum column on
`fact_checks`, not a table — a lookup table for six fixed values is
ceremony), `source_snapshots` (Phase 4, only if we decide to retain retrieved
page text, which has a storage and licensing cost).

Three schema choices deserve their reasoning stated:

- **`published_at` is nullable on evidence, and NULL means "unknown".** It is
  never backfilled with the fetch time. Principle 7 is about preserving real
  dates; a fabricated date is worse than an absent one.
- **`independent_domain_count` is a stored column, not a computation.** It is
  how principle 6 stops being an aspiration: a verdict row *records* how many
  independent domains supported it, and the UI can refuse to present a strong
  verdict backed by one.
- **`read_method`** makes the current silent snippet-fallback
  (`factcheck.ts:191-197`) visible to the reader.

---

## 6. Directory structure

Additive. Nothing existing moves except where noted.

```
src/
  lib/
    news/
      types.ts          (extend)   categories.ts  languages.ts
      newsdata.ts  guardian.ts  rss.ts  feed.ts     (unchanged)
      canonical.ts      NEW  URL canonicalisation for real dedup
      cluster.ts        NEW  story clustering
      service.ts        NEW  the one read path — replaces self-fetch (AD-04)
      ingest.ts         NEW  scheduled ingestion
      trending.ts       NEW  ranking
    factcheck/
      types.ts  extract.ts  google.ts  search.ts  verdict.ts   (all extend)
      claim.ts          NEW  claim extraction — today's biggest gap (P-05)
      sources.ts        NEW  source quality tiers
      evidence.ts       NEW  stance, corroboration, strength
      prompt.ts         NEW  fenced, injection-resistant prompt construction
      pipeline.ts       NEW  orchestrator lifted out of the route
      schema.ts         NEW  single source of truth for the verdict enum
    db/
      client.ts  migrations/  queries/                NEW
    http.ts             NEW  fetch with timeout + size + content-type caps (S-04)
    url.ts              NEW  shared isSafeUrl + canonicalisation (S-12)
    search.ts           NEW  FTS query building
    cache.ts  contrast.ts                              (unchanged)
    ratelimit.ts        (rewrite onto a Durable Object, S-01)
  middleware.ts         NEW  security headers + CSP (S-11)
  components/
    news/     ArticleCard  StoryCard  CoverageList  TrendingList  …
    factcheck/ ClaimInput  VerdictBadge  EvidenceList  EvidenceItem
               SourceQualityChip  LimitationsPanel  RelatedClaims
    shell/    Navbar  BottomNav(NEW)  Footer  Layout  …
  pages/
    news/  category/  fact-check/  search.astro  trending.astro
    api/v1/…
public/
  sw.js               NEW  service worker (AD-07)
```

---

## 7. What is explicitly NOT in the target architecture

Recording these so they do not creep back in:

- **No React/Vue/Svelte.** Astro islands with vanilla scripts have carried the
  interactivity so far. Adding a framework is not justified by any requirement
  in the spec.
- **No CSS framework beyond Tailwind v4**, and no component library. The token
  system in `global.css` plus `DESIGN.md` is the design system.
- **No political lean scoring.** Explicitly out of scope per the product spec —
  source quality is provenance-based. See
  [`NEWZWALE_FACTCHECK_SPEC.md`](NEWZWALE_FACTCHECK_SPEC.md) §6.
- **No hosted article bodies** unless AD-09 is overridden.
- **No accounts** until AD-08 is revisited.
- **No second backend service.** Everything is one Worker plus bindings.
- **No new runtime dependency** unless a specific decision records why the
  existing four cannot do the job.
