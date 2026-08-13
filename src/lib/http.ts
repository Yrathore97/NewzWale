/** The single boundary for fetching untrusted remote URLs.
 *
 *  EVERY server-side fetch of an attacker-influenced URL goes through
 *  `safeFetchText`. Nothing else in the codebase should call `fetch()` on a
 *  URL that originated outside our own configuration.
 *
 *  What it defends against, and why each one is here:
 *
 *  SSRF — the URL comes from the user (the fact-check URL tab) or from a
 *    search provider whose ranking an attacker can influence. Without host
 *    validation the Worker becomes a request generator aimed at internal
 *    infrastructure. Validated on the initial URL AND on every redirect hop,
 *    because validating only the first is equivalent to not validating at all:
 *    a public URL can 302 straight to 169.254.169.254.
 *
 *  RESOURCE EXHAUSTION — the previous implementation did `await res.text()`
 *    with no timeout and no size cap, buffering the entire response into a
 *    128 MB Worker before truncating it to 4,000 characters. A large or
 *    slow-drip response was a cheap denial of service, and stage 2 issues
 *    three of these concurrently (NEWZWALE_SECURITY_AUDIT.md S-04).
 *
 *  CONTENT CONFUSION — a URL returning a PDF or a binary was regex-stripped
 *    into nonsense and fed to the model as "evidence" (S-05).
 *
 *  Errors are deliberately controlled. A caller may show `err.message` to a
 *  user: it names the host they supplied and never leaks internal network
 *  detail, upstream URLs, or credentials. */

import { assertFetchableUrl, isPrivateHost } from './url';

export interface SafeFetchOptions {
  /** Wall-clock budget for the whole request, including redirects. */
  timeoutMs?: number;
  /** Hard cap on bytes read into memory. Enforced while streaming, not just
   *  against the content-length header. */
  maxBytes?: number;
  /** Maximum redirect hops to follow. */
  maxRedirects?: number;
  /** Content types treated as readable article text. */
  allowedContentTypes?: RegExp;
  userAgent?: string;
}

export const FETCH_DEFAULTS = {
  timeoutMs: 5_000,
  maxBytes: 512 * 1024, // 512 KB — generous for an article, far below a Worker's memory
  maxRedirects: 3,
  allowedContentTypes: /^(text\/html|text\/plain|application\/xhtml\+xml|application\/xml|text\/xml)\b/i,
  userAgent: 'NewzWale-FactCheck/1.0 (+https://www.newzwale.com)',
} as const;

/** Thrown for every controlled failure. `reason` lets callers branch (e.g.
 *  record why a source could not be read) without parsing English. */
export type FetchFailureReason =
  | 'invalid_url'
  | 'blocked_host'
  | 'too_many_redirects'
  | 'bad_redirect'
  | 'http_error'
  | 'unsupported_content_type'
  | 'too_large'
  | 'timeout'
  | 'network';

export class SafeFetchError extends Error {
  readonly reason: FetchFailureReason;
  constructor(reason: FetchFailureReason, message: string) {
    super(message);
    this.name = 'SafeFetchError';
    this.reason = reason;
  }
}

export interface SafeFetchResult {
  /** Decoded body, already truncated to maxBytes worth of octets. */
  text: string;
  /** The URL actually read, after redirects. Not necessarily the input. */
  finalUrl: string;
  contentType: string;
  /** True when the body hit the byte cap and was cut short. */
  truncated: boolean;
  redirectCount: number;
}

/** Reads the body with a hard byte ceiling, aborting rather than buffering.
 *
 *  content-length is only a hint: it can be absent under chunked encoding and
 *  it can simply lie. Checking it alone leaves the cap trivially bypassable,
 *  so the stream is measured as it arrives and cancelled the moment it exceeds
 *  the budget. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: '', truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (total + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Release the connection whether we finished or bailed out early.
    await reader.cancel().catch(() => {});
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // fatal:false — a multi-byte character cut in half by the cap must not throw.
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated };
}

/** Fetches an untrusted URL under full resource and destination control. */
export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const {
    timeoutMs = FETCH_DEFAULTS.timeoutMs,
    maxBytes = FETCH_DEFAULTS.maxBytes,
    maxRedirects = FETCH_DEFAULTS.maxRedirects,
    allowedContentTypes = FETCH_DEFAULTS.allowedContentTypes,
    userAgent = FETCH_DEFAULTS.userAgent,
  } = options;

  let url: URL;
  try {
    url = assertFetchableUrl(rawUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'That URL cannot be read.';
    throw new SafeFetchError(
      message.includes('private or internal') ? 'blocked_host' : 'invalid_url',
      message,
    );
  }

  // One budget for the entire operation, redirects included. A per-hop timeout
  // would let a 3-hop chain stall for 3x as long.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let redirectCount = 0;

    for (;;) {
      let res: Response;
      try {
        res = await fetch(url.toString(), {
          // manual, NOT follow: the platform would otherwise follow redirects
          // for us and we would never see - or get to validate - the
          // intermediate destinations.
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': userAgent,
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new SafeFetchError('timeout', `Timed out reading ${url.hostname}.`);
        }
        // The underlying message can carry resolver and connection detail.
        throw new SafeFetchError('network', `Could not reach ${url.hostname}.`);
      }

      // ---- Redirect handling -------------------------------------------
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          throw new SafeFetchError('bad_redirect', `${url.hostname} sent an incomplete redirect.`);
        }

        if (redirectCount >= maxRedirects) {
          throw new SafeFetchError(
            'too_many_redirects',
            `That link redirected more than ${maxRedirects} times.`,
          );
        }

        let next: URL;
        try {
          // Resolved against the CURRENT url, so relative Locations work.
          next = new URL(location, url);
        } catch {
          throw new SafeFetchError('bad_redirect', `${url.hostname} sent an invalid redirect.`);
        }

        // Re-validate EVERY hop. This is the check whose absence made the
        // original guard cosmetic: the first URL is rarely the hostile one.
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          throw new SafeFetchError('bad_redirect', 'That link redirected to an unsupported scheme.');
        }
        if (isPrivateHost(next.hostname)) {
          throw new SafeFetchError(
            'blocked_host',
            `That link redirected to a private or internal address (${next.hostname}).`,
          );
        }

        // Body of a redirect response is never useful; free the connection.
        await res.body?.cancel().catch(() => {});

        url = next;
        redirectCount += 1;
        continue;
      }

      // ---- Terminal response -------------------------------------------
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new SafeFetchError('http_error', `Could not fetch the page (${res.status}).`);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (!allowedContentTypes.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new SafeFetchError(
          'unsupported_content_type',
          contentType
            ? `That link is ${contentType.split(';')[0]}, not a readable page.`
            : 'That link did not return a readable page.',
        );
      }

      // Reject on the declared length before reading a byte, when we can.
      const declared = Number(res.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new SafeFetchError('too_large', 'That page is too large to read.');
      }

      const { text, truncated } = await readCapped(res.body, maxBytes);

      return {
        text,
        finalUrl: url.toString(),
        contentType,
        truncated,
        redirectCount,
      };
    }
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (controller.signal.aborted) {
      throw new SafeFetchError('timeout', 'That page took too long to respond.');
    }
    throw new SafeFetchError('network', 'That page could not be read.');
  } finally {
    clearTimeout(timer);
  }
}
