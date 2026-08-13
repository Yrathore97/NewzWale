# NewzWale — Product Specification

**Date:** 2026-08-08
**Status:** Proposal. Awaiting approval.
**Positioning:** *Know What's True. Not Just What's Trending.*

---

## 1. What NewzWale is

Two experiences, one promise.

**NEWS** — concise, modern, scannable Indian news. Headlines from real
publishers, always attributed, always linking back. Fast to skim, honest about
what it is: a guide to the news, not a replacement for the newsroom.

**FACT CHECK** — the differentiator. Paste a claim, a headline, or a URL and
get an *explainable* verdict: what the evidence says, what contradicts it, how
strong that evidence is, when it was published, who published it, and what the
check could **not** establish.

The tagline sets the hierarchy. Trending gets you in; true keeps you. **Fact
Check is the product; News is the surface that makes it habitual.**

### Design inspiration, not imitation

Short-form news apps solved a real problem: dense information, low friction,
high scan rate. We take the *philosophy* — tight headlines, one card one story,
consistent metadata position, thumb-reachable navigation, ruthless information
density.

We do not take their layout, their card geometry, their colour language, their
copy, their interaction signatures, or their brand feel. NewzWale's visual
identity is the warm-neutral editorial system already documented in
[`DESIGN.md`](../DESIGN.md) — coral on warm neutrals, Inter with mono captions,
8-point spacing, photography-forward. That system stays; the compositions
around it change.

Concretely, "inspired by, not copied from" means we borrow: typographic scale
relationships, spacing rhythm, responsive breakpoint behaviour, modular card
architecture, visual hierarchy technique, and interaction patterns
(swipe/scroll/tap affordances). We do not borrow: specific layouts, colour
palettes, iconography, illustration style, motion signatures, or copy.

---

## 2. Who it is for

| Reader | Need | What they use |
|---|---|---|
| **The forward-checker** | "My uncle sent this on WhatsApp. Is it real?" | Fact Check, from a cold start, on a phone, in under 30 seconds |
| **The daily skimmer** | "What happened today?" | News feed, categories, trending |
| **The careful reader** | "Who else reported this?" | Story pages, coverage clusters, source quality |
| **The returner** | "What did I check last week?" | History, saved |

The forward-checker is the priority. They arrive with no context, on mobile,
often from a share link, and they will judge the entire product on one
interaction.

---

## 3. Product areas

Matching the six named areas.

| Area | Status | Target |
|---|---|---|
| **NEWS** | Exists | Feed, categories, story pages, coverage clusters, reading time |
| **FACT CHECK** | Exists, thin | Full evidence model, 6 verdicts, permalinks, related claims |
| **SEARCH** | ❌ Fake — filters loaded DOM cards | Real full-text search over articles **and** past fact-checks |
| **HISTORY** | ❌ None | Your past checks, filterable by verdict, device-local |
| **SAVED** | Partial — a drawer, `localStorage` | A real page, offline-readable |
| **USER** | ❌ None | Preferences (topics, language, theme) + history + saved. No account required |

---

## 4. Information architecture — NEWS

### 4.1 Required elements per the brief

| Element | Today | Target |
|---|---|---|
| Concise headline | ✅ Publisher's headline | ✅ Unchanged — never rewritten |
| Short summary | ⚠️ Publisher's description verbatim, sometimes 300 chars of RSS | ✅ Publisher's own, quoted, capped; generated summaries only if approved (see §4.3) |
| Source | ✅ `source_id` | ✅ Publisher display name + quality chip |
| Timestamp | ✅ Relative ("2h ago") | ✅ Relative + absolute on hover/long-press |
| Category | ⚠️ Upstream's value, not ours — badge can disagree with the rail | ✅ Our slug (fixes audit P-17) |
| Reading time | ❌ | ✅ Estimated from the publisher's own length signal, labelled "est." |
| Multiple-source coverage | ❌ Impossible — URL-exact dedup only | ✅ "Also reported by N sources" via story clusters |
| "Fact Check Available" | ❌ | ✅ Badge when a claim from this story has been checked; links to the result |

### 4.2 Card anatomy

One card, one story. Fixed metadata positions so the eye learns them once.

```
┌──────────────────────────────────────────────┐
│ [image, 16:9, lazy]              [Save ♡]    │
│                                              │
│ ● BUSINESS · The Hindu · 2h ago       ← meta │
│                                              │
│ Headline, up to 3 lines, tight leading       │  ← the only large type
│                                              │
│ Publisher's own summary, 2 lines clamped.    │
│                                              │
│ ─────────────────────────────────────────    │
│ 3 min read · Also in 4 sources    [✓ Checked]│  ← value row
└──────────────────────────────────────────────┘
```

The "value row" is what distinguishes this from a generic aggregator card:
coverage breadth and fact-check availability are the two things no other feed
shows.

**Honesty rules for the card:**
- "Also in N sources" is never shown unless N ≥ 2 and clustering actually
  matched them.
- "Fact Check Available" links to a *real* result; it is never a prompt to run
  one.
- Reading time is labelled as an estimate.
- The category badge shows our category, and matches the rail it sits in.

### 4.3 Summaries — source-grounded generation is permitted

**Settled by the master brief (Part 2), reversing this document's earlier
recommendation against generated summaries.**

AI summaries are allowed **only when source-grounded**. A source-grounded
summary must:

1. Use retrieved source content — never model recall
2. Not invent facts
3. **Preserve important qualifiers** ("alleged", "reportedly", "according to")
4. **Preserve uncertainty** — a hedged claim must not become a flat assertion
5. Not change the meaning of the source
6. Identify the source
7. Link to the original

**If a safe summary cannot be generated, fall back to source metadata or the
headline.** Silent degradation to a lower-fidelity summary is not permitted;
falling back is.

This is compatible with principle 2 ("never invent sources") because the
summary is not a source — it is a restatement of one, attributed and linked.
The risk moves from policy to verification, so it carries a test obligation:

| Test | Assertion |
|---|---|
| Qualifier preservation | A source saying "police *allege*" never yields a summary saying "police found" |
| Uncertainty preservation | "may have", "is expected to", "unconfirmed reports" survive into the summary |
| Number fidelity | Every figure in the summary appears in the source |
| Entity fidelity | No person, place, or organisation appears that is absent from the source |
| Fallback | When grounding checks fail, the headline/metadata path is taken and the card renders correctly |

Ordering: extractive-first (the publisher's own sentences, verbatim) is tried
before abstractive generation, because it is grounded by construction and
costs no model call. Abstractive only where extraction produces something
unreadable.

**Not permitted:** rewriting a headline. Headlines stay the publisher's.

### 4.4 Trending

Ranked by a transparent formula, not a black box:

```
score = recency_decay(last_seen_at)
      × log(1 + source_count)      -- breadth of coverage, not volume
      × velocity(articles per hour in this cluster)
```

Deliberately **not** included: click counts (we have none), social signals (we
have none), or editorial promotion. And the page must say what the ranking
means — a one-line "Ranked by how many independent outlets are covering it, and
how fast" is the honest version.

This also fixes audit P-10: today's "Most Read" is `top.slice(0, 5)` — the
newest five, not the most-read. Either it becomes real or it gets renamed.
It cannot stay as-is on a product built on honesty.

### 4.5 Search

Full-text over both corpora, because the reader's question is often "has this
been checked?" not "what's the news?".

- One input, results grouped: **Fact Checks** first, then **News**.
- Filters: verdict, category, language, date range.
- Empty state names what was searched and offers "Check this as a claim →",
  turning a failed search into the product's core action.

### 4.6 Categories — expansion required

Brief Part 2 names 11 categories. Current code has 8
([`categories.ts:15`](../src/lib/news/categories.ts)).

| Target | Current | Action |
|---|---|---|
| India | `india` → upstream `politics` | **Split.** India and Politics are different things; the current mapping conflates them |
| World | `world` | ✅ |
| Politics | — (absorbed into `india`) | **Add** as its own slug |
| Business | `business` | ✅ |
| Technology | `technology` | ✅ |
| Science | — | **Add** — verify provider coverage first |
| Health | `health` | ✅ |
| Sports | `sports` | ✅ |
| Entertainment | `entertainment` | ✅ |
| Lifestyle | — | **Add** — verify provider coverage first |
| Regional | — | **Defer** (D13) — needs a provider that carries state-level feeds |

Binding rule, already a documented repo convention: *a category that returns
nothing must be removed rather than left in to disappoint*
([`languages.ts:5-7`](../src/lib/news/languages.ts)). **Every new category is
verified against real provider output before it ships.** `top` is retained as
the default landing feed.

The `india` split is the one with a real risk: `politics` is currently
confirmed to return distinct national-politics stories, so re-pointing `india`
elsewhere needs its own verification pass, not an assumption.

### 4.7 Languages

13 content languages exist and are verified working (`PROGRESS.md`). Rules
carried forward:
- Content language changes headlines only; UI chrome stays English **by
  design**, and the control says so.
- **New requirement:** `<html lang>` must reflect the content language, and
  `dir="rtl"` for Urdu. Today it is hardcoded `en` (audit A-01/P-09) — a real
  accessibility and SEO defect.

---

## 5. Information architecture — FACT CHECK

The full model is specified in
[`NEWZWALE_FACTCHECK_SPEC.md`](NEWZWALE_FACTCHECK_SPEC.md). Product-level
requirements:

### 5.1 Required elements

| Element | Today | Target |
|---|---|---|
| Claim | ⚠️ Raw input; a URL check submits 4,000 chars of body as "the claim" | ✅ Extracted, single, checkable statement, shown back for confirmation |
| Verdict | ⚠️ 4 values | ✅ 6 values |
| Evidence strength | ❌ | ✅ Strong / Moderate / Weak / None — derived from the evidence set |
| Summary | ⚠️ 2 model sentences | ✅ One-line answer |
| Why this verdict | ❌ | ✅ Explicit reasoning referencing numbered evidence |
| Supporting evidence | ⚠️ Undifferentiated list | ✅ Own section |
| Contradicting evidence | ❌ | ✅ Own section — **always shown, even when it weakens the verdict** |
| Contextual evidence | ❌ | ✅ Own section |
| Source quality | ❌ | ✅ Provenance tier per source |
| Publication date | ❌ **Principle 7 violation** | ✅ Per evidence item; "date unknown" when genuinely unknown |
| Source URL | ✅ | ✅ Retained, scheme-validated |
| Limitations | ❌ | ✅ What could not be established, always present |
| Related claims | ❌ | ✅ Similar past checks |

### 5.2 The result page

The verdict badge is the smallest part of the page. This is the discipline that
makes "evidence before confidence" real:

```
CLAIM  (as extracted, quoted)
──────────────────────────────────────────
[VERDICT BADGE]   Evidence: ●●●○ Moderate
One-line answer.

WHY THIS VERDICT
Reasoning referencing [1] [3].

SUPPORTING EVIDENCE (2)
  [1] Publisher · Established news · 4 Aug 2026 · read in full
      "the exact quoted passage relied on"                    ↗
CONTRADICTING EVIDENCE (1)
  [3] Publisher · Primary source · 2 Aug 2026 · snippet only
      "the exact quoted passage"                              ↗
CONTEXT (1)

LIMITATIONS
  · Only 2 independent domains were found.
  · One source's publication date could not be determined.

RELATED CLAIMS
HOW WE CHECKED THIS  →  methodology
```

### 5.3 Rules the product must never break

1. A verdict is **never** shown without its evidence on the same screen.
2. Contradicting evidence is **never** hidden, collapsed by default, or
   de-emphasised — even when it undermines the verdict.
3. `UNVERIFIED` is a **legitimate, well-designed result**, not an error state.
   It is styled as a real answer, because "we don't know" is the honest answer
   more often than any other.
4. Evidence strength and verdict are **independent** and both always shown. A
   `TRUE` backed by weak evidence must look different from a `TRUE` backed by
   strong evidence.
5. Source quality is **provenance-based only** — never political lean. See §6.
6. Every evidence item shows whether it was **read in full or only as a search
   snippet**. Today the pipeline silently falls back to snippets
   (`factcheck.ts:191-197`) and never tells the reader.
7. No confidence percentage. A number implies a precision this pipeline does
   not have. Four named strength levels, defined in writing.

### 5.4 Sharing

Every completed check gets a permanent, shareable URL: `/fact-check/[id]`,
where `id` is a hash of the normalised claim. Sharing a *result* rather than a
*screenshot* is the mechanism by which the product spreads through the same
WhatsApp channels the misinformation travels on.

Requires: Open Graph image per verdict, a title carrying the verdict, and a
description carrying the one-line answer.

---

## 6. Explicitly out of scope: political lean scoring

Left/Center/Right percentages **must not** be used as a primary determinant of
truth, and are not part of the source quality model.

Reasoning: an outlet's editorial position is not evidence about a factual
claim. Treating it as such produces two failures — dismissing accurate
reporting from an outlet the reader dislikes, and laundering inaccurate
reporting from one they trust. It also makes the verdict about identity rather
than evidence, which is the failure mode the product exists to correct.

What is used instead — provenance and track record:

| Tier | Meaning |
|---|---|
| `primary` | Government records, court filings, official statistics, the organisation's own release |
| `ifcn_factchecker` | IFCN signatory publishing a review with a stated methodology |
| `established_news` | Established newsroom with a corrections policy and named bylines |
| `other` | Everything else that is legible |
| `low_reliability` | Documented history of fabrication |

Tiers are **displayed to the reader with their definition available**, not
applied invisibly. A reader disagreeing with a tier can see exactly what it
claims and judge the source themselves.

---

## 7. Success criteria

| Dimension | Criterion |
|---|---|
| Correctness | On a fixed golden set of claims with known answers, no verdict is *confidently wrong*. `UNVERIFIED` is an acceptable outcome; a wrong `TRUE`/`FALSE` is not |
| Explainability | Every verdict page shows claim, evidence both ways, dates, source tiers, and limitations |
| Honesty | No element on any page asserts something the system did not actually do (this currently fails: "Most Read", the hero "Search") |
| Speed | Fact check p50 under 6 s, p95 under 12 s; news feed TTFB under 400 ms once served from D1 |
| Accessibility | WCAG 2.2 AA. Contrast asserted in CI (already true); keyboard operability for every interactive pattern (currently incomplete) |
| Mobile | Every primary action reachable one-thumbed; chrome under 100 px; no horizontal scroll at 320 px |
| Security | Zero High findings open; the three current Highs closed |

---

## 8. Non-goals

- Hosting or rewriting publisher article bodies (unless AD-09 is overridden).
- User accounts, at least initially.
- Comments, social features, or user-generated content.
- Real-time push notifications in v1.
- UI translation into 13 languages (content translation only, as today).
- Political lean scoring, as above.
- Any claim to be a certified fact-checker. We aggregate certified reviews and
  perform grounded assessment; the distinction is surfaced through `basis` and
  must stay surfaced.
