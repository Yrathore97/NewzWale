/** Centralised URL safety: scheme validation, href sanitisation, and host
 *  classification for SSRF defence.
 *
 *  ONE boundary, deliberately. Before this, scheme checks lived in
 *  news/feed.ts (`isSafeUrl`), host classification lived in
 *  factcheck/extract.ts (`isPrivateHost`), and the fact-check evidence list
 *  had no validation at all. Three copies of a security rule means two of them
 *  are out of date.
 *
 *  Threat model: every URL reaching these functions is attacker-influenced.
 *  A fact-check URL is submitted directly by the user; evidence URLs come from
 *  Tavily and Google Fact Check responses; article URLs come from news
 *  providers and RSS feeds. None of them are trusted. */

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

/** Schemes that may ever appear in an href or src we render. */
const RENDERABLE_SCHEMES = new Set(['http:', 'https:']);

/** Schemes that are actively dangerous in an href. Listed explicitly so the
 *  rejection is legible in a review, even though the allowlist above already
 *  covers it - an allowlist plus a named denylist survives a future edit that
 *  loosens the allowlist. */
const DANGEROUS_SCHEMES = new Set([
  'javascript:',
  'data:',
  'blob:',
  'file:',
  'filesystem:',
  'vbscript:',
  'about:',
]);

/** True when a value is an http(s) URL safe to place in href/src.
 *
 *  Replaces the copy in news/feed.ts. A `javascript:` URL assigned to
 *  `a.href` is script execution in the user's session; the fact-check evidence
 *  list assigned provider-supplied URLs to href with no check at all
 *  (NEWZWALE_SECURITY_AUDIT.md S-12). */
export function isSafeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const { protocol } = new URL(value);
    if (DANGEROUS_SCHEMES.has(protocol)) return false;
    return RENDERABLE_SCHEMES.has(protocol);
  } catch {
    return false;
  }
}

/** Returns a URL safe to render, or null.
 *
 *  Use at every render boundary rather than trusting an upstream filter.
 *  Returning null (not '' and not '#') forces the caller to decide what to do
 *  with an unrenderable link instead of silently emitting a dead one. */
export function safeHref(value: unknown): string | null {
  return isSafeUrl(value) ? new URL(value).toString() : null;
}

/** Canonical form for deduplication and for `articles.canonical_url`.
 *
 *  Strips the tracking parameters that defeat exact-URL dedup - the same story
 *  arrives from different providers with different utm tags and is currently
 *  counted as several distinct articles (NEWZWALE_AUDIT.md P-11).
 *
 *  Returns null for anything unsafe, so an unsafe URL can never become a
 *  database key. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^igshid$/i,
  /^mc_(cid|eid)$/i,
  /^ref$/i,
  /^ref_src$/i,
  /^source$/i,
  /^_ga$/i,
  /^yclid$/i,
];

export function canonicalizeUrl(value: unknown): string | null {
  if (!isSafeUrl(value)) return null;

  const url = new URL(value);

  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  // The fragment never identifies a different article.
  url.hash = '';
  // Default ports are noise.
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
    url.port = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) url.searchParams.delete(key);
  }
  // Stable ordering, so ?a=1&b=2 and ?b=2&a=1 are one article.
  url.searchParams.sort();

  // Trailing slash on a path is not a distinct resource. Root is left alone.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

// ---------------------------------------------------------------------------
// Host classification (SSRF)
// ---------------------------------------------------------------------------

/** Classifies a dotted-quad IPv4 as non-public.
 *
 *  Unknown or malformed input returns true (blocked). Refusing an ambiguous
 *  address is correct here: the cost of a false positive is one unfetchable
 *  source, the cost of a false negative is a request to internal
 *  infrastructure. */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;

  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (AWS/GCP/Azure metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 multicast
  if (a >= 240) return true; // 240.0.0.0/4 reserved, incl. 255.255.255.255

  // Documentation / benchmark ranges. Not routable, so a request to one is
  // either a mistake or a probe.
  // 192.0.0.0/24 (IETF protocol assignments, which includes Oracle Cloud's
  // metadata endpoint at 192.0.0.192) and 192.0.2.0/24 (TEST-NET-1) share the
  // same first two octets, so one branch covers both.
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113.0/24 TEST-NET-3

  // Cloud metadata endpoints outside the ranges above.
  if (a === 100 && b === 100) return true; // 100.100.100.200 Alibaba Cloud metadata

  return false;
}

/** Extracts an embedded IPv4 from an IPv4-mapped/compatible IPv6 address.
 *
 *  Two encodings must both be handled, and only the first was:
 *    ::ffff:127.0.0.1     dotted form
 *    ::ffff:7f00:1        hex form
 *
 *  This matters because WHATWG URL parsing NORMALISES the dotted form to the
 *  hex one: `new URL('http://[::ffff:169.254.169.254]/').hostname` is
 *  '[::ffff:a9fe:a9fe]'. A guard that only matched the dotted form therefore
 *  never saw the address it was written to block - the cloud metadata endpoint
 *  was reachable. Verified against the previous implementation. */
function embeddedIPv4(host: string): string | null {
  const dotted = host.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  const hex = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }

  return null;
}

/** True when a hostname points at a private, loopback, reserved or internal
 *  target and must not be fetched.
 *
 *  LIMITATION, stated plainly: this is a LITERAL check on the hostname. It
 *  cannot stop a public hostname whose DNS record resolves to a private
 *  address (DNS rebinding). Workers gives us no resolver API to check that
 *  from application code. The `global_fetch_strictly_public` compatibility
 *  flag in wrangler.jsonc is what covers rebinding, at the platform level;
 *  this function is defence in depth plus a legible error message.
 *
 *  Both layers are load-bearing. Do not remove the flag on the grounds that
 *  this function exists, and do not remove this function on the grounds that
 *  the flag exists. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');

  if (!host) return true;

  // Internal-by-convention names.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.endsWith('.home.arpa') || host.endsWith('.in-addr.arpa')) return true;
  // Cloud metadata hostnames.
  if (host === 'metadata.google.internal' || host === 'metadata') return true;

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // loopback, unspecified

    const mapped = embeddedIPv4(host);
    if (mapped) return isPrivateIPv4(mapped);

    if (/^f[cd]/.test(host)) return true; // fc00::/7 unique local (incl. AWS fd00:ec2::254)
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
    if (/^ff/.test(host)) return true; // ff00::/8 multicast
    return false;
  }

  // WHATWG URL already normalises decimal, octal and hex IPv4 forms
  // (http://2130706433/ becomes 127.0.0.1), so a dotted-quad test is
  // sufficient for addresses that arrived through `new URL()`. Verified.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return isPrivateIPv4(host);

  // A bare integer or hex literal that did NOT come through URL parsing.
  // Normalise and re-check rather than assuming the caller parsed it for us.
  if (/^(0x[0-9a-f]+|\d+)$/.test(host)) {
    const n = host.startsWith('0x') ? parseInt(host, 16) : Number(host);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return isPrivateIPv4(
        [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.'),
      );
    }
    return true; // unparseable numeric host: refuse
  }

  // Anything made only of digits and dots is an IP literal in some encoding,
  // not a DNS name - a TLD may not be all-numeric. If it did not match the
  // dotted-quad form above it is a partial or malformed address such as
  // "1.2.3" (which inet_aton reads as 1.2.0.3) or "1.2.3.999". Refuse rather
  // than fall through to the DNS-name branch and be treated as public.
  if (/^[\d.]+$/.test(host)) return true;

  return false;
}

/** Parses and validates a URL intended for server-side fetching.
 *
 *  Throws a controlled Error rather than returning null so a caller cannot
 *  forget to check. Messages are safe to show a user: they name the host the
 *  user supplied, never internal network detail. */
export function assertFetchableUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  if (!RENDERABLE_SCHEMES.has(url.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error(`Refusing to fetch a private or internal address (${url.hostname}).`);
  }
  return url;
}
