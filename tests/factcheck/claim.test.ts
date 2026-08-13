import { describe, it, expect } from 'vitest';
import {
  extractClaim,
  splitSentences,
  decomposeSentence,
  extractQuantities,
  extractTimeframes,
  extractEntities,
  extractQualifiers,
  boilerplateRatio,
  isAssertion,
} from '../../src/lib/factcheck/claim';

describe('extractClaim — the governing rule: never invent a claim', () => {
  it('extracts a single clear assertion', () => {
    const c = extractClaim('The Reserve Board held the rate at 6.5% in August 2026.');
    expect(c.confident).toBe(true);
    expect(c.multiClaim).toBe(false);
    expect(c.text).toContain('6.5%');
  });

  // Preserving wording is not cosmetic: a fact check must judge what was said,
  // not a paraphrase of it. "Slashed" and "held" are different claims.
  it('preserves the submitter’s original wording', () => {
    const original = 'The Board slashed rates dramatically.';
    expect(extractClaim(original).text).toBe(original);
  });

  it('refuses navigation boilerplate rather than inventing a claim', () => {
    const c = extractClaim('Home About Contact Subscribe Newsletter Terms Privacy Sign in Menu');
    expect(c.confident).toBe(false);
    expect(c.extractionNote).toMatch(/boilerplate|navigation/i);
  });

  it('refuses text with no checkable assertion', () => {
    const c = extractClaim('Beautiful weather, wonderful colours, lovely day out there');
    expect(c.confident).toBe(false);
  });

  it('refuses a submission that is too short', () => {
    expect(extractClaim('hi').confident).toBe(false);
  });

  it('does not treat a question as an assertion', () => {
    expect(isAssertion('Did the Board hold the rate at 6.5%?')).toBe(false);
  });

  // A single verdict cannot honestly describe three separate findings.
  it('flags a multi-assertion submission instead of silently merging', () => {
    const c = extractClaim(
      'The bridge opened in March 2026. The water plant was shut down in July. The subsidy was abolished.',
    );
    expect(c.confident).toBe(true);
    expect(c.multiClaim).toBe(true);
    expect(c.extractionNote).toMatch(/3 separate assertions/);
  });

  it('does not flag a single sentence as multi-claim', () => {
    expect(extractClaim('The bridge opened in March 2026.').multiClaim).toBe(false);
  });

  it('records how the claim was obtained', () => {
    const c = extractClaim('The bridge opened in March 2026.', {
      source: 'url',
      originUrl: 'https://x.example/a',
    });
    expect(c.source).toBe('url');
    expect(c.originUrl).toBe('https://x.example/a');
  });

  it('bounds a very long submission', () => {
    const c = extractClaim(`The Board held the rate. ${'padding words here. '.repeat(500)}`);
    expect(c.text.length).toBeLessThanOrEqual(2000);
  });
});

// Components are what make PARTLY_TRUE reachable — without them there is
// nothing to call partly true.
describe('decomposeSentence — components for partly_true', () => {
  it('splits a coordinated sentence into two assertions', () => {
    const parts = decomposeSentence(
      'The ministry spent 500 crore on the scheme and the scheme failed completely',
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('500 crore');
    expect(parts[1]).toContain('failed');
  });

  it('does not split when only one half is an assertion', () => {
    expect(decomposeSentence('The board met and adjourned')).toHaveLength(1);
  });

  it('leaves a simple sentence whole', () => {
    expect(decomposeSentence('The bridge opened in March 2026')).toHaveLength(1);
  });

  it('produces components on the extracted claim', () => {
    const c = extractClaim(
      'The ministry spent 500 crore on the scheme and the scheme failed completely.',
    );
    expect(c.components.length).toBe(2);
    expect(c.components[0]!.kind).toBe('quantity');
    expect(c.components.every((x) => x.status === 'unassessed')).toBe(true);
  });
});

describe('entity, quantity, timeframe and qualifier extraction', () => {
  it('finds numbers, currency and percentages', () => {
    const q = extractQuantities('Spending rose to Rs 500 crore, up 12 per cent, over 3 kilometres.');
    expect(q.join(' ')).toMatch(/500 crore/);
    expect(q.join(' ')).toMatch(/12 per cent/);
  });

  it('finds years, months and relative timeframes', () => {
    const t = extractTimeframes('In August 2026 the policy changed; currently it applies.');
    expect(t).toContain('2026');
    expect(t.join(' ')).toMatch(/currently/i);
  });

  it('finds multi-word named entities', () => {
    const e = extractEntities('The Reserve Board and the Ministry of Coastal Affairs agreed.');
    expect(e.join(' ')).toMatch(/Reserve Board/);
  });

  // Dropping a hedge changes what was claimed, so hedges are captured.
  it('captures qualifiers rather than normalising them away', () => {
    const q = extractQualifiers('Reportedly nearly 500 people were affected, up to 12 per cent.');
    expect(q).toContain('reportedly');
    expect(q).toContain('nearly');
    expect(q).toContain('up to');
  });

  it('splits sentences without breaking decimals', () => {
    const s = splitSentences('Rates held at 6.5 per cent. The plant opened.');
    expect(s).toHaveLength(2);
  });
});

describe('boilerplateRatio', () => {
  it('is high for navigation chrome', () => {
    expect(boilerplateRatio('Home About Contact Terms Privacy Sign in')).toBeGreaterThan(0.3);
  });

  it('is low for real prose', () => {
    expect(
      boilerplateRatio('The Reserve Board held the benchmark rate at 6.5 per cent on Thursday.'),
    ).toBeLessThan(0.3);
  });

  it('treats empty input as fully boilerplate', () => {
    expect(boilerplateRatio('')).toBe(1);
  });
});
