import { describe, expect, it } from 'vitest';
import swSource from '../../public/sw.js?raw';

/** P9. public/sw.js is served verbatim and is a CLASSIC worker script, so it
 *  cannot be imported. Rather than duplicate the caching policy in TypeScript
 *  — where the copy under test would be the copy that never ships — the real
 *  file is evaluated with a stubbed `self`, and the policy functions it hangs
 *  off `self.__nz` are exercised directly.
 *
 *  Loaded via Vite's ?raw and evaluated with `new Function` rather than
 *  node:fs + node:vm, to stay inside the project's no-@types/node rule (see
 *  tests/types.d.ts). */

const ORIGIN = 'https://www.newzwale.com';

interface SwExports {
  route(url: string, method: string, mode?: string): 'bypass' | 'static' | 'page' | 'fresh';
  canCache(response: unknown): boolean;
  VERSION: string;
  CURRENT_CACHES: string[];
  OFFLINE_URL: string;
  MAX_PAGES: number;
}

interface SwHarness {
  self: Record<string, unknown>;
  listeners: string[];
  deletedCaches: string[];
  unregistered: () => boolean;
}

/** Evaluate `source` against a fake worker global. `onEvent` lets a test drive
 *  a lifecycle handler the moment the worker registers it. */
function evaluate(
  source: string,
  onEvent?: (type: string, handler: (event: unknown) => void, harness: SwHarness) => void,
  cacheNames: string[] = [],
): SwHarness & { sw: SwExports } {
  const listeners: string[] = [];
  const deletedCaches: string[] = [];
  let didUnregister = false;

  const self: Record<string, unknown> = {
    location: { origin: ORIGIN },
    skipWaiting: () => Promise.resolve(),
    registration: {
      unregister: () => {
        didUnregister = true;
        return Promise.resolve(true);
      },
    },
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
  };

  const harness: SwHarness = {
    self,
    listeners,
    deletedCaches,
    unregistered: () => didUnregister,
  };

  self.addEventListener = (type: string, handler: (event: unknown) => void) => {
    listeners.push(type);
    onEvent?.(type, handler, harness);
  };

  const caches = {
    keys: () => Promise.resolve([...cacheNames]),
    delete: (name: string) => {
      deletedCaches.push(name);
      return Promise.resolve(true);
    },
    open: () => Promise.resolve({}),
  };

  const run = new Function(
    'self',
    'URL',
    'Request',
    'caches',
    'fetch',
    source,
  ) as (
    self: unknown,
    URL: unknown,
    Request: unknown,
    caches: unknown,
    fetch: unknown,
  ) => void;

  run(self, URL, class {}, caches, () => Promise.reject(new Error('no network in test')));

  return { ...harness, sw: self.__nz as SwExports };
}

function fakeResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    type: 'basic',
    redirected: false,
    headers: { get: () => null },
    ...overrides,
  };
}

const { sw } = evaluate(swSource);

describe('service worker caching policy', () => {
  const route = (path: string, method = 'GET', mode = 'navigate') =>
    sw.route(`${ORIGIN}${path}`, method, mode);

  describe('never cached', () => {
    it('bypasses every /api/ route regardless of method', () => {
      expect(route('/api/v1/factcheck', 'GET', 'cors')).toBe('bypass');
      expect(route('/api/v1/factcheck', 'POST', 'cors')).toBe('bypass');
      expect(route('/api/v1/news', 'GET', 'cors')).toBe('bypass');
      expect(route('/api/v1/weather', 'GET', 'cors')).toBe('bypass');
      expect(route('/api/ticker', 'GET', 'cors')).toBe('bypass');
    });

    it('bypasses non-GET even for an otherwise cacheable path', () => {
      expect(route('/news', 'POST')).toBe('bypass');
      expect(route('/_astro/app.js', 'HEAD')).toBe('bypass');
    });

    it('bypasses cross-origin requests', () => {
      expect(sw.route('https://www.google-analytics.com/g/collect', 'GET', 'cors')).toBe('bypass');
      expect(sw.route('https://images.thehindu.com/photo.jpg', 'GET', 'no-cors')).toBe('bypass');
      // A look-alike host must not be mistaken for our own origin.
      expect(sw.route('https://www.newzwale.com.evil.test/news', 'GET', 'navigate')).toBe('bypass');
    });

    it('bypasses a malformed URL rather than guessing', () => {
      expect(sw.route('not a url', 'GET', 'navigate')).toBe('bypass');
    });

    it('bypasses same-origin non-document subresource fetches it does not know', () => {
      expect(route('/some/future/endpoint', 'GET', 'cors')).toBe('bypass');
    });
  });

  describe('fact-check freshness', () => {
    it('never serves a verdict from cache', () => {
      expect(route('/fact-check')).toBe('fresh');
      expect(route('/fact-check/')).toBe('fresh');
      expect(route('/fact-check/abc123')).toBe('fresh');
      expect(route('/fact-check/abc123/')).toBe('fresh');
    });

    it('allows the history shell, which holds no server-rendered verdict', () => {
      expect(route('/fact-check/history')).toBe('page');
      expect(route('/fact-check/history/')).toBe('page');
    });

    it('does not treat an unrelated path with the same prefix as fact-check', () => {
      expect(route('/fact-checkers')).toBe('page');
    });
  });

  describe('static assets are cache-first', () => {
    it('matches build output and self-hosted fonts', () => {
      expect(route('/_astro/index.abc123.js', 'GET', 'no-cors')).toBe('static');
      expect(route('/fonts/inter-400.woff2', 'GET', 'cors')).toBe('static');
    });

    it('matches the enumerated icon and manifest files', () => {
      expect(route('/site.webmanifest', 'GET', 'cors')).toBe('static');
      expect(route('/favicon.svg', 'GET', 'no-cors')).toBe('static');
      expect(route('/web-app-manifest-512x512.png', 'GET', 'no-cors')).toBe('static');
    });
  });

  describe('documents are network-first', () => {
    it('caches navigations to ordinary pages', () => {
      expect(route('/')).toBe('page');
      expect(route('/news')).toBe('page');
      expect(route('/trending')).toBe('page');
      expect(route('/saved/')).toBe('page');
      expect(route(sw.OFFLINE_URL)).toBe('page');
    });

    it('precaches the canonical trailing-slash offline URL', () => {
      // Prerendered routes build to <route>/index.html and Workers Assets 307s
      // the un-slashed form. Precaching '/offline' would store a redirect,
      // which cannot satisfy a navigation.
      expect(sw.OFFLINE_URL).toBe('/offline/');
    });
  });
});

describe('service worker response gate', () => {
  it('accepts a plain same-origin 200', () => {
    expect(sw.canCache(fakeResponse())).toBe(true);
  });

  it('rejects errors, redirects and opaque responses', () => {
    expect(sw.canCache(fakeResponse({ ok: false, status: 500 }))).toBe(false);
    expect(sw.canCache(fakeResponse({ status: 206 }))).toBe(false);
    expect(sw.canCache(fakeResponse({ redirected: true }))).toBe(false);
    expect(sw.canCache(fakeResponse({ type: 'opaque' }))).toBe(false);
    expect(sw.canCache(fakeResponse({ type: 'cors' }))).toBe(false);
    expect(sw.canCache(undefined)).toBe(false);
  });

  it('honours no-store and private', () => {
    expect(sw.canCache(fakeResponse({ headers: { get: () => 'no-store' } }))).toBe(false);
    expect(sw.canCache(fakeResponse({ headers: { get: () => 'private, max-age=0' } }))).toBe(false);
    expect(sw.canCache(fakeResponse({ headers: { get: () => 'public, max-age=60' } }))).toBe(true);
  });
});

describe('cache versioning', () => {
  it('scopes every cache name to the version, so a bump flushes them', () => {
    expect(sw.CURRENT_CACHES).toHaveLength(2);
    for (const name of sw.CURRENT_CACHES) {
      expect(name.endsWith(sw.VERSION)).toBe(true);
    }
  });

  it('bounds the page cache', () => {
    expect(sw.MAX_PAGES).toBeGreaterThan(0);
    expect(Number.isFinite(sw.MAX_PAGES)).toBe(true);
  });
});

describe('update flow', () => {
  const { listeners } = evaluate(swSource);

  it('registers install, activate and fetch', () => {
    expect(listeners).toEqual(expect.arrayContaining(['install', 'activate', 'fetch']));
  });

  it('does not let a superseded version linger', () => {
    // skipWaiting + clients.claim is what stops an old shell being served
    // "indefinitely" once a new worker is deployed.
    expect(swSource).toContain('skipWaiting');
    expect(swSource).toContain('clients.claim');
  });

  it('discards caches from a previous version on activate', async () => {
    let activate: ((event: unknown) => void) | undefined;
    const harness = evaluate(
      swSource,
      (type, handler) => {
        if (type === 'activate') activate = handler;
      },
      ['nz-static-v1', 'nz-pages-v1', 'nz-static-v0', 'nz-pages-v0'],
    );

    let pending: Promise<unknown> = Promise.resolve();
    activate?.({ waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;

    // Only the stale generation is removed; the current one survives.
    expect(harness.deletedCaches).toEqual(['nz-static-v0', 'nz-pages-v0']);
  });
});

describe('kill switch', () => {
  it('ships disabled', () => {
    expect(swSource).toContain('const KILL_SWITCH = false;');
  });

  it('when enabled, unregisters, clears every cache, and installs no fetch handler', async () => {
    const killed = swSource.replace('const KILL_SWITCH = false;', 'const KILL_SWITCH = true;');

    let pending: Promise<unknown> = Promise.resolve();
    const harness = evaluate(
      killed,
      (type, handler) => {
        if (type === 'activate') handler({ waitUntil: (p: Promise<unknown>) => (pending = p) });
      },
      ['nz-static-v1', 'nz-pages-v1', 'nz-legacy'],
    );

    // The rollback path must not intercept anything, even before the
    // unregistration resolves.
    expect(harness.listeners).not.toContain('fetch');

    await pending;
    expect(harness.deletedCaches).toEqual(['nz-static-v1', 'nz-pages-v1', 'nz-legacy']);
    expect(harness.unregistered()).toBe(true);
  });
});
