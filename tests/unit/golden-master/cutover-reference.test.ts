/**
 * `cutover-reference.ts` compares a run's failing id set with the recorded
 * reference (`cutover-reference.json`). This proves the comparison (identical,
 * new, vanished, totals drift), the file contract (schema, sorted ids, absent
 * file → no comparison), `toReference` (what the record script writes, with
 * `RunSummary` pinned assignable to its input), the summary wiring (a
 * classification, never a gate) and pins the committed reference to the
 * corpus: every recorded id is a corpus case, and the recorded count is the
 * recorded `fail`.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCorpus } from '../../golden-master/corpus.js';
import {
  compareToReference,
  DEFAULT_REFERENCE_PATH,
  describeReferenceComparison,
  loadReference,
  loadReferenceIfPresent,
  resolveReferencePath,
  toReference,
  validateReference,
  type CutoverReference,
  type RecordableSummary,
} from '../../golden-master/cutover-reference.js';
import {
  buildSummary,
  renderSummaryMarkdown,
  type CaseReport,
} from '../../golden-master/report.js';

const KEY = `${'a'.repeat(64)}:${'b'.repeat(64)}`;

function report(overrides: Partial<CaseReport>): CaseReport {
  const side = {
    url: 'http://x/graphql',
    finalUrl: 'http://x/graphql',
    status: 200,
    durationMs: 1,
    errors: [],
    rootShape: {},
  };
  return {
    runId: 'run-x',
    id: 'case-a',
    key: KEY,
    documentHash: 'a'.repeat(64),
    variablesHash: 'b'.repeat(64),
    operationName: 'Q',
    status: 'live',
    source: 'src/a.ts:1-2',
    baselineUrl: 'http://b/graphql',
    targetUrl: 'http://t/api/v1/graphql',
    sides: { baseline: side, target: side },
    recordedAt: '2026-09-16T00:00:00.000Z',
    verdict: 'pass',
    defects: [],
    counts: { 'contract-break': 0, 'data-parity': 0, rounding: 0 },
    hidden: { 'contract-break': 0, 'data-parity': 0, rounding: 0 },
    leavesCompared: 10,
    blocking: [],
    allowed: [],
    allowedByEntry: [],
    allowedEntryIds: [],
    informational: [],
    warnings: [],
    baselineErrors: [],
    targetErrors: [],
    durationMs: { baseline: 1, target: 2 },
    ...overrides,
  };
}

function failing(id: string): CaseReport {
  return report({
    id,
    verdict: 'fail',
    counts: { 'contract-break': 1, 'data-parity': 0, rounding: 0 },
    blocking: [
      {
        class: 'contract-break',
        kind: 'type-change',
        path: '$.data.x',
        expected: 1,
        actual: '1',
        message: 'type changed',
      },
    ],
  });
}

const REFERENCE: CutoverReference = {
  recordedAt: '2026-09-16T14:41:29.864Z',
  runId: '2026-09-16T14-40-55-349Z-c25e1de2',
  baselineUrl: 'https://baseline/graphql',
  targetUrl: 'https://target/api/v1/graphql',
  targetImage: '8f498efa7360e3582a244dc0b62fe7351d361693',
  provenance: 'test',
  totals: {
    cases: 3,
    fail: 2,
    leavesCompared: 30,
    differences: { 'contract-break': 2, 'data-parity': 0, rounding: 0 },
  },
  failingCaseIds: ['case-a', 'case-b'],
};

const runTotals = (fail: number, leavesCompared = 30, contractBreak = fail) => ({
  cases: 3,
  fail,
  leavesCompared,
  differences: { 'contract-break': contractBreak, 'data-parity': 0, rounding: 0 },
});

describe('compareToReference', () => {
  it('reports an identical set with unchanged totals', () => {
    const comparison = compareToReference(
      { failingCaseIds: ['case-b', 'case-a'], totals: runTotals(2) },
      REFERENCE
    );
    expect(comparison.identical).toBe(true);
    expect(comparison.onlyInRun).toEqual([]);
    expect(comparison.onlyInReference).toEqual([]);
    expect(comparison.totalsIdentical).toBe(true);
    expect(comparison.recordedAt).toBe(REFERENCE.recordedAt);
    expect(comparison.targetImage).toBe(REFERENCE.targetImage);
    expect(describeReferenceComparison(comparison)).toBe(
      'failing set identical to the recorded reference; totals unchanged (reference run 2026-09-16T14-40-55-349Z-c25e1de2, target image 8f498efa7360e3582a244dc0b62fe7351d361693)'
    );
  });

  it('names the ids only in this run and only in the reference, sorted', () => {
    const comparison = compareToReference(
      { failingCaseIds: ['case-z', 'case-a', 'case-c'], totals: runTotals(3) },
      REFERENCE
    );
    expect(comparison.identical).toBe(false);
    expect(comparison.onlyInRun).toEqual(['case-c', 'case-z']);
    expect(comparison.onlyInReference).toEqual(['case-b']);
    expect(describeReferenceComparison(comparison)).toContain(
      'differs from the recorded reference (only in this run: case-c, case-z; only in the reference: case-b)'
    );
  });

  it('flags totals drift even when the id set is identical', () => {
    const comparison = compareToReference(
      { failingCaseIds: ['case-a', 'case-b'], totals: runTotals(2, 31) },
      REFERENCE
    );
    expect(comparison.identical).toBe(true);
    expect(comparison.totalsIdentical).toBe(false);
    expect(comparison.totals.recorded.leavesCompared).toBe(30);
    expect(comparison.totals.run.leavesCompared).toBe(31);
    expect(describeReferenceComparison(comparison)).toContain(
      'totals drifted (recorded fail 2 / leaves 30 / contract-break 2, data-parity 0, rounding 0; this run fail 2 / leaves 31 / contract-break 2, data-parity 0, rounding 0)'
    );
  });
});

describe('the reference file', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('rejects a file that does not match the schema or is unsorted', () => {
    expect(() => validateReference({ ...REFERENCE, targetImage: 'not-a-sha' })).toThrow(
      /cutover reference is invalid/
    );
    expect(() => validateReference({ ...REFERENCE, failingCaseIds: ['case-b', 'case-a'] })).toThrow(
      /must be sorted/
    );
    expect(() => validateReference({ ...REFERENCE, failingCaseIds: ['case-a', 'case-a'] })).toThrow(
      /cutover reference is invalid/
    );
    expect(() => validateReference({ ...REFERENCE, extra: true })).toThrow(
      /cutover reference is invalid/
    );
    expect(validateReference(REFERENCE)).toEqual(REFERENCE);
  });

  it('resolves TEST_GM_REFERENCE_PATH over the committed file and treats a missing file as no reference', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-reference-'));
    const custom = path.join(dir, 'reference.json');
    expect(resolveReferencePath({})).toBe(DEFAULT_REFERENCE_PATH);
    expect(resolveReferencePath({ TEST_GM_REFERENCE_PATH: '' })).toBe(DEFAULT_REFERENCE_PATH);
    expect(resolveReferencePath({ TEST_GM_REFERENCE_PATH: custom })).toBe(custom);
    expect(loadReferenceIfPresent(custom)).toBeNull();
    writeFileSync(custom, `${JSON.stringify(REFERENCE)}\n`, 'utf8');
    expect(loadReferenceIfPresent(custom)).toEqual(REFERENCE);
    expect(loadReference(custom)).toEqual(REFERENCE);
  });

  it('the committed reference is valid, corpus-backed and self-consistent', () => {
    expect(existsSync(DEFAULT_REFERENCE_PATH)).toBe(true);
    const committed = loadReference(DEFAULT_REFERENCE_PATH);
    const corpusIds = new Set(loadCorpus().map((entry) => entry.id));
    const unknown = committed.failingCaseIds.filter((id) => !corpusIds.has(id));
    expect(unknown).toEqual([]);
    expect(committed.failingCaseIds).toHaveLength(committed.totals.fail);
    expect(committed.totals.cases).toBeGreaterThanOrEqual(committed.totals.fail);
    expect(committed.totals.cases).toBeLessThanOrEqual(corpusIds.size);
  });
});

describe('toReference (what the record script writes)', () => {
  const base = {
    reportDir: '/tmp/gm',
    runId: 'run-r',
    planned: null,
    allowlist: [],
    staleAllowlistEntries: [],
    strictAllowlist: true,
    now: new Date('2026-09-16T14:41:29.864Z'),
  };

  it('records a summary as a valid reference: sorted unique ids, totals, urls, generatedAt', () => {
    // A RunSummary must stay assignable to RecordableSummary (compile-time link
    // between report.ts and the record script).
    const summary: RecordableSummary = buildSummary({
      ...base,
      reports: [failing('case-b'), failing('case-a'), report({ id: 'case-c' })],
    });
    const recorded = toReference(summary, 'abc1234', 'why');
    expect(recorded).toEqual({
      recordedAt: '2026-09-16T14:41:29.864Z',
      runId: 'run-r',
      baselineUrl: 'http://b/graphql',
      targetUrl: 'http://t/api/v1/graphql',
      targetImage: 'abc1234',
      provenance: 'why',
      totals: {
        cases: 3,
        fail: 2,
        leavesCompared: 30,
        differences: { 'contract-break': 2, 'data-parity': 0, rounding: 0 },
      },
      failingCaseIds: ['case-a', 'case-b'],
    });
    expect(compareToReference(recorded, recorded).identical).toBe(true);
  });

  it('refuses a summary whose failing ids do not match its fail total, an empty run, or a bad image', () => {
    const summary = buildSummary({ ...base, reports: [failing('case-a')] });
    expect(() =>
      toReference({ ...summary, totals: { ...summary.totals, fail: 2 } }, 'abc1234', 'why')
    ).toThrow(/1 distinct failing id\(s\) but totals.fail is 2/);
    expect(() =>
      toReference(
        { ...summary, failing: [...summary.failing, ...summary.failing] },
        'abc1234',
        'why'
      )
    ).not.toThrow();
    expect(() => toReference(buildSummary({ ...base, reports: [] }), 'abc1234', 'why')).toThrow(
      /compared no case/
    );
    expect(() => toReference(summary, 'not-a-sha', 'why')).toThrow(/cutover reference is invalid/);
  });
});

describe('summary wiring', () => {
  const base = {
    reportDir: '/tmp/gm',
    runId: 'run-x',
    planned: null,
    allowlist: [],
    staleAllowlistEntries: [],
    strictAllowlist: true,
  };
  const reports = [failing('case-a'), failing('case-b'), report({ id: 'case-c' })];

  it('carries the comparison in summary.json and summary.md, never in ok', () => {
    const summary = buildSummary({ ...base, reports, reference: REFERENCE });
    expect(summary.referenceComparison?.identical).toBe(true);
    expect(summary.referenceComparison?.totalsIdentical).toBe(true);
    expect(summary.ok).toBe(false);
    const markdown = renderSummaryMarkdown(summary, reports);
    expect(markdown).toContain('- Reference set: **identical**');
    expect(markdown).toContain(
      '## Failing set versus the recorded reference (identical; recorded 2026-09-16T14:41:29.864Z)'
    );
    expect(markdown).toContain(
      '- failing set identical to the recorded reference; totals unchanged'
    );

    const drifted = buildSummary({ ...base, reports: [failing('case-a')], reference: REFERENCE });
    expect(drifted.referenceComparison?.identical).toBe(false);
    expect(drifted.referenceComparison?.onlyInReference).toEqual(['case-b']);
    const driftedMarkdown = renderSummaryMarkdown(drifted, [failing('case-a')]);
    expect(driftedMarkdown).toContain('- Reference set: **DIFFERENT; totals drifted**');
    expect(driftedMarkdown).toContain(
      '## Failing set versus the recorded reference (DIFFERENT; totals drifted;'
    );
  });

  it('is null when there is no reference, and the section is absent', () => {
    const summary = buildSummary({ ...base, reports });
    expect(summary.referenceComparison).toBeNull();
    expect(renderSummaryMarkdown(summary, reports)).not.toContain('recorded reference');
    expect(JSON.stringify(summary)).toContain('"referenceComparison":null');
  });
});
