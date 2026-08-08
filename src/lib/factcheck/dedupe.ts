/** Evidence deduplication, before anything is counted.
 *
 *  Corroboration is counted over evidence items, so a duplicate is not a
 *  harmless inefficiency — it is a fabricated second source. Two results for
 *  the same article, or one article syndicated to three mastheads, would
 *  satisfy the two-independent-source floor while proving exactly as much as
 *  one source did.
 *
 *  Three passes, cheapest first:
 *    1. canonical URL      — the same page reached by different URLs
 *    2. domain + slug      — the same article under a different query string
 *    3. content similarity — the same wire copy under different mastheads
 *
 *  Pass 3 is the only fuzzy one and is deliberately conservative: merging two
 *  genuinely independent reports would SUPPRESS real corroboration, which is
 *  the more damaging error. */

import { canonicalizeUrl } from '../url';
import { normalizeDomain } from './sources';
import type { EvidenceItem } from './signals';

export interface DedupeResult {
  kept: EvidenceItem[];
  /** position -> the position it duplicated, for auditability. */
  removed: Map<number, number>;
  /** Groups of positions found to be the same content. */
  syndicationGroups: Map<number, string>;
}

/** Article identity within a domain: the path, minus query and extension.
 *
 *  Two URLs differing only by tracking parameters or an AMP suffix are one
 *  article. */
function articleKey(url: string): string | null {
  const canonical = canonicalizeUrl(url);
  if (!canonical) return null;
  try {
    const u = new URL(canonical);
    const path = u.pathname
      .replace(/\/amp\/?$/i, '')
      .replace(/\.(html?|amp|php)$/i, '')
      .replace(/\/+$/, '');
    return `${normalizeDomain(u.hostname)}${path}`;
  } catch {
    return null;
  }
}

/** Jaccard similarity over content words. */
function similarity(a: string, b: string): number {
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 3),
    );

  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / Math.min(ta.size, tb.size);
}

/** Similarity above which two passages are the same underlying copy.
 *
 *  High on purpose. Two independent reports of the same event share names,
 *  places and figures and can reach 0.6 legitimately; only near-identical
 *  wording indicates one wire story wearing two mastheads. */
const SYNDICATION_THRESHOLD = 0.82;

export function dedupeEvidence(items: EvidenceItem[]): DedupeResult {
  const kept: EvidenceItem[] = [];
  const removed = new Map<number, number>();
  const syndicationGroups = new Map<number, string>();

  const byCanonical = new Map<string, EvidenceItem>();
  const byArticle = new Map<string, EvidenceItem>();

  for (const item of items) {
    // ── Pass 1: identical canonical URL. ────────────────────────────────
    const canonical = canonicalizeUrl(item.url);
    if (canonical && byCanonical.has(canonical)) {
      removed.set(item.position, byCanonical.get(canonical)!.position);
      continue;
    }

    // ── Pass 2: same article under a different URL shape. ───────────────
    const key = articleKey(item.url);
    if (key && byArticle.has(key)) {
      removed.set(item.position, byArticle.get(key)!.position);
      continue;
    }

    if (canonical) byCanonical.set(canonical, item);
    if (key) byArticle.set(key, item);
    kept.push(item);
  }

  // ── Pass 3: same content across different domains = syndication. ──────
  // These are NOT removed — a reader should see that three outlets carried
  // the story — but they are grouped so independence counting collapses them
  // to one. Removing them would hide the syndication rather than neutralise it.
  for (let i = 0; i < kept.length; i += 1) {
    for (let j = i + 1; j < kept.length; j += 1) {
      const a = kept[i]!;
      const b = kept[j]!;
      if (!a.quotedPassage || !b.quotedPassage) continue;
      if (a.domain && a.domain === b.domain) continue;

      if (similarity(a.quotedPassage, b.quotedPassage) >= SYNDICATION_THRESHOLD) {
        const group = syndicationGroups.get(a.position) ?? `syn-${a.position}`;
        syndicationGroups.set(a.position, group);
        syndicationGroups.set(b.position, group);
      }
    }
  }

  for (const item of kept) {
    const group = syndicationGroups.get(item.position);
    // Never overwrite a group the provider already declared.
    if (group && !item.syndicationGroup) item.syndicationGroup = group;
  }

  return { kept, removed, syndicationGroups };
}
