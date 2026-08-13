import { safeFetchText, SafeFetchError } from '../http';

const MAX_CHARS = 4000;

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
};

export function extractReadableText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

/** Host classification moved to ../url.ts, where it sits beside the scheme and
 *  href rules as one security boundary instead of three scattered copies.
 *
 *  Re-exported here because it is part of this module's established public
 *  API and is covered by tests/factcheck/extract.test.ts. The implementation
 *  moved and was hardened (IPv4-mapped IPv6 in hex form, multicast, reserved,
 *  CGNAT and cloud-metadata ranges); the contract did not change. */
export { isPrivateHost } from '../url';

export interface ArticleFetchResult {
  text: string;
  /** The raw response body, still bounded by safeFetchText's byte cap.
   *
   *  Needed because publication dates live in markup (JSON-LD, meta tags,
   *  <time>) that tag-stripping destroys, and because passage selection works
   *  on block structure. Handing only stripped text downstream made both
   *  impossible — the date was gone before anything could look for it. */
  html: string;
  /** After redirects. Differs from the requested URL when the page moved. */
  finalUrl: string;
  /** True when the byte cap cut the body short. Recorded so evidence can say
   *  the source was only partially read rather than implying a full read. */
  truncated: boolean;
}

/** Fetches a page and reduces it to readable text.
 *
 *  All transport security - scheme allowlist, SSRF host checks on every
 *  redirect hop, timeout, byte cap, content-type validation - lives in
 *  `safeFetchText`. This function is only the HTML-to-text step. */
export async function fetchArticle(url: string): Promise<ArticleFetchResult> {
  const res = await safeFetchText(url);
  return {
    text: extractReadableText(res.text),
    html: res.text,
    finalUrl: res.finalUrl,
    truncated: res.truncated,
  };
}

/** Text-only form, kept because it is the existing call shape used by
 *  /api/factcheck and covered by existing tests.
 *
 *  SafeFetchError messages are already safe to surface: they name the host the
 *  caller supplied and carry no internal network detail. */
export async function fetchArticleText(url: string): Promise<string> {
  try {
    const { text } = await fetchArticle(url);
    return text;
  } catch (err) {
    if (err instanceof SafeFetchError) throw new Error(err.message);
    throw err;
  }
}
