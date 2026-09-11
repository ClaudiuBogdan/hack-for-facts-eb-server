/**
 * `kernel-roots.ts` is the harness's literal knowledge of which corpus roots
 * the kernel serves. This pins it to the modules' own constants (a root
 * mounted or dropped in a module fails here until the list follows) and
 * proves the classification rule: every failing kernel-rooted case is listed,
 * partly allowlisted ones with a marker, and the listing is not a second gate.
 */

import { describe, expect, it } from 'vitest';

import { BUDGET_GROUPED_ROOTS } from '@/modules/budget/shell/graphql/legacy/grouped-typedefs.js';
import { BUDGET_LEGACY_ROOTS } from '@/modules/budget/shell/graphql/legacy/typedefs.js';
import { INS_LEGACY_ROOTS } from '@/modules/ins-native/index.js';

import {
  documentRoots,
  findUncoveredKernelCases,
  isKernelRootedDocument,
  KERNEL_LEGACY_ROOTS,
} from '../../golden-master/kernel-roots.js';
import {
  buildSummary,
  renderSummaryMarkdown,
  type CaseReport,
} from '../../golden-master/report.js';

const key = (n: number): string => `${String(n).repeat(64)}:${'b'.repeat(64)}`;

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
    id: 'case',
    key: key(1),
    documentHash: '1'.repeat(64),
    variablesHash: 'b'.repeat(64),
    operationName: 'Q',
    status: 'live',
    source: 'src/a.ts:1-2',
    baselineUrl: side.url,
    targetUrl: side.url,
    sides: { baseline: side, target: side },
    recordedAt: '2026-09-11T00:00:00.000Z',
    verdict: 'fail',
    defects: [],
    counts: { 'contract-break': 0, 'data-parity': 1, rounding: 0 },
    hidden: { 'contract-break': 0, 'data-parity': 0, rounding: 0 },
    leavesCompared: 1,
    blocking: [
      {
        class: 'data-parity',
        kind: 'value-change',
        path: '$.data.x[0].y',
        expected: '1',
        actual: '2',
        message: 'value differs',
      },
    ],
    allowed: [],
    allowedByEntry: [],
    allowedEntryIds: [],
    informational: [],
    warnings: [],
    baselineErrors: [],
    targetErrors: [],
    durationMs: { baseline: 1, target: 1 },
    ...overrides,
  };
}

const KERNEL_DOC =
  'query Q { insDatasets(limit: 1) { nodes { code } } executionAnalytics(inputs: []) { seriesId } }';
const MIXED_DOC =
  'query Q { uats(limit: 1) { nodes { id } } insDatasets(limit: 1) { nodes { code } } }';

describe('kernel-roots: the harness list follows the modules', () => {
  it('equals the budget legacy + grouped roots and the eight INS roots, exactly', () => {
    const modules = [...BUDGET_LEGACY_ROOTS, ...BUDGET_GROUPED_ROOTS, ...INS_LEGACY_ROOTS];
    expect([...KERNEL_LEGACY_ROOTS].sort()).toEqual([...modules].sort());
    expect(new Set(KERNEL_LEGACY_ROOTS).size).toBe(KERNEL_LEGACY_ROOTS.length);
  });

  it('reads the root fields of a document and classifies it', () => {
    expect(documentRoots(KERNEL_DOC)).toEqual(['insDatasets', 'executionAnalytics']);
    expect(isKernelRootedDocument(KERNEL_DOC)).toBe(true);
    expect(isKernelRootedDocument(MIXED_DOC)).toBe(false);
    expect(isKernelRootedDocument('fragment F on Query { insDatasets { nodes { code } } }')).toBe(
      false
    );
  });
});

describe('kernel-roots: uncovered kernel cases', () => {
  const documents = new Map([
    [key(1), KERNEL_DOC],
    [key(2), MIXED_DOC],
    [key(3), KERNEL_DOC],
    [key(4), KERNEL_DOC],
  ]);
  const reports = [
    report({ id: 'kernel-fail', key: key(1) }),
    report({ id: 'mixed-fail', key: key(2) }),
    report({ id: 'kernel-allowlisted', key: key(3), allowedEntryIds: ['pinned|x|y|z'] }),
    report({ id: 'kernel-pass', key: key(4), verdict: 'pass', blocking: [] }),
    report({ id: 'not-in-corpus', key: key(5) }),
  ];

  it('lists the failing kernel-rooted cases with their reasons, marking the partly allowlisted', () => {
    const uncovered = findUncoveredKernelCases(reports, documents);
    expect(uncovered.map((u) => [u.id, u.partiallyAllowlisted])).toEqual([
      ['kernel-allowlisted', true],
      ['kernel-fail', false],
    ]);
    expect(uncovered[1]).toMatchObject({
      key: key(1),
      roots: ['insDatasets', 'executionAnalytics'],
      reasons: ['data-parity/value-change at $.data.x[0].y'],
    });
  });

  it('partitions the failing set in the summary without becoming a second gate', () => {
    const uncovered = findUncoveredKernelCases(reports, documents);
    const base = {
      reportDir: '/r',
      runId: 'run-x',
      reports,
      planned: null,
      allowlist: [],
      staleAllowlistEntries: [],
      strictAllowlist: true,
    };
    const summary = buildSummary({ ...base, uncoveredKernelCases: uncovered });
    // Four cases fail; two are kernel-rooted (one of them partly allowlisted).
    expect(summary.totals.fail).toBe(4);
    expect(summary.ok).toBe(false);
    expect(summary.uncoveredKernelCases.map((u) => u.id)).toEqual([
      'kernel-allowlisted',
      'kernel-fail',
    ]);
    const markdown = renderSummaryMarkdown(summary, reports);
    expect(markdown).toContain(
      '## Failing cases on kernel-mounted roots without a recorded parity decision (2 of 4)'
    );
    expect(markdown).toContain(
      '- kernel-fail (insDatasets, executionAnalytics): data-parity/value-change at $.data.x[0].y'
    );
    expect(markdown).toContain(
      '- kernel-allowlisted (insDatasets, executionAnalytics) [partly allowlisted]:'
    );

    // Without the classification the summary is unchanged in verdict and omits the section.
    const plain = buildSummary(base);
    expect(plain.ok).toBe(false);
    expect(plain.uncoveredKernelCases).toEqual([]);
    expect(renderSummaryMarkdown(plain, reports)).not.toContain('kernel-mounted roots');
  });
});
