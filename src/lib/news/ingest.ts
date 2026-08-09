/** News ingestion: providers in, durable D1 rows out.
 *
 *      providers ─► normalise ─► canonical id ─► sources ─► articles ─► clusters
 *
 *  D1 IS THE SYSTEM OF RECORD. KV stays a TTL cache of rendered feed pages and
 *  is not written here at all. Nothing in this module is the only copy of
 *  anything: every article it accepts is recoverable from D1 alone.
 *
 *  ── FAN-OUT, NOT FALLBACK ──────────────────────────────────────────────────
 *
 *  The read path (`fetchFromChain`) stops at the FIRST provider that answers —
 *  correct when serving one request, since a reader needs one page of news, not
 *  three. Ingestion is the opposite: every provider that can contribute
 *  coverage should, because breadth of independent sourcing is the entire point
 *  of the cluster counts. So providers run CONCURRENTLY and their failures are
 *  collected rather than propagated.
 *
 *  `fetchFromChain` is left untouched. Two call sites with genuinely different
 *  semantics are not one abstraction waiting to be merged.
 *
 *  ── PROVIDER ISOLATION ─────────────────────────────────────────────────────
 *
 *  One provider throwing must never abort the run. `Promise.allSettled` gives
 *  that at the fetch stage, and each article is persisted independently so a
 *  single malformed row cannot roll back its neighbours. Failures surface in
 *  the returned summary rather than as an exception, because a partial harvest
 *  is a normal outcome and a silent one is not. */

import { canonicalIdentity } from './canonical';
import { isSameStory, CLUSTER_WINDOW_MS } from './cluster';
import { PROVIDERS, type NewsProvider, type ProviderKeys, type ProviderRequest } from './providers';
import type { Article } from './types';
import { isValidCategory } from './categories';
import { isValidLanguage } from './languages';
import { contentId, nowIso, type Db } from '../db/client';
import {
  ArticleRepository,
  SourceRepository,
  StoryClusterRepository,
  type ArticleRecord,
} from '../db/repositories/articles';

export interface IngestSummary {
  /** Articles returned by providers, before any filtering. */
  fetched: number;
  /** New article rows written. */
  persisted: number;
  /** Articles already present, identified by canonical URL. */
  deduplicated: number;
  /** Articles attached to a story cluster (new or existing). */
  clustered: number;
  /** Distinct publishers written or refreshed. */
  sources: number;
  /** Dropped for an unsafe/unparseable URL or an empty title. */
  skippedInvalid: number;
  /** Articles STORED with `published_at = NULL` because the publication date
   *  could not be established.
   *
   *  These are persisted, not dropped — migration 0002 made the column
   *  nullable precisely so a missing metadata field stops costing us the
   *  article. The counter remains because the rate of undated articles is a
   *  feed-health signal worth watching: a provider that suddenly stops
   *  emitting dates should be visible, not silently absorbed. */
  undatedArticles: number;
  /** Provider ids that failed, with a short reason. Never carries an upstream
   *  URL, key or stack — this value is safe to log and to surface. */
  failedProviders: Array<{ providerId: string; reason: string }>;
}

function emptySummary(): IngestSummary {
  return {
    fetched: 0,
    persisted: 0,
    deduplicated: 0,
    clustered: 0,
    sources: 0,
    skippedInvalid: 0,
    undatedArticles: 0,
    failedProviders: [],
  };
}

/** Reduces an arbitrary thrown value to one short, safe sentence.
 *
 *  Provider errors can embed the request URL, which for NewsData and Guardian
 *  carries the API key as a query parameter. Echoing `err.message` into a
 *  summary that gets logged would leak it. Only the provider's own id and a
 *  truncated message survive. */
function safeReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'provider failed';
  return raw.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 120);
}

export interface ProviderHarvest {
  providerId: string;
  articles: Article[];
}

/** Runs every eligible provider concurrently, keeping partial results.
 *
 *  Eligibility reuses each provider's own `isConfigured`, so an unset key skips
 *  the provider instead of spending a request to fail. */
export async function harvest(
  req: ProviderRequest,
  keys: ProviderKeys,
  providers: NewsProvider[] = PROVIDERS,
): Promise<{ harvests: ProviderHarvest[]; failures: IngestSummary['failedProviders'] }> {
  const eligible = providers.filter((p) => p.isConfigured(keys));

  const settled = await Promise.allSettled(
    eligible.map(async (p) => ({ providerId: p.id, articles: (await p.fetchPage(req, keys)).articles })),
  );

  const harvests: ProviderHarvest[] = [];
  const failures: IngestSummary['failedProviders'] = [];

  settled.forEach((outcome, i) => {
    const providerId = eligible[i]!.id;
    if (outcome.status === 'fulfilled') harvests.push(outcome.value);
    else failures.push({ providerId, reason: safeReason(outcome.reason) });
  });

  return { harvests, failures };
}

/** Publication date as ISO-8601, or null when it genuinely cannot be read.
 *
 *  NEVER falls back to the ingestion time. `ingested_at` answers "when did we
 *  see this", `published_at` answers "when did the publisher publish it", and
 *  substituting one for the other invents a fact — the exact failure the
 *  evidence schema's separate published_at/accessed_at columns exist to
 *  prevent.
 *
 *  Since migration 0002 the column is NULLABLE, so a null here is STORED as
 *  null rather than costing us the article. Earlier the column was NOT NULL
 *  and such articles had to be dropped entirely; that trade is gone. */
export function publishedAtIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/** Normalises one provider article onto the durable row shape.
 *
 *  Returns `{ skip: 'invalid' }` only when the article cannot be identified at
 *  all — unsafe URL or empty title. An unknown publication date is NOT a skip:
 *  it is carried through as null. Nothing is invented to fill a gap. */
export async function normalize(
  article: Article,
  providerId: string,
  fallback: { category: string; language: string },
): Promise<{ record: ArticleRecord; domain: string } | { skip: 'invalid' }> {
  const title = article.title?.trim();
  if (!title) return { skip: 'invalid' };

  const identity = await canonicalIdentity(article.url, title);
  if (!identity) return { skip: 'invalid' };

  const publishedAt = publishedAtIso(article.publishedAt);

  // OUR category slug, never the provider's raw value — the audit's P-17: a
  // card in the Sports rail showing an upstream badge that says something else.
  const category = isValidCategory(article.category) ? article.category : fallback.category;
  const language = isValidLanguage(fallback.language) ? fallback.language : 'en';

  return {
    record: {
      id: identity.id,
      slug: identity.slug,
      canonicalUrl: identity.canonicalUrl,
      originalUrl: identity.originalUrl,
      title,
      summary: article.summary?.trim() || null,
      imageUrl: article.imageUrl || null,
      sourceId: identity.sourceId,
      // The publisher as the provider named it, falling back to the domain.
      // Denormalised so a card still renders if the sources row is removed.
      publisherName: article.source?.trim() || identity.domain,
      category,
      language,
      publishedAt,
      providerId,
    },
    domain: identity.domain,
  };
}

/** Finds or creates the cluster for a freshly persisted article.
 *
 *  Compares only against clusters in the same category and language inside the
 *  time window; `isSameStory` then applies the similarity floor and the
 *  shared-token minimum. No match means a NEW cluster, which is the safe
 *  direction — an unmerged story is a missing "also reported by", a wrongly
 *  merged one is a false claim of corroboration.
 *
 *  The new cluster's id is derived from the article that opened it, so a rerun
 *  over the same data reaches the same id instead of minting a second cluster. */
async function assignToCluster(
  clusters: StoryClusterRepository,
  articles: ArticleRepository,
  record: ArticleRecord,
): Promise<void> {
  // An undated article yields NaN, and `isSameStory` refuses any comparison
  // involving NaN — so it opens its own cluster rather than being merged on
  // title alone. Correct: the time window is half the evidence that two
  // reports describe one event, and without a date we do not have it.
  const publishedMs = record.publishedAt ? Date.parse(record.publishedAt) : Number.NaN;
  const since = new Date(
    (Number.isNaN(publishedMs) ? Date.now() : publishedMs) - CLUSTER_WINDOW_MS,
  ).toISOString();

  const candidates = await clusters.findCandidates(record.category, record.language, since);

  const match = candidates.find((c) =>
    isSameStory(record.title, c.headline, publishedMs, Date.parse(c.lastSeenAt)),
  );

  const clusterId = match?.id ?? (await contentId(`cluster:${record.id}`));

  if (!match) {
    await clusters.upsert({
      id: clusterId,
      representativeArticleId: record.id,
      headline: record.title,
      category: record.category,
      language: record.language,
      articleCount: 1,
      sourceCount: 1,
      // Ranking is Phase 5D's job and needs a documented formula. Left at the
      // schema default rather than filled with a number nobody can explain.
      trendingScore: 0,
      // first_seen_at/last_seen_at are NOT NULL and mean "when did WE see this
      // story" — an ingestion concept, not a publication date. Falling back to
      // now for an undated article is therefore accurate rather than invented;
      // the article's own published_at stays null.
      firstSeenAt: record.publishedAt ?? nowIso(),
      lastSeenAt: record.publishedAt ?? nowIso(),
    });
  }

  await articles.assignCluster(record.id, clusterId);
  // Counts are derived from the rows, after the membership change.
  await clusters.recomputeStats(clusterId);
}

export interface IngestOptions {
  category?: string;
  language?: string;
  providers?: NewsProvider[];
}

/** One ingestion run. Returns a summary; throws only if the database is absent.
 *
 *  IDEMPOTENT. Article identity is sha256(canonical_url), and the insert is
 *  `INSERT OR IGNORE` on a UNIQUE canonical_url, so a rerun over identical
 *  provider output writes nothing new: counts land in `deduplicated`, and
 *  because clustering runs only for genuinely new rows, no second cluster
 *  appears either. */
export async function ingest(
  db: Db | undefined,
  keys: ProviderKeys,
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const summary = emptySummary();
  if (!db) throw new Error('Ingestion requires a database binding.');

  const category = isValidCategory(options.category) ? options.category : 'top';
  const language = isValidLanguage(options.language) ? options.language : 'en';

  const { harvests, failures } = await harvest(
    { category, language },
    keys,
    options.providers ?? PROVIDERS,
  );
  summary.failedProviders = failures;

  const sources = new SourceRepository(db);
  const articles = new ArticleRepository(db);
  const clusters = new StoryClusterRepository(db);

  const seenDomains = new Set<string>();

  for (const { providerId, articles: fetched } of harvests) {
    summary.fetched += fetched.length;

    for (const article of fetched) {
      const normalized = await normalize(article, providerId, { category, language });

      if ('skip' in normalized) {
        summary.skippedInvalid += 1;
        continue;
      }

      const { record, domain } = normalized;
      if (record.publishedAt === null) summary.undatedArticles += 1;

      // Persist each article independently. One bad row must not discard the
      // rest of a provider's harvest.
      try {
        if (!seenDomains.has(domain)) {
          // ensureExists, NOT upsert: ingestion registers a publisher the first
          // time it appears and must never rewrite an existing row. Tier and
          // owner_group are curated values the fact-check engine depends on,
          // and this code has no idea what they should be — it could only
          // supply the tier3 default, overwriting curation on every run. See
          // the method's own note.
          await sources.ensureExists({
            id: record.sourceId!,
            domain,
            displayName: record.publisherName,
            // The conservative default: tier3 may add context but can never on
            // its own establish a high-confidence verdict. Promoting a
            // publisher is a curation decision backed by evidence, not a side
            // effect of having ingested an article from them.
            tier: 'tier3',
          });
          seenDomains.add(domain);
          summary.sources += 1;
        }

        const before = await articles.findByCanonicalUrl(record.canonicalUrl);
        if (before) {
          summary.deduplicated += 1;
          continue;
        }

        await articles.insertIfNew(record);
        summary.persisted += 1;

        await assignToCluster(clusters, articles, record);
        summary.clustered += 1;
      } catch (err) {
        // Counted as invalid rather than thrown: a run that harvested 200
        // articles should not be lost because one violated a constraint.
        console.error(`Ingestion failed for ${record.canonicalUrl}:`, err);
        summary.skippedInvalid += 1;
      }
    }
  }

  return summary;
}
