/** Worker entrypoint.
 *
 *  WHY THIS FILE EXISTS. `wrangler.jsonc` used to point `main` straight at
 *  `@astrojs/cloudflare/entrypoints/server`, which exports only
 *  `{ fetch }`. A Durable Object class has to be a named export of the
 *  Worker's entry module, so the rate limiter could not be reached from there.
 *
 *  This module re-exports the adapter's handler unchanged and adds the class
 *  alongside it. It adds no request-path behaviour: the default export is
 *  literally the adapter's, so SSR routing, asset serving and the image
 *  service all behave exactly as before.
 *
 *  DEPLOYMENT: `main` in wrangler.jsonc must point HERE, not at the adapter,
 *  once the Durable Object binding is enabled. See the commented block in
 *  that file. */

export { RateLimiter } from './lib/durable/rate-limiter';
export { default } from '@astrojs/cloudflare/entrypoints/server';
