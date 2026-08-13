import type { APIRoute } from 'astro';
import { assertMethod } from '../../../lib/api/request';
import { handle, ok, fail } from '../../../lib/api/response';
import { runFactCheckRequest } from '../../../lib/factcheck/route';

/** POST /api/v1/factcheck — submit a claim or URL, get back a full result.
 *
 *  REUSES THE EXISTING PIPELINE. `runFactCheckRequest` is the same function
 *  /api/factcheck calls — same validation, rate limit, cache identity,
 *  evidence retrieval, and D1 persistence. This route only translates the
 *  result into the /api/v1 envelope; it does not re-implement any of it.
 *
 *  Append-only is untouched: persistence goes through `persistFactCheck` →
 *  `FactCheckRepository.create()`, which has no update/delete path. A
 *  repeated identical request is a cache hit or a fresh row with a fresh
 *  content-derived id — never a mutation of an existing record. */
export const POST: APIRoute = async ({ request }) =>
  handle(async () => {
    assertMethod(request, 'POST');

    const result = await runFactCheckRequest(request);
    if (!result.ok) {
      return fail(result.code ?? 'INTERNAL', result.message, result.headers ?? {});
    }
    return ok(result.body);
  });
