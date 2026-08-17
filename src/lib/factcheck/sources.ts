/** Source classification: tier, independence, and syndication.
 *
 *  TIER IS PROVENANCE, NEVER POLITICS. An outlet's editorial position is not
 *  evidence about a factual claim, and treating it as such produces two
 *  symmetric failures: dismissing accurate reporting from a disliked outlet,
 *  and laundering inaccurate reporting from a trusted one. There is no
 *  left/centre/right signal anywhere in this file and there must never be one.
 *
 *  Tier is also NOT stance. A Tier 1 source can contradict a claim; a Tier 3
 *  source can support it. The two are stored and reasoned about separately -
 *  see schema.ts. "Trusted source therefore true" is the exact failure this
 *  product exists to prevent. */

import type { SourceTier } from './schema';

export interface SourceProfile {
  domain: string;
  displayName: string;
  tier: SourceTier;
  /** Internal signals, not surfaced as a score. */
  ifcnSignatory?: boolean;
  lowReliability?: boolean;
  /** Outlets sharing an owner are not independent corroboration. */
  ownerGroup?: string;
  /** Wire agencies syndicate one story to many outlets. */
  isWireAgency?: boolean;
}

/** Domain suffixes that indicate an official or authoritative publisher.
 *
 *  Suffix-based rather than an exhaustive list: a government or court domain
 *  we have never seen before is still primary, and an allowlist that has to
 *  enumerate every ministry would be perpetually stale. */
const TIER1_SUFFIXES = [
  '.gov',
  '.gov.in',
  '.nic.in',
  '.gov.uk',
  '.europa.eu',
  '.who.int',
  '.un.org',
  '.edu',
  '.ac.in',
  '.ac.uk',
];

/** Explicit profiles. Deliberately small: this is a maintained list, is
 *  version-controlled, and its definitions are shown to readers. Anything
 *  absent falls back to tier 3 - the conservative default, since an unknown
 *  publisher cannot on its own establish a high-confidence verdict. */
const PROFILES: SourceProfile[] = [
  // Tier 1 — official bodies whose domain the suffix rule cannot reach.
  //
  // The Reserve Bank of India publishes on rbi.org.in, and `.org.in` is an
  // OPEN registration: any organisation can hold one. It therefore must never
  // become a TIER1_SUFFIX — that would hand tier 1, the strongest provenance
  // signal we have, to every NGO, campaign group and hobby site in the .in
  // space. A curated per-domain entry is the only safe way to reach it.
  //
  // Found in production: a check of "the RBI held the repo rate at 6.5 percent"
  // classified rbi.org.in as TIER 3, so the central bank counted as a
  // low-reliability source on its own policy rate — unable, by the tier floor
  // in gate.ts, to help establish a verdict about itself.
  { domain: 'rbi.org.in', displayName: 'Reserve Bank of India', tier: 'tier1' },

  // Tier 2 — established newsrooms with corrections policies.
  { domain: 'thehindu.com', displayName: 'The Hindu', tier: 'tier2', ownerGroup: 'kasturi' },
  { domain: 'indianexpress.com', displayName: 'The Indian Express', tier: 'tier2' },
  { domain: 'livemint.com', displayName: 'Mint', tier: 'tier2', ownerGroup: 'htmedia' },
  { domain: 'hindustantimes.com', displayName: 'Hindustan Times', tier: 'tier2', ownerGroup: 'htmedia' },
  { domain: 'ndtv.com', displayName: 'NDTV', tier: 'tier2' },
  { domain: 'thewire.in', displayName: 'The Wire', tier: 'tier2' },
  { domain: 'scroll.in', displayName: 'Scroll', tier: 'tier2' },
  { domain: 'theguardian.com', displayName: 'The Guardian', tier: 'tier2' },
  { domain: 'bbc.com', displayName: 'BBC', tier: 'tier2', ownerGroup: 'bbc' },
  { domain: 'bbc.co.uk', displayName: 'BBC', tier: 'tier2', ownerGroup: 'bbc' },

  // Wire agencies. Tier 2 in their own right, but flagged so that outlets
  // republishing them do not count as independent corroboration.
  { domain: 'reuters.com', displayName: 'Reuters', tier: 'tier2', isWireAgency: true },
  { domain: 'apnews.com', displayName: 'Associated Press', tier: 'tier2', isWireAgency: true },
  { domain: 'ptinews.com', displayName: 'Press Trust of India', tier: 'tier2', isWireAgency: true },
  { domain: 'aninews.in', displayName: 'ANI', tier: 'tier2', isWireAgency: true },

  // IFCN signatories — internal flag, tier is still provenance-based.
  { domain: 'altnews.in', displayName: 'Alt News', tier: 'tier2', ifcnSignatory: true },
  { domain: 'boomlive.in', displayName: 'BOOM', tier: 'tier2', ifcnSignatory: true },
  { domain: 'factcheck.org', displayName: 'FactCheck.org', tier: 'tier2', ifcnSignatory: true },
  { domain: 'politifact.com', displayName: 'PolitiFact', tier: 'tier2', ifcnSignatory: true },
  { domain: 'snopes.com', displayName: 'Snopes', tier: 'tier2', ifcnSignatory: true },
];

const BY_DOMAIN = new Map(PROFILES.map((p) => [p.domain, p]));

/** Normalises a URL or hostname to a registrable-ish domain.
 *
 *  Deterministic and total: unparseable input yields '', which callers treat
 *  as an unusable source rather than as a wildcard match. */
export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase();

  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return '';
    }
  }

  host = host.replace(/^www\./, '').replace(/\.$/, '');
  // Locale subdomains are the same publisher: hi.thehindu.com == thehindu.com.
  host = host.replace(/^(m|amp|www\d?|[a-z]{2}|[a-z]{2}-[a-z]{2})\./, (match) =>
    // Only strip when what remains still has at least two labels.
    host.slice(match.length).split('.').length >= 2 ? '' : match,
  );

  // Reject anything that is not a plausible hostname.
  //
  // Without this, a garbage string ("not a url", a sentence fragment from a
  // malformed API response) was returned verbatim and became a "domain".
  // Independence is counted on domains, so two different pieces of garbage
  // would have counted as two independent sources — manufacturing exactly the
  // corroboration the gate exists to require. Returning '' makes the source
  // unusable instead, which is the safe direction.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return '';
  }

  return host;
}

/** Looks up a source profile. Unknown domains fall back to tier 3. */
export function profileFor(domainOrUrl: string): SourceProfile {
  const domain = normalizeDomain(domainOrUrl);
  if (!domain) {
    return { domain: '', displayName: 'Unknown', tier: 'tier3' };
  }

  const known = BY_DOMAIN.get(domain);
  if (known) return known;

  if (TIER1_SUFFIXES.some((suffix) => domain === suffix.slice(1) || domain.endsWith(suffix))) {
    return { domain, displayName: domain, tier: 'tier1' };
  }

  return { domain, displayName: domain, tier: 'tier3' };
}

export function tierFor(domainOrUrl: string): SourceTier {
  return profileFor(domainOrUrl).tier;
}

/** The independence key for a source.
 *
 *  Two sources sharing a key are ONE independent source. Collapses, in order:
 *
 *    1. an explicit syndication group (same wire copy detected upstream)
 *    2. shared ownership (Mint and Hindustan Times are one owner)
 *    3. otherwise the domain itself
 *
 *  Without this, "two independent sources" is trivially satisfied by wire
 *  syndication - which is precisely how a single-sourced claim launders itself
 *  as corroborated across many mastheads. */
export function independenceKey(source: {
  domain: string;
  syndicationGroup?: string;
}): string {
  if (source.syndicationGroup) return `syn:${source.syndicationGroup}`;

  const domain = normalizeDomain(source.domain);
  const profile = BY_DOMAIN.get(domain);
  if (profile?.ownerGroup) return `own:${profile.ownerGroup}`;

  return `dom:${domain}`;
}

/** Counts genuinely independent sources. */
export function countIndependent(
  sources: { domain: string; syndicationGroup?: string }[],
): number {
  return new Set(sources.map(independenceKey)).size;
}

/** Detects wire syndication by near-identical passage text.
 *
 *  Three outlets running the same agency copy are not three sources. The
 *  comparison is deliberately crude - normalised token overlap over a high
 *  threshold - because the failure mode to avoid is treating genuinely
 *  independent reporting as syndicated, which would suppress real
 *  corroboration. Under-detecting costs a missed collapse; over-detecting
 *  costs a wrongly withheld verdict. */
export function detectSyndication(
  passages: { position: number; domain: string; text: string }[],
  threshold = 0.85,
): Map<number, string> {
  const groups = new Map<number, string>();
  const normalized = passages.map((p) => ({
    ...p,
    tokens: new Set(
      p.text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 3),
    ),
  }));

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i]!;
      const b = normalized[j]!;
      if (a.tokens.size === 0 || b.tokens.size === 0) continue;

      const shared = [...a.tokens].filter((t) => b.tokens.has(t)).length;
      const similarity = shared / Math.min(a.tokens.size, b.tokens.size);

      if (similarity >= threshold) {
        const group = groups.get(a.position) ?? `auto-${a.position}`;
        groups.set(a.position, group);
        groups.set(b.position, group);
      }
    }
  }

  return groups;
}
