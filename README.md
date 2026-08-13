<div align="center">

# NewzWale

**Only Facts News**

Live Indian news, in 13 languages — plus a fact-checker that never guesses.

[![CI](https://github.com/Yrathore97/NewzWale/actions/workflows/deploy.yml/badge.svg)](https://github.com/Yrathore97/NewzWale/actions/workflows/deploy.yml)
[![Built with Astro](https://img.shields.io/badge/built%20with-Astro-BC52EE?logo=astro&logoColor=white)](https://astro.build)
[![Deployed on Cloudflare Workers](https://img.shields.io/badge/deployed%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)

[**Live Site →**](https://www.newzwale.com)

</div>

---

## What it is

NewzWale is two things, not seven:

1. **A live headline feed** — real Indian news, pulled per category and language, always linking out to the original publisher. No rewritten copy, no invented summaries.
2. **A fact-checker** — paste a headline, a claim, or an article URL. It retrieves published fact-checks and live web evidence in parallel, and a deterministic gate — not the model — settles the verdict: `True`, `False`, `Partly true`, `Misleading`, `Needs context`, or **`Unverified`**. `True` and `False` require independent corroboration before they can be issued. It does not guess.

Full write-up of what it does and how it was built: [`docs/WEBSITE-DOCUMENTATION.md`](docs/WEBSITE-DOCUMENTATION.md) ([PDF](docs/NewzWale-Documentation.pdf)).

## Features

| | |
|---|---|
| 📰 **Live headlines** | 8 categories, 13 languages, cached and RSS-backed for resilience |
| ✅ **Fact Check Explorer** | Certified lookup and web evidence retrieved in parallel; a deterministic gate has the last word and can only downgrade what the model proposed |
| 🕘 **Fact-check history** | Every check you run, kept on your device — capped at 50, filterable by verdict, never synced |
| 🔍 **Search** | Full-text over indexed articles and fact-checks, with a `LIKE` fallback for scripts FTS5 tokenises poorly |
| 📊 **Trending** | Ranked by how many independent outlets cover a story, not by clicks — the site collects no engagement data to rank on |
| 🔖 **Save articles** | Bookmark any story, in a drawer or on the `/saved` page — no account needed |
| 🎛️ **Customize topics** | Show or hide homepage sections to match what you read |
| 📱 **Installable PWA** | Offline shell, explicit cache allowlist, shipped kill switch — `/api/*` and verdict pages are never served from cache |
| 📈 **Live market ticker** | Sensex/Nifty — hides itself rather than ever showing a stale number |
| 🌗 **Dark mode** | Full token-based theme, not a bolted-on toggle |
| ♿ **Accessibility-tested** | WCAG contrast pairs enforced in CI, not just eyeballed |

## Tech stack

| | |
|---|---|
| **Framework** | [Astro](https://astro.build) (SSR) |
| **Hosting** | [Cloudflare Workers](https://workers.cloudflare.com) |
| **Styling** | [Tailwind CSS v4](https://tailwindcss.com), token-based design system |
| **Cache** | Cloudflare KV |
| **Database** | Cloudflare D1 — schema, migrations and repositories are written and tested; the binding is still commented out in `wrangler.jsonc` pending provisioning, so D1-backed routes return 503 rather than a fake empty feed |
| **AI** | Workers AI (`llama-3.1-8b-instruct-fp8`) for grounded fact-check reasoning |
| **News data** | [NewsData.io](https://newsdata.io) and [the Guardian](https://open-platform.theguardian.com), with an RSS fallback (The Hindu, Indian Express, NDTV, Mint) |
| **Fact-check sources** | [Google Fact Check Tools](https://toolbox.google.com/factcheck/apis) + [Tavily Search](https://tavily.com) |
| **Tests** | [Vitest](https://vitest.dev) — 1067 tests, including an automated WCAG contrast check and a drift test on the shipped security headers |

## Getting started

**Requirements:** Node ≥ 23.4 (`node:sqlite` is unflagged from 23.4, and the D1 schema tests run against it — on older Node those tests skip rather than fail, which is coverage you did not actually get). CI pins Node 24. A [Cloudflare account](https://dash.cloudflare.com/sign-up) is needed for deployment.

```bash
git clone https://github.com/Yrathore97/NewzWale.git
cd NewzWale
npm install
```

Copy the env template and add your API keys for local development:

```bash
cp .dev.vars.example .dev.vars
```

```dotenv
NEWSDATA_API_KEY=          # newsdata.io
GOOGLE_FACTCHECK_API_KEY=  # Google Fact Check Tools API
TAVILY_API_KEY=            # tavily.com
GUARDIAN_API_KEY=          # optional — open-platform.theguardian.com
```

Then:

```bash
npm run dev       # local dev server → localhost:4321
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start the local dev server |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Build, then run under `wrangler dev` (closer to production) |
| `npm test` | Run the Vitest suite |
| `npx astro check` | Type-check the whole project |
| `npm run deploy` | Build and deploy to Cloudflare Workers |

## Deployment

Deployed as a Cloudflare Worker via [`@astrojs/cloudflare`](https://docs.astro.build/en/guides/integrations-guide/cloudflare/). Bindings (KV cache, Workers AI, static assets) are declared in `wrangler.jsonc`; secrets are set with `wrangler secret put` and never committed. Security headers come from `src/middleware.ts` for SSR routes and `public/_headers` for prerendered ones — a test asserts the two stay identical.

CI (`.github/workflows/deploy.yml`) runs `npm audit --audit-level=high`, tests, type-checks and a full build on every push and PR to `main` — no bypassed gates. **Despite the filename it does not deploy**; deployment is the manual `npm run deploy`.

## Project structure

```
src/
├── components/    # Astro components, grouped: factcheck/ news/ shared/ shell/
├── layouts/       # Shared page shell
├── lib/
│   ├── db/        # D1 client, migrations, repositories
│   ├── factcheck/ # Evidence engine: claim → retrieval → gate → verdict
│   ├── news/      # Ingestion, canonicalisation, clustering, providers
│   ├── security/  # CSP and security-header construction
│   └── ...        # url, http, cache, ratelimit, saved, history
├── middleware.ts  # Applies security headers to every SSR response
├── pages/         # Routes; api/ (legacy) and api/v1/ (versioned envelope)
└── styles/        # Tailwind v4 design tokens (global.css)
public/
├── sw.js          # Service worker: allowlist cache policy + kill switch
└── _headers       # Security headers for prerendered routes
tests/             # Vitest suite, mirrors src/lib structure
docs/              # Full product & build documentation
```

## Documentation

- [`docs/WEBSITE-DOCUMENTATION.md`](docs/WEBSITE-DOCUMENTATION.md) — full product overview, architecture, and build narrative
- [`DESIGN.md`](DESIGN.md) — design system: tokens, color contract, dark mode, spacing
- [`PROGRESS.md`](PROGRESS.md) — living build log and current gotchas
- [`CLAUDE.md`](CLAUDE.md) — operating manual: protected paths, verification gates, scope and commit rules
- [`docs/NEWZWALE_IMPLEMENTATION_PLAN.md`](docs/NEWZWALE_IMPLEMENTATION_PLAN.md) — the phase plan (P0–P10)

## License

No license file yet — all rights reserved by default. Add one if you intend to open-source this.
