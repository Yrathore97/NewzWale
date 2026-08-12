import { describe, it, expect } from 'vitest';
import {
  securityHeaders,
  buildCsp,
  CSP_HEADER_ENFORCE,
  CSP_HEADER_REPORT_ONLY,
} from '../../src/lib/security/headers';

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return [name ?? '', rest.join(' ')];
    }),
  );
}

describe('securityHeaders — the required set', () => {
  const h = securityHeaders();

  it('sets nosniff', () => {
    expect(h['x-content-type-options']).toBe('nosniff');
  });

  // Full URLs otherwise leak to every outbound publisher link and to GA.
  it('sets a referrer policy that does not leak full URLs cross-origin', () => {
    expect(h['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('denies powerful features by default', () => {
    const p = h['permissions-policy']!;
    expect(p).toContain('camera=()');
    expect(p).toContain('microphone=()');
    expect(p).toContain('payment=()');
  });

  // S-09/A-07 landed in P6: nothing calls navigator.geolocation any more, so
  // the allowlist is empty rather than same-origin. Tightened, not relaxed.
  it('denies geolocation outright now that nothing requests it', () => {
    expect(h['permissions-policy']).toContain('geolocation=()');
    expect(h['permissions-policy']).not.toContain('geolocation=*');
    expect(h['permissions-policy']).not.toContain('geolocation=(self)');
  });

  it('provides clickjacking protection two ways', () => {
    expect(h['x-frame-options']).toBe('DENY');
    expect(directives(h[CSP_HEADER_REPORT_ONLY]!).get('frame-ancestors')).toBe("'none'");
  });

  it('sets HSTS over https', () => {
    expect(securityHeaders({ https: true })['strict-transport-security']).toContain('max-age=31536000');
  });

  // Asserting HSTS over plain http is meaningless and misleading in local dev.
  it('omits HSTS over plain http', () => {
    expect(securityHeaders({ https: false })['strict-transport-security']).toBeUndefined();
  });

  // preload is a one-way door and belongs to a deployment decision.
  it('does not set HSTS preload', () => {
    expect(securityHeaders({ https: true })['strict-transport-security']).not.toContain('preload');
  });
});

describe('CSP — Report-Only by default', () => {
  it('uses the Report-Only header unless explicitly enforced', () => {
    expect(securityHeaders()[CSP_HEADER_REPORT_ONLY]).toBeDefined();
    expect(securityHeaders()[CSP_HEADER_ENFORCE]).toBeUndefined();
  });

  it('uses the enforcing header when asked', () => {
    const h = securityHeaders({ reportOnly: false });
    expect(h[CSP_HEADER_ENFORCE]).toBeDefined();
    expect(h[CSP_HEADER_REPORT_ONLY]).toBeUndefined();
  });

  it('includes a report-uri so Report-Only is not merely decorative', () => {
    expect(buildCsp({ reportUri: '/api/v1/csp-report' })).toContain('report-uri /api/v1/csp-report');
  });
});

// Every origin below was enumerated from the source. A CSP that does not match
// the app either breaks it or gets loosened until it means nothing.
describe('CSP — matches the origins this app actually loads', () => {
  const d = directives(buildCsp());

  it('starts from a self-only default', () => {
    expect(d.get('default-src')).toBe("'self'");
  });

  it('allows Google Tag Manager, which Layout.astro loads', () => {
    expect(d.get('script-src')).toContain('https://www.googletagmanager.com');
  });

  // P6 self-hosted Inter and JetBrains Mono into /fonts. These assertions are
  // deliberately inverted rather than deleted: if anyone reintroduces a Google
  // Fonts @import, the policy silently blocking it is far harder to debug than
  // a failing test naming the cause.
  it('serves fonts from self only, with no Google Fonts origins left', () => {
    expect(d.get('font-src')).toBe("'self'");
    expect(d.get('font-src')).not.toContain('fonts.gstatic.com');
    expect(d.get('style-src')).not.toContain('fonts.googleapis.com');
  });

  // Inverted in P6 rather than deleted. MastheadInfoStrip used to call these
  // three from the browser, handing each of them the visitor's IP or precise
  // coordinates on every page load. Weather now goes through /api/v1/weather,
  // so a reappearance of any of these origins is a privacy regression and
  // should fail here by name.
  it('no longer reaches any third-party location or weather API from the browser', () => {
    const connect = d.get('connect-src')!;
    expect(connect).not.toContain('api.open-meteo.com');
    expect(connect).not.toContain('api.bigdatacloud.net');
    expect(connect).not.toContain('ipapi.co');
  });

  it('allows GA beacons', () => {
    expect(d.get('connect-src')).toContain('https://www.google-analytics.com');
  });

  // Thumbnails come from arbitrary publishers; narrowing this needs image
  // proxying, which is a Cloudflare Images decision, not a CSP one.
  it('allows https images from anywhere, as publisher thumbnails require', () => {
    expect(d.get('img-src')).toContain('https:');
  });

  it('locks down object, frame and base-uri', () => {
    expect(d.get('object-src')).toBe("'none'");
    expect(d.get('frame-src')).toBe("'none'");
    expect(d.get('base-uri')).toBe("'self'");
    expect(d.get('form-action')).toBe("'self'");
  });

  // Server-side fetches are not governed by CSP; listing them would imply a
  // protection that does not exist.
  it('does not list server-only origins', () => {
    const csp = buildCsp();
    for (const serverOnly of [
      'newsdata.io',
      'api.tavily.com',
      'content.guardianapis.com',
      'factchecktools.googleapis.com',
      'query1.finance.yahoo.com',
    ]) {
      expect(csp).not.toContain(serverOnly);
    }
  });

  // Documents the current weakness rather than pretending it is not there.
  // When build-time hashes for the six inline scripts land, this test should
  // be inverted and the policy moved to enforcing.
  it('still needs unsafe-inline for scripts — the reason CSP ships Report-Only', () => {
    expect(d.get('script-src')).toContain("'unsafe-inline'");
  });
});
