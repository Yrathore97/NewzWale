import type { APIRoute } from 'astro';
import { assertMethod } from '../../../lib/api/request';
import { handle, ok } from '../../../lib/api/response';
import { ApiError } from '../../../lib/api/errors';
import { safeFetchText } from '../../../lib/http';

/** GET /api/v1/weather — current conditions for the visitor's region.
 *
 *  THIS ROUTE EXISTS TO CLOSE SECURITY FINDING S-09. Today
 *  MastheadInfoStrip.astro calls three third parties FROM THE BROWSER on every
 *  page load: open-meteo with precise coordinates, bigdatacloud with precise
 *  coordinates, and ipapi.co with the visitor's IP address. Three companies
 *  receive per-visitor location data NewzWale never needed to hand over —
 *  a DPDP Act 2023 notice-and-consent exposure, and `navigator.geolocation`
 *  fires with no user gesture on top of it (A-07).
 *
 *  Cloudflare already knows the request's approximate location, so the whole
 *  problem dissolves: `request.cf` supplies the coordinates server-side, one
 *  call to Open-Meteo happens from the Worker, and the visitor's IP and exact
 *  position never leave our infrastructure. The browser sees only this
 *  endpoint.
 *
 *  NO API KEY IS INVOLVED. Open-Meteo is keyless for non-commercial use, which
 *  is why it can be wired up now — nothing here needs a credential that does
 *  not exist yet.
 *
 *  COARSE LOCATION ONLY. `request.cf.city` and its lat/lon are city-level, not
 *  device GPS. That is the right resolution for a masthead strip, and it means
 *  we are not handling precise location data at all. A future "use my exact
 *  location" control must be behind an explicit click, per A-07.
 *
 *  REMAINING WORK, deliberately not done here: MastheadInfoStrip.astro still
 *  makes those three client-side calls. Deleting them is a UI change and is
 *  scoped to the phase that touches components; this route is the server half
 *  it will call. S-09 is not closed until both land. */

/** Cloudflare's per-request geo, as much of it as this route uses.
 *
 *  Typed structurally rather than imported: the fields are optional in
 *  practice — `cf` is absent under `astro dev` and its geo fields can be
 *  missing for some networks — and pretending they are guaranteed is how this
 *  ends up throwing on a real request. */
interface RequestGeo {
  city?: string;
  country?: string;
  latitude?: string;
  longitude?: string;
}

/** Open-Meteo WMO weather codes, collapsed to the handful of conditions a
 *  masthead can render. Kept as a small map rather than a full WMO table:
 *  every code that is not listed becomes 'unknown', which is honest, instead
 *  of being forced into the nearest label. */
const WMO_CONDITIONS: Record<number, string> = {
  0: 'clear',
  1: 'mainly-clear',
  2: 'partly-cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'fog',
  51: 'drizzle',
  53: 'drizzle',
  55: 'drizzle',
  61: 'rain',
  63: 'rain',
  65: 'heavy-rain',
  66: 'freezing-rain',
  67: 'freezing-rain',
  71: 'snow',
  73: 'snow',
  75: 'heavy-snow',
  80: 'showers',
  81: 'showers',
  82: 'heavy-showers',
  95: 'thunderstorm',
  96: 'thunderstorm',
  99: 'thunderstorm',
};

export function conditionFromCode(code: unknown): string {
  return typeof code === 'number' && code in WMO_CONDITIONS ? WMO_CONDITIONS[code]! : 'unknown';
}

/** Validates a coordinate string from `request.cf`.
 *
 *  Bounds-checked before it reaches a URL: these values are used to build an
 *  outbound request, so anything unparseable must be rejected rather than
 *  concatenated in and hoped about. */
export function coordinate(value: unknown, max: number): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  // `Number('')` and `Number('   ')` are 0, which is a VALID coordinate — so a
  // missing cf.latitude would silently become the equator and we would report
  // the weather at Null Island as the reader's. Empty input is missing input,
  // not zero.
  if (typeof value === 'string' && value.trim() === '') return null;

  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return n;
}

export interface WeatherPayload {
  location: string | null;
  country: string | null;
  temperatureC: number;
  condition: string;
  observedAt: string | null;
}

export const GET: APIRoute = async ({ request }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const geo = ((request as unknown as { cf?: RequestGeo }).cf ?? {}) as RequestGeo;

    const latitude = coordinate(geo.latitude, 90);
    const longitude = coordinate(geo.longitude, 180);

    // No usable geo — `astro dev`, or a network Cloudflare cannot place. Say
    // so rather than defaulting to Delhi and reporting someone else's weather
    // as the reader's.
    if (latitude === null || longitude === null) {
      throw new ApiError(
        'UPSTREAM_UNAVAILABLE',
        'Your approximate location is not available for this request.',
      );
    }

    const endpoint =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${latitude}&longitude=${longitude}&current_weather=true`;

    let parsed: unknown;
    try {
      // safeFetchText, not bare fetch: it bounds time and bytes and blocks
      // private hosts, the same controls every other outbound call in this
      // codebase goes through.
      const { text } = await safeFetchText(endpoint, {
        timeoutMs: 3_000,
        maxBytes: 32 * 1024,
        allowedContentTypes: /^application\/json\b/i,
      });
      parsed = JSON.parse(text);
    } catch {
      // The upstream error is swallowed on purpose: it can carry the outbound
      // URL and therefore the visitor's coordinates. `handle()` would log a
      // rethrown error, and that log would be the leak.
      throw new ApiError('UPSTREAM_UNAVAILABLE', 'Weather is unavailable right now.');
    }

    const current = (parsed as { current_weather?: Record<string, unknown> })?.current_weather;
    const temperature = typeof current?.temperature === 'number' ? current.temperature : null;

    if (temperature === null) {
      throw new ApiError('UPSTREAM_UNAVAILABLE', 'Weather is unavailable right now.');
    }

    const payload: WeatherPayload = {
      location: geo.city ?? null,
      country: geo.country ?? null,
      temperatureC: temperature,
      condition: conditionFromCode(current?.weathercode),
      observedAt: typeof current?.time === 'string' ? current.time : null,
    };

    return ok(payload, { cached: false });
  });
