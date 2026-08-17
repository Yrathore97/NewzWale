import { describe, it, expect, vi } from 'vitest';
import { extractReadableText, fetchArticleText, isPrivateHost } from '../../src/lib/factcheck/extract';

describe('extractReadableText', () => {
  it('strips tags and returns prose', () => {
    const html = `<html><body><h1>Repo rate held</h1><p>The RBI kept rates at 6.5 percent.</p></body></html>`;
    const out = extractReadableText(html);
    expect(out).toContain('Repo rate held');
    expect(out).toContain('The RBI kept rates at 6.5 percent.');
    expect(out).not.toContain('<p>');
  });

  it('drops script and style contents', () => {
    const html = `<body><script>var x = "danger";</script><style>.a{color:red}</style><p>Real text.</p></body>`;
    const out = extractReadableText(html);
    expect(out).toBe('Real text.');
  });

  it('decodes common entities', () => {
    expect(extractReadableText('<p>Tata &amp; Sons said &quot;yes&quot;</p>')).toBe('Tata & Sons said "yes"');
  });

  it('truncates very long documents', () => {
    const html = `<p>${'word '.repeat(5000)}</p>`;
    expect(extractReadableText(html).length).toBeLessThanOrEqual(4000);
  });

  it('does not leak a quoted attribute value containing raw ">" characters', () => {
    // Reproduces a real fetch of a Wikipedia article: Parsoid HTML stores a
    // <ref> citation's original wikitext in a data-mw attribute, unescaped
    // "<"/">" and all, inside otherwise-normal double quotes. A naive
    // `<[^>]+>` strip ends the tag at that internal ">" and lets the rest of
    // the attribute (raw template markup, then real prose) through as text.
    const html =
      '<sup data-mw="{&quot;body&quot;:&quot;{{cite news|url=x}}</ref>&quot;,&quot;state&quot;:{&quot;wt&quot;:&quot;Uttar Pradesh&quot;}}">[1]</sup>' +
      '<p>The expressway opened to traffic in November 2016.</p>';
    const out = extractReadableText(html);
    expect(out).not.toContain('cite news');
    expect(out).not.toContain('"state"');
    // "[1]" is the <sup> footnote marker's own visible text - legitimately
    // preserved. Only the data-mw attribute payload must be gone.
    expect(out).toBe('[1] The expressway opened to traffic in November 2016.');
  });

  it('still strips an ordinary tag whose attribute has no internal ">"', () => {
    const html = '<a href="https://example.com/a?x=1&y=2" title="A link">Read more</a>';
    expect(extractReadableText(html)).toBe('Read more');
  });
});

describe('isPrivateHost', () => {
  const PRIVATE = [
    'localhost',
    'LOCALHOST',
    'api.localhost',
    '127.0.0.1',
    '127.1.2.3',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.20.10.5',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.1.254',
    '169.254.169.254', // cloud metadata endpoint
    '0.0.0.0',
    '0.1.2.3',
    '::1',
    '[::1]',
    '::',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'printer.local',
    'db.internal',
    'DB.INTERNAL',
    'localhost.',
  ];

  for (const host of PRIVATE) {
    it(`rejects ${host}`, () => {
      expect(isPrivateHost(host)).toBe(true);
    });
  }

  const PUBLIC = [
    'example.com',
    'www.thehindu.com',
    'pib.gov.in',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1', // just below the 172.16.0.0/12 block
    '172.32.0.1', // just above it
    '192.169.0.1', // adjacent to 192.168.0.0/16
    '169.253.0.1', // adjacent to 169.254.0.0/16
    '11.0.0.1',
    '126.0.0.1',
    '128.0.0.1',
    '2606:4700::1111',
    'localhost.example.com', // a real public host that merely starts with the word
    'internal.example.com',
  ];

  for (const host of PUBLIC) {
    it(`allows ${host}`, () => {
      expect(isPrivateHost(host)).toBe(false);
    });
  }

  it('rejects an empty hostname', () => {
    expect(isPrivateHost('')).toBe(true);
    expect(isPrivateHost('   ')).toBe(true);
  });

  it('rejects malformed dotted-quad octets rather than guessing', () => {
    expect(isPrivateHost('999.999.999.999')).toBe(true);
  });
});

describe('fetchArticleText host guard', () => {
  it('throws a clear error for a loopback URL without fetching', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchArticleText('http://127.0.0.1:8080/admin')).rejects.toThrow(
      /private or internal address/i,
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('throws for the cloud metadata address', async () => {
    await expect(fetchArticleText('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /private or internal address/i,
    );
  });

  it('still rejects non-http schemes', async () => {
    await expect(fetchArticleText('file:///etc/passwd')).rejects.toThrow(/http and https/i);
  });
});
