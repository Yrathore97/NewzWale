import type { GoldenCase } from './types';
import { isConfidentlyWrong } from './types';
import type { Verdict } from '../../../src/lib/factcheck/schema';
import type { EvidenceItem } from '../../../src/lib/factcheck/signals';

/** Shared evaluation harness for the golden set.
 *
 *  Deliberately takes the evaluator as a parameter so the SAME cases can be
 *  run against the old four-value gate and the new six-value engine, and the
 *  two reports compared directly. A harness that could only run the new code
 *  could not establish a baseline, and without a baseline "it improved" is an
 *  assertion rather than a measurement. */

export interface CaseResult {
  id: string;
  expected: Verdict;
  actual: Verdict;
  proposed: Verdict;
  pass: boolean;
  /** Asserted something definite and was wrong. The gate forbids these. */
  confidentlyWrong: boolean;
  /** Refused to assert when the answer was establishable. A miss, not a danger. */
  overCautious: boolean;
  strength?: string;
  sourceCount: number;
  independentDomainCount: number;
  tags: string[];
  reason: string;
}

export interface GoldenReport {
  total: number;
  passed: number;
  failed: number;
  confidentlyWrong: CaseResult[];
  overCautious: CaseResult[];
  unverifiedCount: number;
  distribution: Record<string, number>;
  expectedDistribution: Record<string, number>;
  results: CaseResult[];
}

/** Converts a fixture's evidence into the pipeline's EvidenceItem shape. */
export function toEvidenceItems(c: GoldenCase): EvidenceItem[] {
  return c.evidence.map((e, i) => ({
    position: i + 1,
    url: e.url,
    title: `${e.publisher} — fixture`,
    publisher: e.publisher,
    domain: e.domain,
    tier: e.tier,
    publishedAt: e.publishedAt,
    accessedAt: '2026-08-08T00:00:00.000Z',
    stance: e.stance,
    quotedPassage: e.passage,
    readMethod: e.readMethod ?? 'full_page',
    injectionFlagged: e.injectionPayload === true,
    syndicationGroup: e.syndicationGroup,
    loadBearing: true,
  }));
}

export type Evaluator = (c: GoldenCase) => {
  verdict: Verdict;
  strength?: string;
  independentDomainCount: number;
};

export function runGoldenSet(cases: GoldenCase[], evaluate: Evaluator): GoldenReport {
  const results: CaseResult[] = cases.map((c) => {
    const out = evaluate(c);
    const pass = out.verdict === c.expectedVerdict;
    const confidentlyWrong = isConfidentlyWrong(c.expectedVerdict, out.verdict);

    return {
      id: c.id,
      expected: c.expectedVerdict,
      actual: out.verdict,
      proposed: c.modelProposal,
      pass,
      confidentlyWrong,
      // Answered "not enough evidence" when the case was establishable.
      overCautious: !pass && out.verdict === 'unverified' && c.expectedVerdict !== 'unverified',
      strength: out.strength,
      sourceCount: c.evidence.length,
      independentDomainCount: out.independentDomainCount,
      tags: c.tags,
      reason: c.expectedReason,
    };
  });

  const count = (list: CaseResult[], key: 'actual' | 'expected') =>
    list.reduce<Record<string, number>>((acc, r) => {
      acc[r[key]] = (acc[r[key]] ?? 0) + 1;
      return acc;
    }, {});

  return {
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    confidentlyWrong: results.filter((r) => r.confidentlyWrong),
    overCautious: results.filter((r) => r.overCautious),
    unverifiedCount: results.filter((r) => r.actual === 'unverified').length,
    distribution: count(results, 'actual'),
    expectedDistribution: count(results, 'expected'),
    results,
  };
}

/** Human-readable report, printed by both the baseline and the final run. */
export function formatReport(title: string, report: GoldenReport): string {
  const lines: string[] = [
    '',
    '='.repeat(74),
    `  ${title}`,
    '='.repeat(74),
    `  total cases            ${report.total}`,
    `  passed                 ${report.passed}  (${((report.passed / report.total) * 100).toFixed(1)}%)`,
    `  failed                 ${report.failed}`,
    `  answered UNVERIFIED    ${report.unverifiedCount}`,
    '',
    `  DANGEROUS false positives (confidently wrong)  ${report.confidentlyWrong.length}`,
    `  over-cautious misses (safe)                    ${report.overCautious.length}`,
    '',
    '  verdict distribution   actual  /  expected',
  ];

  for (const v of ['true', 'false', 'partly_true', 'misleading', 'unverified', 'needs_context']) {
    lines.push(
      `    ${v.padEnd(16)} ${String(report.distribution[v] ?? 0).padStart(6)}  /  ${String(
        report.expectedDistribution[v] ?? 0,
      ).padStart(6)}`,
    );
  }

  if (report.confidentlyWrong.length > 0) {
    lines.push('', '  DANGEROUS — asserted a definite verdict and was wrong:');
    for (const r of report.confidentlyWrong) {
      lines.push(`    ${r.id.padEnd(38)} expected ${r.expected.padEnd(14)} got ${r.actual}`);
    }
  }

  if (report.overCautious.length > 0) {
    lines.push('', '  Over-cautious (acceptable, but tracked):');
    for (const r of report.overCautious) {
      lines.push(`    ${r.id.padEnd(38)} expected ${r.expected.padEnd(14)} got ${r.actual}`);
    }
  }

  const otherFailures = report.results.filter(
    (r) => !r.pass && !r.confidentlyWrong && !r.overCautious,
  );
  if (otherFailures.length > 0) {
    lines.push('', '  Other mismatches:');
    for (const r of otherFailures) {
      lines.push(`    ${r.id.padEnd(38)} expected ${r.expected.padEnd(14)} got ${r.actual}`);
    }
  }

  lines.push('='.repeat(74), '');
  return lines.join('\n');
}
