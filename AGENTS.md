**Read [`CLAUDE.md`](CLAUDE.md) first.** It is the operating manual for this
repository: project identity, protected paths, security rules, verification
gates, phase discipline, scope control and commit rules. This file only covers
day-to-day mechanics that sit outside it.

**Then read [`PROGRESS.md`](PROGRESS.md).** It tracks what is done, what is
next, and the gotchas discovered along the way, so work hands off cleanly
between sessions and between different models/agents. Update it when you finish
a task or stop mid-task — see the "Handoff protocol" at its end.

The phase plan is [`docs/NEWZWALE_IMPLEMENTATION_PLAN.md`](docs/NEWZWALE_IMPLEMENTATION_PLAN.md).
The design system is [`DESIGN.md`](DESIGN.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Astro dev server on `localhost:4321` |
| `npm run preview` | `npm run build` then `wrangler dev` on `localhost:8787` — closer to production, and the only way to exercise the service worker, `public/_headers` and the Workers Assets binding |
| `npm run build` | Production build to `dist/` |
| `npm test` | Vitest, whole suite |
| `npx astro check` | Type-check; must stay at 0 errors / 0 warnings / 0 hints |
| `npm run deploy` | `npm run build` then `wrangler deploy` — needs Cloudflare credentials |

The verification gate before any commit is `npm test`, `npx astro check` and
`npm run build`, plus the protected-path and test-integrity checks in
`CLAUDE.md` §9. Do not commit without explicit authorization.

Note: prefer `npm run preview` over `npm run dev` when the change touches the
service worker, security headers, prerendered routes or anything served by the
assets binding — `astro dev` does not apply `public/_headers` and serves
prerendered pages differently.

On Windows, stop a running `wrangler dev` before `npm run build`: the running
server holds a handle on `dist/client` and the build fails with `EPERM`.

## Skills

Use the `astro`, `tailwind-4-docs` and `web-design-guidelines` skills for
framework, Tailwind v4 and UI-review questions respectively.

## Astro documentation

Full documentation: https://docs.astro.build

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
- [Cloudflare adapter](https://docs.astro.build/en/guides/integrations-guide/cloudflare/)
