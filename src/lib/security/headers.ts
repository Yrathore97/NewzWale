/** Security response headers, built from what this application ACTUALLY loads.
 *
 *  Every origin below was enumerated from the source, not copied from a
 *  generic template. A CSP that does not match the app is worse than none: it
 *  either breaks the site or gets loosened until it means nothing.
 *
 *  Inventory (verified by grepping src/ for external origins):
 *
 *    BROWSER-SIDE, and therefore in scope for CSP
 *      www.googletagmanager.com   gtag.js                Layout.astro:41
 *      www.google-analytics.com   GA beacons             (gtag.js sends here)
 *      fonts.googleapis.com       font CSS               global.css:1 @import
 *      fonts.gstatic.com          font files             (referenced by that CSS)
 *      api.open-meteo.com         weather                MastheadInfoStrip:124
 *      api.bigdatacloud.net       reverse geocode        MastheadInfoStrip:163
 *      ipapi.co                   IP geolocation         MastheadInfoStrip:185
 *      <any https>                publisher thumbnails   ArticleCard.astro:27
 *
 *    SERVER-SIDE ONLY, and therefore NOT in the CSP - these are Worker
 *    fetches, which CSP does not govern:
 *      newsdata.io, content.guardianapis.com, api.tavily.com,
 *      factchecktools.googleapis.com, query1.finance.yahoo.com, RSS feeds
 *
 *  The three MastheadInfoStrip origins are a privacy finding in their own
 *  right (NEWZWALE_SECURITY_AUDIT.md S-09: they receive the visitor's IP and
 *  precise coordinates). They are allowed here because removing them is a
 *  behaviour change to the weather feature, tracked separately. Closing S-09
 *  also shortens this policy - that is the point of writing it down. */

export interface CspOptions {
  /** Report-Only emits violations without blocking. Always ship this way
   *  first: an enforced policy that is 95% right still breaks the site. */
  reportOnly?: boolean;
  /** Where violation reports are POSTed. */
  reportUri?: string;
}

/** img-src is unavoidably broad: thumbnails come from arbitrary publishers
 *  (thehindu.com, indianexpress.com, ndtv, livemint, plus whatever NewsData
 *  returns). Narrowing it would require proxying every image, which is a
 *  Cloudflare Images decision, not a CSP one. */
export function buildCsp({ reportOnly = true, reportUri }: CspOptions = {}): string {
  const directives: string[] = [
    "default-src 'self'",

    // 'unsafe-inline' is a KNOWN WEAKNESS, not an oversight.
    //
    // Layout.astro carries four is:inline scripts (the gtag loader, the gtag
    // config, the anti-FOUC theme initialiser, and JSON-LD); privacy.astro and
    // terms.astro carry one each. A nonce cannot fix this on its own because
    // 404.astro and 500.astro are PRERENDERED - a nonce baked in at build time
    // is a constant, and a constant nonce is no nonce at all.
    //
    // The real fix is build-time SHA-256 hashes for those six blocks, which
    // needs an integration hook. Until then this directive is why the policy
    // ships Report-Only: it is a measurement tool, not yet an XSS control.
    `script-src 'self' 'unsafe-inline' https://www.googletagmanager.com`,

    // Tailwind emits a stylesheet, but inline style attributes are used for
    // dynamic values (e.g. the saved-articles drawer transform), so
    // 'unsafe-inline' here is genuinely required rather than provisional.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",

    'font-src https://fonts.gstatic.com',

    // Publisher thumbnails are arbitrary https origins. data: covers inline
    // SVG placeholders.
    "img-src 'self' data: https:",

    [
      "connect-src 'self'",
      'https://www.google-analytics.com',
      'https://api.open-meteo.com',
      'https://api.bigdatacloud.net',
      'https://ipapi.co',
    ].join(' '),

    // Nothing in this application embeds or is embedded.
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    // No form posts to third parties; the fact-check form is fetch-based.
    "form-action 'self'",
    // Astro emits module scripts only; no legacy workers.
    "worker-src 'self'",
    'upgrade-insecure-requests',
  ];

  if (reportUri) {
    directives.push(`report-uri ${reportUri}`);
  }

  // Referenced so the parameter is meaningful at the call site even though the
  // directive list is identical either way - the difference is the header NAME.
  void reportOnly;

  return directives.join('; ');
}

export const CSP_HEADER_ENFORCE = 'content-security-policy';
export const CSP_HEADER_REPORT_ONLY = 'content-security-policy-report-only';

export interface SecurityHeaderOptions extends CspOptions {
  /** HSTS is meaningless (and misleading) over plain http in local dev. */
  https?: boolean;
}

/** The full header set. Returned as a plain object so it can be asserted in
 *  tests without constructing a Response. */
export function securityHeaders({
  reportOnly = true,
  reportUri,
  https = true,
}: SecurityHeaderOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    // Stops MIME sniffing turning a JSON API response into executable script.
    'x-content-type-options': 'nosniff',

    // Full URLs leak to every outbound publisher link and to Google Analytics.
    // Same-origin gets the full path; cross-origin gets the origin only, and
    // http downgrades get nothing.
    'referrer-policy': 'strict-origin-when-cross-origin',

    // Deny by default. geolocation is 'self' rather than empty ONLY because
    // MastheadInfoStrip currently requests it for the weather widget; that
    // call is itself a finding (S-09) and this should become () when it goes.
    'permissions-policy': [
      'geolocation=(self)',
      'camera=()',
      'microphone=()',
      'payment=()',
      'usb=()',
      'magnetometer=()',
      'gyroscope=()',
      'accelerometer=()',
      'interest-cohort=()',
    ].join(', '),

    // Belt and braces with frame-ancestors: older browsers honour only this.
    'x-frame-options': 'DENY',

    [reportOnly ? CSP_HEADER_REPORT_ONLY : CSP_HEADER_ENFORCE]: buildCsp({
      reportOnly,
      reportUri,
    }),
  };

  if (https) {
    // Cloudflare may already set this at the zone level; sending it twice is
    // harmless, and relying on a dashboard setting we cannot see from here is
    // not. 1 year, subdomains included. Preload is deliberately NOT set - that
    // is a one-way door and belongs to a deployment decision, not to code.
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }

  return headers;
}
