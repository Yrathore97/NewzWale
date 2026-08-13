import { describe, it, expect } from 'vitest';
import {
  checkFidelity,
  extractNumbers,
  extractYears,
  extractNamedEntities,
  fidelityBlocksSupport,
} from '../../src/lib/factcheck/fidelity';
import { assessRelevance } from '../../src/lib/factcheck/relevance';

describe('extractNumbers', () => {
  it('normalises magnitude words to a common scale', () => {
    const [m] = extractNumbers('affecting 10 million people');
    expect(m!.value).toBe(10_000_000);

    const [c] = extractNumbers('a cost of 500 crore');
    expect(c!.value).toBe(5_000_000_000);
  });

  it('separates units so a percentage never compares to a headcount', () => {
    const facts = extractNumbers('12 per cent of 10 million people');
    expect(facts.map((f) => f.unit).sort()).toEqual(['count', 'percent']);
  });

  it('marks hedged figures as approximate', () => {
    expect(extractNumbers('about 3 km')[0]!.approximate).toBe(true);
    expect(extractNumbers('exactly 3 km')[0]!.approximate).toBe(false);
  });

  it('handles currency with and without magnitude', () => {
    expect(extractNumbers('Rs 500 crore')[0]!.value).toBe(5_000_000_000);
    expect(extractNumbers('$1,200')[0]!.value).toBe(1200);
  });
});

describe('extractYears / extractNamedEntities', () => {
  it('finds four-digit years', () => {
    expect(extractYears('introduced in 2020 and revised in 2024').sort()).toEqual([2020, 2024]);
  });

  it('finds multi-word names', () => {
    expect(extractNamedEntities('The Reserve Board met the Coastal Affairs Ministry').join(' ')).toMatch(
      /Reserve Board/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CORE GUARANTEE: a different number is not corroboration.
// ═══════════════════════════════════════════════════════════════════════════
describe('numeric fidelity', () => {
  it('10 million does not support 15 million', () => {
    const f = checkFidelity('15 million people were affected.', 'Officials said 10 million people were affected.');
    expect(f.numbers).toBe('mismatch');
    expect(fidelityBlocksSupport(f)).toBe(true);
    expect(f.detail).toMatch(/15 million.*10 million/);
  });

  it('matching figures pass', () => {
    const f = checkFidelity('10 million people were affected.', 'Officials said 10 million people were affected.');
    expect(f.numbers).toBe('match');
    expect(fidelityBlocksSupport(f)).toBe(false);
  });

  it('tolerates rounding at the precision the claim was stated to', () => {
    // "7.4 million" carries one decimal, so 7.42 rounds to the same figure.
    const f = checkFidelity('The population is 7.4 million.', 'Final figures put it at 7.42 million.');
    expect(f.numbers).toBe('match');
  });

  it('does not tolerate a difference beyond the stated precision', () => {
    const f = checkFidelity('The population is 7.4 million.', 'Final figures put it at 9.1 million.');
    expect(f.numbers).toBe('mismatch');
  });

  it('a hedged claim tolerates a small difference', () => {
    expect(checkFidelity('The bridge is about 3 km long.', 'The span is 3.1 kilometres.').numbers).toBe(
      'match',
    );
  });

  it('a hedged claim still rejects a large difference', () => {
    expect(checkFidelity('The bridge is about 3 km long.', 'The span is 9 kilometres.').numbers).toBe(
      'mismatch',
    );
  });

  it('never compares across units', () => {
    // 12 per cent vs 12 million must not read as a match.
    const f = checkFidelity('Prices rose 12 per cent.', 'The fund holds 12 million rupees.');
    expect(f.numbers).not.toBe('match');
  });

  it('reports absent when the passage carries no comparable figure', () => {
    expect(checkFidelity('15 million were affected.', 'The scheme was discussed at length.').numbers).toBe(
      'absent',
    );
  });
});

describe('temporal fidelity', () => {
  it('2020 does not support 2024', () => {
    const f = checkFidelity('The policy was introduced in 2024.', 'The policy was introduced in 2020.');
    expect(f.years).toBe('mismatch');
    expect(fidelityBlocksSupport(f)).toBe(true);
  });

  it('a matching year passes', () => {
    expect(
      checkFidelity('The policy was introduced in 2024.', 'Records show a 2024 introduction.').years,
    ).toBe('match');
  });

  it('reports absent when the passage carries no year', () => {
    expect(checkFidelity('Introduced in 2024.', 'The policy exists.').years).toBe('absent');
  });
});

describe('entity fidelity', () => {
  it('matches when the claim’s subject appears', () => {
    expect(
      checkFidelity('The Reserve Board held rates.', 'The Reserve Board announced no change.').entities,
    ).toBe('match');
  });

  // A different organisation makes a passage OFF-TOPIC, not contradictory.
  // Reporting it as a mismatch would let a topic mismatch become a refutation.
  it('a different organisation is absent, never a mismatch', () => {
    const f = checkFidelity('The Reserve Board held rates.', 'The Coastal Ministry announced a grant.');
    expect(f.entities).toBe('absent');
    expect(f.entities).not.toBe('mismatch');
    expect(fidelityBlocksSupport(f)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// RELEVANCE — keyword overlap must not buy corroboration.
// ═══════════════════════════════════════════════════════════════════════════
describe('assessRelevance', () => {
  const CLAIM = 'The Reserve Board cut interest rates in August 2026.';

  it('scores a passage that addresses the assertion as relevant', () => {
    const r = assessRelevance(CLAIM, 'The Reserve Board cut its benchmark rate in August 2026.');
    expect(r.level).toBe('high');
    expect(r.countsTowardCorroboration).toBe(true);
  });

  // The central false-corroboration case: same organisation, high keyword
  // overlap, top search result, establishes nothing.
  it('rejects a passage about the same organisation but a different assertion', () => {
    const r = assessRelevance(
      CLAIM,
      'The Reserve Board headquarters in the capital was renovated at a cost of 40 crore.',
    );
    expect(r.countsTowardCorroboration).toBe(false);
  });

  it('rejects a passage sharing only the topic', () => {
    const r = assessRelevance(CLAIM, 'Interest rates are an important tool of monetary policy.');
    expect(r.countsTowardCorroboration).toBe(false);
  });

  it('rejects an entirely unrelated passage', () => {
    const r = assessRelevance(CLAIM, 'The cricket team won by four wickets in Chennai.');
    expect(r.level).toBe('none');
    expect(r.countsTowardCorroboration).toBe(false);
  });

  it('rejects an empty passage', () => {
    expect(assessRelevance(CLAIM, '').countsTowardCorroboration).toBe(false);
    expect(assessRelevance(CLAIM, '   ').level).toBe('none');
  });

  // Keyword overlap alone is capped below the threshold on purpose.
  it('shared words alone cannot reach the corroboration threshold', () => {
    const r = assessRelevance(
      CLAIM,
      'Reserve Board interest rates August 2026 Reserve Board interest rates',
    );
    // Repeating the claim's nouns without asserting anything about them.
    expect(r.signals.join(' ')).toMatch(/content words shared/);
    expect(r.level).not.toBe('high');
  });

  it('records what actually matched, for auditability', () => {
    const r = assessRelevance(CLAIM, 'The Reserve Board cut rates in August 2026.');
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals.join(' ')).toMatch(/Reserve Board/);
  });

  it('is deterministic', () => {
    const a = assessRelevance(CLAIM, 'The Reserve Board cut its rate.');
    const b = assessRelevance(CLAIM, 'The Reserve Board cut its rate.');
    expect(a.score).toBe(b.score);
  });
});
