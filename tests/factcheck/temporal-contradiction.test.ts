import { describe, it, expect } from 'vitest';
import { analyseTemporal, toTemporalFinding } from '../../src/lib/factcheck/temporal';
import {
  detectSourceConflicts,
  hasMaterialConflict,
} from '../../src/lib/factcheck/contradiction';
import type { EvidenceItem } from '../../src/lib/factcheck/signals';

const NOW = new Date('2026-08-08T00:00:00Z');

const support = (publishedAt: string | null, passage: string) => ({ publishedAt, passage });

// ═══════════════════════════════════════════════════════════════════════════
// TEMPORAL — the question is MATCH, not AGE
// ═══════════════════════════════════════════════════════════════════════════
describe('temporal analysis compares timeframes, it does not penalise age', () => {
  // The rule that keeps historical fact-checking possible.
  it('old evidence for a past-tense claim is not a problem', () => {
    const a = analyseTemporal({
      claimText: 'The subsidy was 12 rupees per litre in 2025.',
      supporting: [support('2025-04-01', 'The subsidy is set at 12 rupees with effect from April 2025.')],
      now: NOW,
    });
    expect(a.relationship).toBe('HISTORICAL');
    expect(a.materiality).toBe('none');
  });

  it('old evidence for a PRESENT-tense claim is material', () => {
    const a = analyseTemporal({
      claimText: 'The subsidy is currently 12 rupees per litre.',
      supporting: [support('2021-04-01', 'The subsidy is set at 12 rupees per litre.')],
      now: NOW,
    });
    expect(a.relationship).toBe('OUTDATED');
    expect(a.materiality).toBe('material');
    expect(a.detail).toMatch(/since changed|most recent/i);
  });

  it('recent evidence for a present-tense claim is current', () => {
    const a = analyseTemporal({
      claimText: 'The subsidy is currently 7 rupees per litre.',
      supporting: [support('2026-03-20', 'The subsidy is revised to 7 rupees per litre.')],
      now: NOW,
    });
    expect(a.relationship).toBe('CURRENT');
    expect(a.materiality).toBe('none');
  });

  // A time-dependent claim cannot be confirmed as current by an undated source.
  it('an undated source cannot establish a present-tense claim', () => {
    const a = analyseTemporal({
      claimText: 'The subsidy is currently 7 rupees per litre.',
      supporting: [support(null, 'The subsidy stands at 7 rupees per litre.')],
      now: NOW,
    });
    expect(a.relationship).toBe('TIMEFRAME_UNCLEAR');
    expect(a.materiality).toBe('material');
    expect(a.evidenceTimeframe.undated).toBe(true);
  });

  it('a future claim is flagged: a plan is not an outcome', () => {
    const a = analyseTemporal({
      claimText: 'The subsidy will be abolished in 2028.',
      supporting: [support('2026-06-01', 'A consultation paper considers phased withdrawal.')],
      now: NOW,
    });
    expect(a.relationship).toBe('FUTURE');
    expect(a.materiality).toBe('material');
  });

  it('evidence predating the claim’s year cannot describe it', () => {
    const a = analyseTemporal({
      claimText: 'The policy was introduced in 2024.',
      supporting: [support('2020-01-01', 'The policy was introduced in 2020.')],
      now: NOW,
    });
    expect(a.materiality).toBe('material');
    expect(a.detail).toMatch(/2024.*2020|covers 2020/);
  });

  it('evidence covering the claim’s year is fine', () => {
    const a = analyseTemporal({
      claimText: 'The policy was introduced in 2024.',
      supporting: [support('2024-03-01', 'The policy was introduced in 2024.')],
      now: NOW,
    });
    expect(a.materiality).toBe('none');
  });

  it('a timeless claim is not time-sensitive', () => {
    const a = analyseTemporal({
      claimText: 'Water boils at 100 degrees at sea level.',
      supporting: [support('2019-01-01', 'Water boils at 100 degrees Celsius at standard pressure.')],
      now: NOW,
    });
    expect(a.materiality).toBe('none');
  });

  it('reports unclear when there is no supporting evidence at all', () => {
    const a = analyseTemporal({ claimText: 'Rates are 6.5%.', supporting: [], now: NOW });
    expect(a.relationship).toBe('TIMEFRAME_UNCLEAR');
    expect(a.materiality).toBe('none');
  });

  it('records both timeframes for auditability', () => {
    const a = analyseTemporal({
      claimText: 'The policy was introduced in 2024.',
      supporting: [support('2024-03-01', 'Introduced in 2024 after review in 2023.')],
      now: NOW,
    });
    expect(a.claimTimeframe.years).toEqual([2024]);
    expect(a.evidenceTimeframe.publishedYears).toEqual([2024]);
    expect(a.evidenceTimeframe.referencedYears.sort()).toEqual([2023, 2024]);
  });

  it('maps onto the gate’s finding shape', () => {
    const outdated = toTemporalFinding(
      analyseTemporal({
        claimText: 'The subsidy is currently 12 rupees.',
        supporting: [support('2021-04-01', 'Subsidy is 12 rupees.')],
        now: NOW,
      }),
    );
    expect(outdated.kind).toBe('outdated');
    expect(outdated.significance).toBe('material');

    const fine = toTemporalFinding(
      analyseTemporal({
        claimText: 'The bridge opened in 2026.',
        supporting: [support('2026-03-12', 'Opened in 2026.')],
        now: NOW,
      }),
    );
    expect(fine.kind).toBe('none');
    expect(fine.significance).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTRADICTION — between sources, never averaged
// ═══════════════════════════════════════════════════════════════════════════
let pos = 0;
function ev(domain: string, passage: string, over: Partial<EvidenceItem> = {}): EvidenceItem {
  pos += 1;
  return {
    position: pos,
    url: `https://${domain}/a`,
    title: 'T',
    publisher: domain,
    domain,
    tier: 'tier2',
    publishedAt: '2026-08-01',
    accessedAt: '2026-08-08T00:00:00.000Z',
    stance: 'supports',
    quotedPassage: passage,
    readMethod: 'full_page',
    injectionFlagged: false,
    loadBearing: true,
    ...over,
  };
}

describe('contradiction between sources', () => {
  it('detects a material numeric disagreement', () => {
    const conflicts = detectSourceConflicts([
      ev('a.example', 'The fund distributed 15 million rupees.'),
      ev('b.example', 'Disbursements totalled 10 million rupees.'),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ conflictType: 'number', materiality: 'material' });
    expect(hasMaterialConflict(conflicts)).toBe(true);
  });

  // The figures must survive as figures — never averaged into "12.5 million".
  it('reports both values rather than resolving them', () => {
    const [c] = detectSourceConflicts([
      ev('a.example', 'The fund distributed 15 million rupees.'),
      ev('b.example', 'Disbursements totalled 10 million rupees.'),
    ]);
    expect(c!.valueA).toMatch(/15 million/);
    expect(c!.valueB).toMatch(/10 million/);
    expect(c!.resolutionStatus).toBe('unresolved');
    expect(c!.point).toMatch(/a\.example.*b\.example/);
  });

  it('treats rounding as a minor disagreement, not a material one', () => {
    const conflicts = detectSourceConflicts([
      ev('a.example', 'The population is 7.40 million.'),
      ev('b.example', 'The population is 7.42 million.'),
    ]);
    expect(hasMaterialConflict(conflicts)).toBe(false);
  });

  it('finds no conflict when sources agree', () => {
    expect(
      detectSourceConflicts([
        ev('a.example', 'The figure is 10 million.'),
        ev('b.example', 'The figure is 10 million.'),
      ]),
    ).toHaveLength(0);
  });

  // Two pages from one publisher restating a figure is not disagreement
  // between sources.
  it('ignores two pages from the same domain', () => {
    expect(
      detectSourceConflicts([
        ev('same.example', 'The figure is 10 million.'),
        ev('same.example', 'The figure is 15 million.'),
      ]),
    ).toHaveLength(0);
  });

  // A poisoned source disagreeing with a clean one is a poisoned source, not
  // a source conflict — otherwise an attacker manufactures doubt at will.
  it('excludes injection-flagged sources from conflict detection', () => {
    expect(
      detectSourceConflicts([
        ev('clean.example', 'The figure is 10 million.'),
        ev('evil.example', 'The figure is 99 million.', { injectionFlagged: true }),
      ]),
    ).toHaveLength(0);
  });

  it('only compares sources that engage the claim, when told which do', () => {
    const items = [
      ev('a.example', 'The figure is 10 million.'),
      ev('b.example', 'The figure is 15 million.'),
    ];
    const relevant = new Set([items[0]!.position]);
    expect(detectSourceConflicts(items, { relevantPositions: relevant })).toHaveLength(0);
  });

  it('never compares across units', () => {
    expect(
      detectSourceConflicts([
        ev('a.example', 'Prices rose 12 per cent.'),
        ev('b.example', 'The fund holds 40 million rupees.'),
      ]).filter((c) => c.conflictType === 'number'),
    ).toHaveLength(0);
  });

  it('deduplicates repeated conflicts on the same pair', () => {
    const conflicts = detectSourceConflicts([
      ev('a.example', 'The figure is 10 million and 10 million again.'),
      ev('b.example', 'The figure is 15 million.'),
    ]);
    expect(conflicts.length).toBeLessThanOrEqual(2);
  });

  // ── Materiality vs detection ──────────────────────────────────────────
  // Detection keeps its wide net; only the VETO is narrowed. See the
  // `corroboratingPositions` note in contradiction.ts.

  it('downgrades to minor when NEITHER side cleared the corroboration bar', () => {
    // The live Agra-Lucknow shape: three pages measuring different things,
    // none of which counted toward corroboration, reported to the reader as
    // credible sources materially disagreeing - and vetoing the verdict.
    const items = [
      ev('a.example', 'The road is 302 km long.'),
      ev('b.example', 'The stretch is 49 km long.'),
    ];
    const conflicts = detectSourceConflicts(items, {
      relevantPositions: new Set(items.map((i) => i.position)),
      corroboratingPositions: new Set<number>(), // neither counted
    });

    // Still DETECTED - nothing is hidden.
    expect(conflicts.length).toBeGreaterThan(0);
    // But it can no longer forbid a verdict.
    expect(hasMaterialConflict(conflicts)).toBe(false);
  });

  it('keeps material when ONE side cleared the corroboration bar', () => {
    // The case pipeline.ts's wide detection net exists for: a weakly-relevant
    // source disagreeing with one that counts is a real finding.
    const items = [
      ev('a.example', 'The fund distributed 15 million rupees.'),
      ev('b.example', 'Disbursements totalled 10 million rupees.'),
    ];
    const conflicts = detectSourceConflicts(items, {
      relevantPositions: new Set(items.map((i) => i.position)),
      corroboratingPositions: new Set([items[0]!.position]),
    });
    expect(hasMaterialConflict(conflicts)).toBe(true);
  });

  it('is unchanged when corroboratingPositions is omitted', () => {
    const conflicts = detectSourceConflicts([
      ev('a.example', 'The fund distributed 15 million rupees.'),
      ev('b.example', 'Disbursements totalled 10 million rupees.'),
    ]);
    expect(hasMaterialConflict(conflicts)).toBe(true);
  });
});
