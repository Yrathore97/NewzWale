/** Strict parsing of structured model output into a VerdictProposal.
 *
 *  THE RULE. Ambiguity yields `valid: false`, which the gate turns into
 *  UNVERIFIED. Nothing here guesses a verdict from prose. A model that
 *  produces unusable output has told us it could not do the task, and the
 *  honest response is to say we could not establish the claim — not to salvage
 *  a verdict from whatever text came back.
 *
 *  Every field is defensively narrowed: model output is untrusted input like
 *  any other, and an unexpected shape must not throw inside the pipeline. */

import { coerceVerdict, isVerdict } from './schema';
import type {
  ContextFinding,
  ContradictionFinding,
  TemporalFinding,
  VerdictProposal,
} from './signals';

const NO_TEMPORAL: TemporalFinding = {
  kind: 'none',
  detail: '',
  positions: [],
  significance: 'none',
};

const NO_CONTEXT: ContextFinding = {
  kind: 'none',
  detail: '',
  positions: [],
  significance: 'none',
};

/** A proposal that establishes nothing. */
export function invalidProposal(note: string): VerdictProposal {
  return {
    proposedVerdict: 'unverified',
    componentStatuses: [],
    temporal: NO_TEMPORAL,
    context: NO_CONTEXT,
    contradictions: [],
    summary: '',
    reasoning: '',
    limitations: note ? [note] : [],
    valid: false,
  };
}

function str(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function significance(v: unknown): 'material' | 'minor' | 'none' {
  return v === 'material' || v === 'minor' ? v : 'none';
}

function positions(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  return v.filter((n): n is number => Number.isInteger(n) && (n as number) > 0).slice(0, 20);
}

const TEMPORAL_KINDS = ['outdated', 'superseded', 'undated_claim', 'future_dated', 'none'];
const CONTEXT_KINDS = [
  'missing_timeframe',
  'missing_baseline',
  'missing_qualifier',
  'missing_condition',
  'selective_framing',
  'none',
];

function parseTemporal(v: unknown): TemporalFinding {
  if (!v || typeof v !== 'object') return NO_TEMPORAL;
  const o = v as Record<string, unknown>;
  const kind = TEMPORAL_KINDS.includes(o.kind as string)
    ? (o.kind as TemporalFinding['kind'])
    : 'none';
  const sig = significance(o.significance);

  // A finding with no explanation cannot be shown to a reader, so it cannot be
  // material. Silently downgrading beats surfacing an empty assertion.
  const detail = str(o.detail, 600);
  return {
    kind,
    detail,
    positions: positions(o.positions),
    significance: kind === 'none' || !detail ? 'none' : sig,
  };
}

function parseContext(v: unknown): ContextFinding {
  if (!v || typeof v !== 'object') return NO_CONTEXT;
  const o = v as Record<string, unknown>;
  const kind = CONTEXT_KINDS.includes(o.kind as string)
    ? (o.kind as ContextFinding['kind'])
    : 'none';
  const sig = significance(o.significance);
  const detail = str(o.detail, 600);

  return {
    kind,
    detail,
    positions: positions(o.positions),
    significance: kind === 'none' || !detail ? 'none' : sig,
  };
}

function parseContradictions(v: unknown): ContradictionFinding[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object')
    .map((c) => ({
      positions: positions(c.positions),
      point: str(c.point, 300),
      significance: c.significance === 'material' ? ('material' as const) : ('minor' as const),
    }))
    .filter((c) => c.point.length > 0)
    .slice(0, 10);
}

/** Extracts the first JSON object from a reply that may be wrapped in prose or
 *  a fenced code block. Returns null rather than guessing. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  // Non-greedy first (the common shape), then greedy for nested objects.
  for (const re of [/\{[\s\S]*?\}/, /\{[\s\S]*\}/]) {
    const match = text.match(re);
    if (!match) continue;
    try {
      const parsed: unknown = JSON.parse(match[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next shape
    }
  }
  return null;
}

/** Normalises the several shapes Workers AI returns across models.
 *
 *  Older text-generation models return `{ response: "<text>" }`; the
 *  OpenAI-compatible ones return `choices[].message.content`, and sometimes a
 *  pre-parsed `response` object. Handling all three means swapping MODEL later
 *  does not silently degrade every answer to unverified. */
export function payloadFromAi(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') return extractJsonObject(raw);
  if (!raw || typeof raw !== 'object') return null;

  const r = raw as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };

  if (typeof r.response === 'string') return extractJsonObject(r.response);
  if (r.response && typeof r.response === 'object' && !Array.isArray(r.response)) {
    return r.response as Record<string, unknown>;
  }

  const content = r.choices?.[0]?.message?.content;
  if (typeof content === 'string') return extractJsonObject(content);

  return null;
}

/** Parses a raw Workers AI response into a VerdictProposal. */
export function parseProposal(raw: unknown): VerdictProposal {
  const payload = payloadFromAi(raw);
  if (!payload) {
    return invalidProposal('The assessment step did not return a readable result.');
  }

  // A verdict outside the vocabulary is not a near-miss to be repaired — it
  // means the model did not follow the contract, so nothing it said is trusted.
  if (!isVerdict(payload.verdict)) {
    return invalidProposal('The assessment step returned an unrecognised verdict.');
  }

  const summary = str(payload.summary, 400);
  const reasoning = str(payload.reasoning, 1500);

  return {
    proposedVerdict: coerceVerdict(payload.verdict),
    componentStatuses: [],
    temporal: parseTemporal(payload.temporal),
    context: parseContext(payload.context),
    contradictions: parseContradictions(payload.contradictions),
    summary,
    reasoning,
    limitations: Array.isArray(payload.limitations)
      ? payload.limitations.map((l) => str(l, 400)).filter(Boolean).slice(0, 10)
      : [],
    valid: true,
  };
}
