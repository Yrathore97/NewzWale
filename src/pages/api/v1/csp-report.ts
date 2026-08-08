import type { APIRoute } from 'astro';
import { assertMethod, readJson } from '../../../lib/api/request';
import { handle } from '../../../lib/api/response';

/** Collection endpoint for Content-Security-Policy violation reports.
 *
 *  Without this, Report-Only mode is decorative: the browser computes
 *  violations and discards them, so nobody learns what an enforced policy
 *  would have broken. This is the measurement half of "ship Report-Only
 *  first".
 *
 *  Reports are logged, not stored. Volume is unbounded and attacker-
 *  controllable (anyone can POST here), so persisting them would be a free
 *  write primitive into our database. Worker logs already have retention and
 *  sampling; that is the right place for diagnostic telemetry.
 *
 *  Deliberately NOT rate-limited by IP. A CSP report is emitted by the
 *  browser, not the user, and a legitimate page can emit several per load;
 *  throttling by IP would drop exactly the reports we need most from the
 *  busiest pages. The 8 KB body cap plus discarding unrecognised shapes is the
 *  abuse control instead. */

const MAX_REPORT_BYTES = 8 * 1024;

/** Fields worth logging, from either report format.
 *
 *  Two exist: the legacy `report-uri` shape (`{"csp-report": {...}}`) and the
 *  newer Reporting API shape (an array of `{type, body}`). Chrome and Firefox
 *  still send the legacy one for `report-uri`, so both are handled. */
interface CspReportBody {
  'document-uri'?: unknown;
  'violated-directive'?: unknown;
  'effective-directive'?: unknown;
  'blocked-uri'?: unknown;
  'script-sample'?: unknown;
  documentURL?: unknown;
  effectiveDirective?: unknown;
  blockedURL?: unknown;
}

function str(value: unknown, max = 300): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function summarise(body: CspReportBody): Record<string, string | undefined> {
  return {
    document: str(body['document-uri'] ?? body.documentURL),
    directive: str(body['effective-directive'] ?? body['violated-directive'] ?? body.effectiveDirective),
    blocked: str(body['blocked-uri'] ?? body.blockedURL),
    // Truncated hard: a script sample can contain page content.
    sample: str(body['script-sample'], 120),
  };
}

export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    assertMethod(request, 'POST');

    let payload: unknown;
    try {
      payload = await readJson(request, MAX_REPORT_BYTES);
    } catch {
      // A malformed report is not worth a 4xx: the browser cannot act on it
      // and retrying would only add noise. Accept and discard.
      return new Response(null, { status: 204 });
    }

    const reports: CspReportBody[] = [];
    if (Array.isArray(payload)) {
      // Reporting API batch.
      for (const entry of payload) {
        const body = (entry as { body?: CspReportBody })?.body;
        if (body) reports.push(body);
      }
    } else {
      const legacy = (payload as { 'csp-report'?: CspReportBody })?.['csp-report'];
      if (legacy) reports.push(legacy);
    }

    for (const report of reports) {
      const s = summarise(report);
      // Only log violations we can act on. A report with no directive is
      // usually an extension or an injected third-party script, not our policy.
      if (s.directive) {
        console.warn('[csp-report]', JSON.stringify(s));
      }
    }

    // 204: the browser expects no body and will not retry.
    return new Response(null, { status: 204 });
  });
