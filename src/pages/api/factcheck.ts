import type { APIRoute } from 'astro';
import { runFactCheckRequest } from '../../lib/factcheck/route';

/** Legacy fact-check endpoint.
 *
 *  The actual request handling now lives in src/lib/factcheck/route.ts, so
 *  this route and /api/v1/factcheck share ONE implementation of validation,
 *  rate limiting, the pipeline call, and persistence.
 *
 *  THE RESPONSE SHAPE IS DELIBERATELY UNCHANGED — bare `FactCheckResult` on
 *  success, `{ error }` on failure — matching the pre-P5 behaviour exactly.
 *  FactCheckWidget.astro parses this shape; the point of versioning under
 *  /v1 is that the migration can be gradual rather than a flag day. */
function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const result = await runFactCheckRequest(request);
  if (!result.ok) {
    return json({ error: result.message }, result.status, result.headers ?? {});
  }
  return json(result.body);
};
