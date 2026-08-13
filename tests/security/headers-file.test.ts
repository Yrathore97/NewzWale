import { describe, expect, it } from 'vitest';
import headersFile from '../../public/_headers?raw';
import { securityHeaders, CSP_HEADER_REPORT_ONLY } from '../../src/lib/security/headers';

/** S-11. `public/_headers` covers the eleven PRERENDERED routes, which are
 *  served from the Workers Assets binding and never reach `src/middleware.ts`.
 *
 *  That means the same policy is expressed in two places. A static copy of a
 *  security policy is a policy that silently drifts, and it would drift on
 *  exactly the pages nobody re-tests after a CSP edit. So rather than trust
 *  the duplication, this file parses the REAL `_headers` and asserts it equals
 *  what `securityHeaders()` produces — edit one without the other and the
 *  suite fails.
 *
 *  Loaded via Vite's `?raw` so the shipped file is the file under test, and to
 *  stay inside the project's no-`@types/node` rule (see tests/types.d.ts). */

/** Parses the Cloudflare `_headers` format: a rule line in column 0, then
 *  indented `name: value` pairs until the next rule or blank line. */
function parseHeadersFile(source: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: string | null = null;

  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      current = line.trim();
      rules.set(current, {});
      continue;
    }

    if (!current) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    rules.get(current)![name] = value;
  }

  return rules;
}

const rules = parseHeadersFile(headersFile);

/** The middleware's own call, mirrored: Report-Only, our report endpoint, and
 *  https (production is TLS; `_headers` cannot branch on protocol). */
const expected = securityHeaders({
  reportOnly: true,
  reportUri: '/api/v1/csp-report',
  https: true,
});

describe('public/_headers', () => {
  it('applies to every path', () => {
    expect(rules.has('/*')).toBe(true);
  });

  it('sets exactly the headers securityHeaders() produces — no more, no fewer', () => {
    const applied = rules.get('/*')!;
    expect(Object.keys(applied).sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.keys(expected))('matches securityHeaders() for %s', (name) => {
    expect(rules.get('/*')![name]).toBe(expected[name]);
  });

  it('carries the Content-Security-Policy, including the report endpoint', () => {
    const csp = rules.get('/*')![CSP_HEADER_REPORT_ONLY];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain('report-uri /api/v1/csp-report');
  });

  it('denies geolocation, closing A-07 on static pages too', () => {
    expect(rules.get('/*')!['permissions-policy']).toContain('geolocation=()');
  });

  it('does not declare Cache-Control, so the adapter still injects its own', () => {
    // @astrojs/cloudflare skips its immutable /_astro/* injection entirely if
    // this file already sets Cache-Control on a matching rule. Claiming one
    // here would silently drop asset caching in production.
    expect(rules.get('/*')!['cache-control']).toBeUndefined();
  });
});
