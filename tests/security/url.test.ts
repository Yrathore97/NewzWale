import { describe, it, expect } from 'vitest';
import {
  isSafeUrl,
  safeHref,
  canonicalizeUrl,
  isPrivateHost,
  assertFetchableUrl,
} from '../../src/lib/url';

describe('isSafeUrl — scheme allowlist', () => {
  it('accepts http and https', () => {
    expect(isSafeUrl('https://thehindu.com/a')).toBe(true);
    expect(isSafeUrl('http://thehindu.com/a')).toBe(true);
  });

  // Each of these becomes script execution or local file access if it reaches
  // an href. Evidence URLs come from third-party APIs and are assigned to
  // href, so this is the control for S-12.
  for (const dangerous of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)  ',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/uuid',
    'file:///etc/passwd',
    'filesystem:https://example.com/temporary/x',
    'vbscript:msgbox(1)',
    'about:blank',
  ]) {
    it(`rejects ${dangerous.trim().slice(0, 40)}`, () => {
      expect(isSafeUrl(dangerous)).toBe(false);
    });
  }

  it('rejects malformed and non-string input', () => {
    expect(isSafeUrl('not a url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
    expect(isSafeUrl('   ')).toBe(false);
    expect(isSafeUrl(null)).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(42)).toBe(false);
    expect(isSafeUrl({ url: 'https://x.com' })).toBe(false);
  });
});

describe('safeHref', () => {
  it('returns a normalised URL for safe input', () => {
    expect(safeHref('https://thehindu.com/a')).toBe('https://thehindu.com/a');
  });

  // null, not '' or '#': the caller is forced to decide what to render rather
  // than silently emitting a dead link.
  it('returns null for unsafe input', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});

describe('canonicalizeUrl — dedup boundary', () => {
  it('strips tracking parameters that defeat exact-URL dedup', () => {
    expect(canonicalizeUrl('https://thehindu.com/a?utm_source=x&utm_medium=y&id=7')).toBe(
      'https://thehindu.com/a?id=7',
    );
    expect(canonicalizeUrl('https://thehindu.com/a?fbclid=abc')).toBe('https://thehindu.com/a');
    expect(canonicalizeUrl('https://thehindu.com/a?gclid=abc')).toBe('https://thehindu.com/a');
  });

  it('collapses variants of the same article to one identity', () => {
    const forms = [
      'https://www.thehindu.com/a/',
      'https://thehindu.com/a',
      'https://THEHINDU.com/a#section',
      'https://thehindu.com/a?utm_campaign=push',
      'https://thehindu.com:443/a',
    ];
    const canonical = forms.map(canonicalizeUrl);
    expect(new Set(canonical).size).toBe(1);
  });

  it('orders query parameters so ?a=1&b=2 and ?b=2&a=1 are one article', () => {
    expect(canonicalizeUrl('https://x.com/p?b=2&a=1')).toBe(canonicalizeUrl('https://x.com/p?a=1&b=2'));
  });

  it('keeps genuinely distinct articles distinct', () => {
    expect(canonicalizeUrl('https://x.com/a')).not.toBe(canonicalizeUrl('https://x.com/b'));
    expect(canonicalizeUrl('https://x.com/p?id=1')).not.toBe(canonicalizeUrl('https://x.com/p?id=2'));
  });

  // An unsafe URL must never become a database key.
  it('returns null for unsafe input', () => {
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('garbage')).toBeNull();
  });
});

describe('isPrivateHost — SSRF host classification', () => {
  describe('blocks internal names', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'db.local',
      'vault.internal',
      'metadata.google.internal',
      'metadata',
      '',
      '   ',
    ]) {
      it(`blocks "${host}"`, () => expect(isPrivateHost(host)).toBe(true));
    }
  });

  describe('blocks loopback and private IPv4', () => {
    for (const host of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
    ]) {
      it(`blocks ${host}`, () => expect(isPrivateHost(host)).toBe(true));
    }
  });

  describe('blocks cloud metadata endpoints', () => {
    // AWS / GCP / Azure all use 169.254.169.254. Reaching it from a Worker
    // would expose instance credentials.
    it('blocks 169.254.169.254 (AWS/GCP/Azure)', () => {
      expect(isPrivateHost('169.254.169.254')).toBe(true);
    });
    it('blocks 100.100.100.200 (Alibaba Cloud)', () => {
      expect(isPrivateHost('100.100.100.200')).toBe(true);
    });
    it('blocks 192.0.0.192 (Oracle Cloud)', () => {
      expect(isPrivateHost('192.0.0.192')).toBe(true);
    });
  });

  describe('blocks other non-public IPv4 ranges', () => {
    for (const [host, why] of [
      ['100.64.0.1', 'CGNAT 100.64.0.0/10'],
      ['224.0.0.1', 'multicast 224.0.0.0/4'],
      ['239.255.255.250', 'SSDP multicast'],
      ['240.0.0.1', 'reserved 240.0.0.0/4'],
      ['255.255.255.255', 'broadcast'],
      ['198.18.0.1', 'benchmark 198.18.0.0/15'],
      ['203.0.113.5', 'TEST-NET-3'],
    ] as const) {
      it(`blocks ${host} (${why})`, () => expect(isPrivateHost(host)).toBe(true));
    }
  });

  describe('blocks IPv6 loopback, private and link-local', () => {
    for (const host of ['::1', '::', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      it(`blocks ${host}`, () => expect(isPrivateHost(host)).toBe(true));
    }
  });

  // REGRESSION. The previous guard matched only the DOTTED form of an
  // IPv4-mapped IPv6 address. But WHATWG URL parsing normalises the dotted
  // form to hex: new URL('http://[::ffff:169.254.169.254]/').hostname is
  // '[::ffff:a9fe:a9fe]'. The guard therefore never saw the address it was
  // written to block, and the cloud metadata endpoint was reachable.
  describe('blocks IPv4-mapped IPv6 in BOTH encodings', () => {
    for (const host of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '[::ffff:a9fe:a9fe]',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
    ]) {
      it(`blocks ${host}`, () => expect(isPrivateHost(host)).toBe(true));
    }

    it('blocks the form produced by actual URL parsing', () => {
      const parsed = new URL('http://[::ffff:169.254.169.254]/').hostname;
      expect(parsed).toBe('[::ffff:a9fe:a9fe]');
      expect(isPrivateHost(parsed)).toBe(true);
    });
  });

  describe('blocks bare numeric hosts that bypassed dotted-quad matching', () => {
    for (const host of ['2130706433', '0x7f000001', '3232235521']) {
      it(`blocks ${host}`, () => expect(isPrivateHost(host)).toBe(true));
    }
  });

  describe('allows genuine public hosts', () => {
    for (const host of [
      'thehindu.com',
      'www.thehindu.com',
      'indianexpress.com',
      'factcheck.org',
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700::1111',
      'example.co.in',
    ]) {
      it(`allows ${host}`, () => expect(isPrivateHost(host)).toBe(false));
    }
  });

  it('refuses malformed dotted quads rather than guessing', () => {
    expect(isPrivateHost('1.2.3.999')).toBe(true);
    expect(isPrivateHost('1.2.3')).toBe(true);
  });
});

describe('assertFetchableUrl', () => {
  it('returns a URL for a public https target', () => {
    expect(assertFetchableUrl('https://thehindu.com/a').hostname).toBe('thehindu.com');
  });

  it('rejects unsupported schemes', () => {
    expect(() => assertFetchableUrl('ftp://example.com/x')).toThrow(/http and https/i);
    expect(() => assertFetchableUrl('javascript:alert(1)')).toThrow(/http and https/i);
  });

  it('rejects private targets', () => {
    expect(() => assertFetchableUrl('http://localhost:8080/x')).toThrow(/private or internal/i);
    expect(() => assertFetchableUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /private or internal/i,
    );
  });

  it('rejects malformed input', () => {
    expect(() => assertFetchableUrl('nonsense')).toThrow(/valid URL/i);
  });

  // Error text is shown to users; it must name only what they supplied.
  it('does not leak internal detail in its message', () => {
    try {
      assertFetchableUrl('http://10.0.0.5/admin');
    } catch (err) {
      expect((err as Error).message).toContain('10.0.0.5');
      expect((err as Error).message).not.toMatch(/stack|internal error|ECONN/i);
    }
  });
});
