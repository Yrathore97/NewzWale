import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchText, SafeFetchError, FETCH_DEFAULTS } from '../../src/lib/http';

/** These tests exercise the SECURITY BOUNDARY, not helper functions: every
 *  case drives safeFetchText itself and asserts on what it did or refused to
 *  do. `fetch` is stubbed so the boundary's decisions are observable - what
 *  matters is which URLs it was willing to request and what it did with the
 *  responses. */

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  // Both parameters are declared so assertions can inspect the RequestInit
  // (redirect mode, abort signal) that safeFetchText passed.
  const inits: (RequestInit | undefined)[] = [];
  const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    inits.push(init);
    return handler(url);
  });
  vi.stubGlobal('fetch', spy);
  return { calls, inits, spy };
}

function html(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}

async function expectReason(p: Promise<unknown>, reason: string) {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).reason).toBe(reason);
    return err as SafeFetchError;
  }
  throw new Error(`expected SafeFetchError(${reason}), but nothing was thrown`);
}

// ---------------------------------------------------------------------------
describe('safeFetchText — happy path', () => {
  it('fetches a public https page and returns its body', async () => {
    stubFetch(() => html('<p>Repo rate held at 6.5%.</p>'));
    const res = await safeFetchText('https://thehindu.com/a');
    expect(res.text).toContain('Repo rate held');
    expect(res.finalUrl).toBe('https://thehindu.com/a');
    expect(res.redirectCount).toBe(0);
  });

  it('requests with redirect: manual so hops can be validated', async () => {
    const { inits } = stubFetch(() => html('ok'));
    await safeFetchText('https://thehindu.com/a');
    expect(inits[0]?.redirect).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
describe('safeFetchText — SSRF: initial target', () => {
  // The critical assertion in each of these is not just that it threw, but
  // that fetch was NEVER CALLED. A boundary that fails after making the
  // request has already leaked the request.
  for (const [label, url] of [
    ['localhost', 'http://localhost/admin'],
    ['127.0.0.1', 'http://127.0.0.1:8080/'],
    ['private IPv4', 'http://10.0.0.5/'],
    ['private IPv4 (192.168)', 'http://192.168.1.1/'],
    ['link-local / AWS metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['private IPv6', 'http://[fd00::1]/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv4-mapped IPv6 metadata', 'http://[::ffff:169.254.169.254]/'],
    ['multicast', 'http://224.0.0.1/'],
    ['Alibaba metadata', 'http://100.100.100.200/'],
    ['.internal', 'http://vault.internal/'],
  ] as const) {
    it(`refuses ${label} without issuing a request`, async () => {
      const { calls } = stubFetch(() => html('should never be reached'));
      await expectReason(safeFetchText(url), 'blocked_host');
      expect(calls).toEqual([]);
    });
  }

  for (const [label, url] of [
    ['file', 'file:///etc/passwd'],
    ['ftp', 'ftp://example.com/x'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
  ] as const) {
    it(`refuses the ${label} scheme without issuing a request`, async () => {
      const { calls } = stubFetch(() => html('nope'));
      await expectReason(safeFetchText(url), 'invalid_url');
      expect(calls).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The check whose absence made the original guard cosmetic. Validating only
// the first URL is equivalent to not validating: a public URL can 302 straight
// at internal infrastructure.
describe('safeFetchText — SSRF: redirect targets', () => {
  it('refuses a redirect to localhost and never requests it', async () => {
    const { calls } = stubFetch((url) =>
      url.includes('thehindu') ? redirect('http://localhost:8080/admin') : html('leaked'),
    );

    await expectReason(safeFetchText('https://thehindu.com/a'), 'blocked_host');
    expect(calls).toEqual(['https://thehindu.com/a']);
    expect(calls.some((c) => c.includes('localhost'))).toBe(false);
  });

  it('refuses a redirect to the cloud metadata endpoint', async () => {
    stubFetch((url) =>
      url.includes('thehindu') ? redirect('http://169.254.169.254/latest/meta-data/') : html('creds'),
    );
    await expectReason(safeFetchText('https://thehindu.com/a'), 'blocked_host');
  });

  it('refuses a redirect that reaches a private host on a LATER hop', async () => {
    // Two innocuous hops then an internal one — the case a first-URL-only
    // check misses completely.
    const { calls } = stubFetch((url) => {
      if (url.includes('/a')) return redirect('https://cdn.example.com/b');
      if (url.includes('/b')) return redirect('http://10.1.2.3/internal');
      return html('leaked');
    });

    await expectReason(safeFetchText('https://thehindu.com/a'), 'blocked_host');
    expect(calls.some((c) => c.includes('10.1.2.3'))).toBe(false);
  });

  it('refuses a redirect to a non-http scheme', async () => {
    stubFetch(() => redirect('file:///etc/passwd'));
    await expectReason(safeFetchText('https://thehindu.com/a'), 'bad_redirect');
  });

  it('follows safe redirects and reports the final URL', async () => {
    stubFetch((url) => (url.includes('/a') ? redirect('https://thehindu.com/b') : html('arrived')));
    const res = await safeFetchText('https://thehindu.com/a');
    expect(res.text).toContain('arrived');
    expect(res.finalUrl).toBe('https://thehindu.com/b');
    expect(res.redirectCount).toBe(1);
  });

  it('resolves a relative Location against the current URL', async () => {
    stubFetch((url) => (url.endsWith('/a') ? redirect('/b') : html('relative ok')));
    const res = await safeFetchText('https://thehindu.com/a');
    expect(res.finalUrl).toBe('https://thehindu.com/b');
  });

  it('stops after 3 hops', async () => {
    let n = 0;
    const { calls } = stubFetch(() => redirect(`https://thehindu.com/hop${(n += 1)}`));
    await expectReason(safeFetchText('https://thehindu.com/a'), 'too_many_redirects');
    // Initial request plus exactly maxRedirects follow-ups.
    expect(calls.length).toBe(FETCH_DEFAULTS.maxRedirects + 1);
  });

  it('rejects a redirect with no Location header', async () => {
    stubFetch(() => new Response(null, { status: 302 }));
    await expectReason(safeFetchText('https://thehindu.com/a'), 'bad_redirect');
  });
});

// ---------------------------------------------------------------------------
describe('safeFetchText — content-type validation', () => {
  for (const type of [
    'application/pdf',
    'image/png',
    'application/octet-stream',
    'application/zip',
    'video/mp4',
  ]) {
    it(`refuses ${type}`, async () => {
      stubFetch(() => new Response('binary junk', { status: 200, headers: { 'content-type': type } }));
      await expectReason(safeFetchText('https://thehindu.com/a'), 'unsupported_content_type');
    });
  }

  // A Uint8Array body, not a string: `new Response('...')` makes the runtime
  // auto-attach `text/plain;charset=UTF-8`, so a string body cannot express
  // "server sent no content-type" at all.
  it('refuses a response with no content-type', async () => {
    stubFetch(() => new Response(new Uint8Array([0x3c, 0x70, 0x3e]), { status: 200 }));
    await expectReason(safeFetchText('https://thehindu.com/a'), 'unsupported_content_type');
  });

  it('accepts html, xhtml and plain text', async () => {
    for (const type of ['text/html', 'application/xhtml+xml', 'text/plain; charset=utf-8']) {
      stubFetch(() => new Response('fine', { status: 200, headers: { 'content-type': type } }));
      await expect(safeFetchText('https://thehindu.com/a')).resolves.toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
describe('safeFetchText — response size', () => {
  it('refuses when content-length declares an oversized body', async () => {
    stubFetch(() =>
      html('x', { 'content-length': String(FETCH_DEFAULTS.maxBytes + 1) }),
    );
    await expectReason(safeFetchText('https://thehindu.com/a'), 'too_large');
  });

  // content-length can be absent under chunked encoding, or simply lie, so
  // trusting the header alone leaves the cap trivially bypassable.
  it('truncates an oversized body even when content-length lies', async () => {
    const huge = 'A'.repeat(200_000);
    stubFetch(() => html(huge, { 'content-length': '10' }));

    const res = await safeFetchText('https://thehindu.com/a', { maxBytes: 1000 });
    expect(res.truncated).toBe(true);
    expect(res.text.length).toBeLessThanOrEqual(1000);
  });

  it('does not mark a body under the cap as truncated', async () => {
    stubFetch(() => html('short'));
    const res = await safeFetchText('https://thehindu.com/a', { maxBytes: 1000 });
    expect(res.truncated).toBe(false);
  });

  it('survives a multi-byte character split by the cap', async () => {
    // Devanagari is 3 bytes per character; cutting mid-character must not throw.
    stubFetch(() => html('न'.repeat(500)));
    const res = await safeFetchText('https://thehindu.com/a', { maxBytes: 100 });
    expect(res.truncated).toBe(true);
    expect(typeof res.text).toBe('string');
  });
});

// ---------------------------------------------------------------------------
describe('safeFetchText — timeout', () => {
  it('aborts a response that never arrives', async () => {
    stubFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          // Mirrors what fetch does when its AbortSignal fires.
          setTimeout(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), 50);
        }),
    );
    await expectReason(safeFetchText('https://thehindu.com/a', { timeoutMs: 10 }), 'timeout');
  });

  it('passes an AbortSignal to fetch', async () => {
    const { inits } = stubFetch(() => html('ok'));
    await safeFetchText('https://thehindu.com/a');
    expect(inits[0]?.signal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('safeFetchText — error hygiene', () => {
  it('reports an http error status without exposing internals', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    const err = await expectReason(safeFetchText('https://thehindu.com/a'), 'http_error');
    expect(err.message).toMatch(/500/);
  });

  // A raw network error can carry resolver and connection detail.
  it('does not surface the underlying network error message', async () => {
    stubFetch(() => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:8080 via internal-proxy');
    });
    const err = await expectReason(safeFetchText('https://thehindu.com/a'), 'network');
    expect(err.message).not.toContain('ECONNREFUSED');
    expect(err.message).not.toContain('10.0.0.5');
    expect(err.message).not.toContain('internal-proxy');
  });
});
