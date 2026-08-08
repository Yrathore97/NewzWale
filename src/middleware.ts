import { defineMiddleware } from 'astro:middleware';
import { securityHeaders } from './lib/security/headers';

/** Applies the security header set to every SSR response.
 *
 *  Middleware, not per-route code, so a new route cannot be added without the
 *  headers. The previous state was that NO response carried any of them
 *  (NEWZWALE_SECURITY_AUDIT.md S-11).
 *
 *  NOTE ON PRERENDERED PAGES. 404.astro and 500.astro set `prerender = true`
 *  and are served from the assets binding, bypassing middleware entirely. They
 *  therefore do NOT receive these headers. Covering them needs a
 *  `public/_headers` entry at deploy time; recorded in the Phase 1 report
 *  rather than left as an assumed-covered gap. */
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next();

  const headers = securityHeaders({
    // Report-Only until build-time hashes exist for the six inline scripts.
    // Flipping this to false before then WILL break Google Analytics and the
    // anti-FOUC theme script. See lib/security/headers.ts.
    reportOnly: true,
    reportUri: '/api/v1/csp-report',
    // HSTS only over TLS; asserting it over plain http in local dev is noise.
    https: context.url.protocol === 'https:',
  });

  try {
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    return response;
  } catch {
    // Some responses (certain redirects and asset paths) carry immutable
    // headers. Clone rather than drop the security headers on those routes.
    const clone = new Response(response.body, response);
    for (const [key, value] of Object.entries(headers)) {
      clone.headers.set(key, value);
    }
    return clone;
  }
});
