import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { assertMethod } from '../../../../lib/api/request';
import { handle, ok, fail } from '../../../../lib/api/response';
import { requireDbBinding } from '../../../../lib/api/bindings';
import { FactCheckRepository } from '../../../../lib/db/repositories/fact-checks';

/** Longest id this route will look up. Ids are sha256 hex (64 chars); bounded
 *  generously above that so a pathological path segment cannot reach the
 *  database at all. */
const MAX_ID_LENGTH = 200;

/** GET /api/v1/factcheck/[id] — retrieve a persisted fact-check by id.
 *
 *  Reuses `FactCheckRepository.findById`, which already returns the check
 *  with its evidence in citation order. Never hides contradictory evidence,
 *  never turns "no evidence" into a refutation — that is pipeline behaviour
 *  and is untouched here; this route only reads what was persisted. */
export const GET: APIRoute = async ({ request, params }) =>
  handle(async () => {
    assertMethod(request, 'GET');

    const id = params.id ?? '';
    if (!id || id.length > MAX_ID_LENGTH) {
      return fail('NOT_FOUND', 'No fact-check exists with that id.');
    }

    const db = requireDbBinding(env);
    const found = await new FactCheckRepository(db).findById(id);

    if (!found) {
      return fail('NOT_FOUND', 'No fact-check exists with that id.');
    }

    return ok(found, { cached: false });
  });
