import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSummary,
  createRunDir,
  innermostArrayPath,
  listingOf,
  MAX_LISTED_PER_ARRAY,
  newRunId,
  readCaseReports,
  readPlanned,
  reconcile,
  renderSummaryMarkdown,
  resolveReportDir,
  resolveRunId,
  summarizeDeltas,
  truncateForListing,
  writeCaseReport,
  writePlanned,
  writeSummary,
  type CaseReport,
} from '../../golden-master/report.js';

import type { AllowlistEntry } from '../../golden-master/allowlist.js';
import type { Difference } from '../../golden-master/compare.js';

const KEY = `${'a'.repeat(64)}:${'b'.repeat(64)}`;

function report(overrides: Partial<CaseReport>): CaseReport {
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
    sides: {
      baseline: {
        url: 'http://b/graphql',
        finalUrl: 'http://b/graphql',
        status: 200,
        durationMs: 1,
        errors: [],
        rootShape: { entities: { kind: 'connection', length: 3, totalCount: '3' } },
      },
      target: {
        url: 'http://t/api/v1/graphql',
        finalUrl: 'http://t/api/v1/graphql',
        status: 200,
        durationMs: 2,
        errors: [],
        rootShape: { entities: { kind: 'connection', length: 3, totalCount: '3' } },
      },
    },
    recordedAt: '2026-09-02T00:00:00.000Z',
    verdict: 'pass',
    defects: [],
    counts: { 'contract-break': 0, 'data-parity': 0, rounding: 0 },
    hidden: { 'contract-break': 0, 'data-parity': 0, rounding: 0 },
    leavesCompared: 9,
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

const STALE_ENTRY: AllowlistEntry = {
  type: 'pinned',
  key: KEY,
  path: '$.data.gone',
  kind: 'value-change',
  before: 1,
  after: 2,
  reason: 'old',
};
const DRIFT_ENTRY: AllowlistEntry = {
  type: 'drift',
  deltaId: 'f0-aggregated',
  root: 'aggregatedLineItems',
  pathPattern: 'nodes[*].amount',
  kind: 'value-drift',
  explanation: 'Chronos re-statements',
};
const DRIFT_ENTRY_ID = 'drift|f0-aggregated|aggregatedLineItems|nodes[*].amount|value-drift';

describe('golden-master report', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '' && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('resolves the report dir and run id from the environment; fresh ids carry a random nonce', () => {
    expect(resolveReportDir({ TEST_GM_REPORT_DIR: '/tmp/x' })).toBe(path.resolve('/tmp/x'));
    expect(resolveReportDir({})).toMatch(/tests[/\\]golden-master[/\\]reports$/);
    expect(resolveRunId({ TEST_GM_RUN_ID: 'fixed' })).toBe('fixed');
    expect(resolveRunId({})).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/);
    const now = new Date('2026-09-02T10:00:00.000Z');
    expect(newRunId(now)).not.toBe(newRunId(now));
  });

  it('creates the run directory exclusively and refuses a reused run id', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-report-'));
    const created = createRunDir(dir, 'run-once');
    expect(existsSync(created)).toBe(true);
    expect(() => createRunDir(dir, 'run-once')).toThrow(/already exists: .* single-use/);
  });

  it('writes case files and reads them back in id order', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-report-'));
    writeCaseReport(report({ id: 'zeta' }), dir);
    writeCaseReport(
      report({
        id: 'alpha',
        verdict: 'fail',
        blocking: [
          { class: 'contract-break', kind: 'missing-key', path: '$.data.x', message: 'm' },
        ],
        counts: { 'contract-break': 1, 'data-parity': 0, rounding: 0 },
      }),
      dir
    );
    const reports = readCaseReports(dir, 'run-x');
    expect(reports.map((r) => r.id)).toEqual(['alpha', 'zeta']);
    expect(readCaseReports(dir, 'other-run')).toEqual([]);
  });

  it('keeps two reports with the same id but different document/variables (legacy multi-query tests)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-report-'));
    const first = writeCaseReport(
      report({ id: 'ins - two selectors', documentHash: 'doc1', variablesHash: 'varsA' }),
      dir
    );
    const second = writeCaseReport(
      report({ id: 'ins - two selectors', documentHash: 'doc1', variablesHash: 'varsB' }),
      dir
    );
    expect(first).not.toBe(second);
    expect(path.basename(first)).toBe('ins_-_two_selectors.doc1-varsA.json');
    expect(readCaseReports(dir, 'run-x').map((r) => r.variablesHash)).toEqual(['varsA', 'varsB']);
    // Same id + same key → same file (idempotent re-run), not a third file.
    writeCaseReport(
      report({ id: 'ins - two selectors', documentHash: 'doc1', variablesHash: 'varsB' }),
      dir
    );
    expect(readCaseReports(dir, 'run-x')).toHaveLength(2);
  });

  it('registers planned cases per spec and reconciles them against the executed reports', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-report-'));
    writePlanned(dir, 'run-x', 'specs/a', ['a', 'b']);
    writePlanned(dir, 'run-x', 'specs/c', ['c']);
    writePlanned(dir, 'run-x', 'specs/a', ['a', 'b']); // re-collection replaces, not duplicates
    const planned = readPlanned(dir, 'run-x');
    expect(planned?.specs.map((s) => s.spec).sort()).toEqual(['specs/a', 'specs/c']);

    const full = reconcile(planned, [
      report({ id: 'a' }),
      report({ id: 'b' }),
      report({ id: 'c' }),
    ]);
    expect(full).toEqual({ planned: 3, executed: 3, missing: [], unplanned: [], ok: true });

    const partial = reconcile(planned, [report({ id: 'a' }), report({ id: 'zzz' })]);
    expect(partial).toEqual({
      planned: 3,
      executed: 2,
      missing: ['b', 'c'],
      unplanned: ['zzz'],
      ok: false,
    });

    expect(reconcile(null, [report({ id: 'a' })])).toMatchObject({ planned: null, ok: true });
  });

  it('builds totals, the failing list, reconciliation and stale entries into the summary', () => {
    const reports = [
      report({ id: 'a' }),
      report({
        id: 'b',
        verdict: 'pass-with-warnings',
        counts: { 'contract-break': 0, 'data-parity': 1, rounding: 2 },
        hidden: { 'contract-break': 0, 'data-parity': 1, rounding: 0 },
        warnings: [
          { kind: 'extra-key', path: '$.data.k', message: 'm' },
          { kind: 'baseline-empty', path: '$.data', message: 'm' },
        ],
      }),
      report({
        id: 'c',
        status: 'invalid-today',
        verdict: 'fail',
        defects: [{ kind: 'baseline-unexpectedly-valid', message: 'stale' }],
        blocking: [
          { class: 'contract-break', kind: 'errors-missing', path: '$.errors', message: 'm' },
        ],
        counts: { 'contract-break': 1, 'data-parity': 0, rounding: 0 },
      }),
    ];
    const summary = buildSummary({
      reportDir: '/r',
      runId: 'run-x',
      reports,
      planned: { specs: [{ spec: 's', caseIds: ['a', 'b', 'c'] }] },
      allowlist: [STALE_ENTRY],
      staleAllowlistEntries: [STALE_ENTRY],
      strictAllowlist: true,
      now: new Date('2026-09-02T10:00:00Z'),
    });
    expect(summary.totals).toEqual({
      cases: 3,
      pass: 1,
      passWithWarnings: 1,
      fail: 1,
      byStatus: { live: 2, dead: 0, 'invalid-today': 1 },
      differences: { 'contract-break': 1, 'data-parity': 1, rounding: 2 },
      hidden: { 'contract-break': 0, 'data-parity': 1, rounding: 0 },
      leavesCompared: 27,
      extraKeyWarnings: 1,
      baselineEmpty: 1,
      defects: 1,
    });
    expect(summary.reconciliation.ok).toBe(true);
    expect(summary.deltas).toEqual([]);
    expect(summary.failing).toEqual([
      {
        id: 'c',
        key: KEY,
        file: `c.${'a'.repeat(8)}-${'b'.repeat(8)}.json`,
        reasons: [
          'baseline-unexpectedly-valid: stale',
          'contract-break/errors-missing at $.errors',
        ],
      },
    ]);
    expect(summary.ok).toBe(false);

    const markdown = renderSummaryMarkdown(summary, reports);
    expect(markdown).toContain('# Golden Master cutover report — run run-x');
    expect(markdown).toContain('| 3 | 1 | 1 | 1 | 1 | 1 | 2 | 1 | 27 | 1 | 1 | 1 |');
    expect(markdown).toContain('### c');
    expect(markdown).toContain(
      'Stale allowlist entries (matched no difference in this run) — FAIL (strict)'
    );
    expect(markdown).toContain('$.data.gone value-change: old');
    expect(markdown).toContain('entities[3/3]');
  });

  it('aggregates allowlisted differences per entry across cases with the largest relative difference', () => {
    const reports = [
      report({
        id: 'a',
        verdict: 'pass-with-warnings',
        counts: { 'contract-break': 0, 'data-parity': 3, rounding: 0 },
        allowedByEntry: [
          {
            entryId: DRIFT_ENTRY_ID,
            type: 'drift',
            deltaId: 'f0-aggregated',
            matches: 3,
            maxRelativeDifference: 0.05,
            maxRelativeDifferencePath: '$.data.aggregatedLineItems.nodes[1].amount',
          },
        ],
        allowedEntryIds: [DRIFT_ENTRY_ID],
      }),
      report({
        id: 'b',
        verdict: 'pass-with-warnings',
        counts: { 'contract-break': 0, 'data-parity': 2, rounding: 0 },
        allowedByEntry: [
          {
            entryId: DRIFT_ENTRY_ID,
            type: 'drift',
            deltaId: 'f0-aggregated',
            matches: 2,
            maxRelativeDifference: 0.5,
            maxRelativeDifferencePath: '$.data.aggregatedLineItems.nodes[0].amount',
          },
        ],
        allowedEntryIds: [DRIFT_ENTRY_ID],
      }),
    ];
    expect(summarizeDeltas(reports, [DRIFT_ENTRY])).toEqual([
      {
        entryId: DRIFT_ENTRY_ID,
        type: 'drift',
        deltaId: 'f0-aggregated',
        description:
          'drift f0-aggregated $.data.aggregatedLineItems.nodes[*].amount value-drift: Chronos re-statements',
        cases: 2,
        matches: 5,
        maxRelativeDifference: 0.5,
        maxRelativeDifferenceAt: 'b $.data.aggregatedLineItems.nodes[0].amount',
      },
    ]);
    const summary = buildSummary({
      reportDir: '/r',
      runId: 'run-x',
      reports,
      planned: null,
      allowlist: [DRIFT_ENTRY],
      staleAllowlistEntries: [],
      strictAllowlist: true,
    });
    expect(summary.ok).toBe(true);
    const markdown = renderSummaryMarkdown(summary, reports);
    expect(markdown).toContain('## Allowlisted differences by entry');
    expect(markdown).toContain('| f0-aggregated | drift |');
    expect(markdown).toContain(
      '| 2 | 5 | 50.0000% | b $.data.aggregatedLineItems.nodes[0].amount |'
    );
    expect(markdown).toContain('| a | live | pass-with-warnings | 200/200 | 0 | 0/3 |');
  });

  it('lists at most MAX_LISTED_PER_ARRAY records per innermost array when writing, with a marker', () => {
    expect(innermostArrayPath('$.data.nodes[3].a[1].b')).toBe('$.data.nodes[3].a');
    expect(innermostArrayPath('$.data.nodes[3].a')).toBe('$.data.nodes');
    expect(innermostArrayPath('$.data.total')).toBeNull();

    const differences: Difference[] = [
      { class: 'data-parity', kind: 'value-change', path: '$.data.total', message: 'm' },
      ...Array.from({ length: 30 }, (_, i) => ({
        class: 'data-parity' as const,
        kind: 'value-change' as const,
        path: `$.data.nodes[${String(i)}].v`,
        message: 'm',
      })),
      { class: 'contract-break', kind: 'missing-key', path: '$.data.nodes[31].k', message: 'm' },
      { class: 'data-parity', kind: 'value-change', path: '$.data.other[0].v', message: 'm' },
    ];
    const truncated = truncateForListing(
      differences,
      (d) => d,
      (marker) => marker
    );
    expect(truncated.listed).toHaveLength(1 + MAX_LISTED_PER_ARRAY + 1 + 1);
    const marker = truncated.listed.find((d) => d.kind === 'array-diff-truncated');
    expect(marker).toMatchObject({
      class: 'contract-break',
      path: '$.data.nodes',
      expected: { 'contract-break': 1, 'data-parity': 5, rounding: 0 },
      actual: ['missing-key', 'value-change'],
    });
    expect(truncated.hidden).toEqual({ 'contract-break': 1, 'data-parity': 5, rounding: 0 });

    const full = report({
      blocking: differences,
      counts: { 'contract-break': 1, 'data-parity': 32, rounding: 0 },
    });
    const listing = listingOf(full);
    expect(listing.blocking).toHaveLength(28);
    expect(listing.hidden).toEqual({ 'contract-break': 1, 'data-parity': 5, rounding: 0 });
    expect(listing.counts).toEqual(full.counts);
  });

  it('is OK only when no case failed, planned == executed and (strict) no entry is stale', () => {
    const base = {
      reportDir: '/r',
      runId: 'run-x',
      reports: [report({ id: 'a' })],
      planned: { specs: [{ spec: 's', caseIds: ['a'] }] },
      allowlist: [STALE_ENTRY],
    };
    expect(buildSummary({ ...base, staleAllowlistEntries: [], strictAllowlist: true }).ok).toBe(
      true
    );
    expect(
      buildSummary({ ...base, staleAllowlistEntries: [STALE_ENTRY], strictAllowlist: true }).ok
    ).toBe(false);
    expect(
      buildSummary({ ...base, staleAllowlistEntries: [STALE_ENTRY], strictAllowlist: false }).ok
    ).toBe(true);
    expect(
      buildSummary({
        ...base,
        planned: { specs: [{ spec: 's', caseIds: ['a', 'b'] }] },
        staleAllowlistEntries: [],
        strictAllowlist: true,
      }).ok
    ).toBe(false);
  });

  it('writes summary.json and summary.md next to the case files, or nothing without cases or plan', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-report-'));
    expect(
      writeSummary({
        reportDir: dir,
        runId: 'run-x',
        allowlist: [],
        staleAllowlistEntries: [],
        strictAllowlist: true,
      })
    ).toBeNull();

    writeCaseReport(report({ id: 'only' }), dir);
    const written = writeSummary({
      reportDir: dir,
      runId: 'run-x',
      allowlist: [],
      staleAllowlistEntries: [],
      strictAllowlist: true,
    });
    expect(written?.jsonPath).toBe(path.join(dir, 'run-x', 'summary.json'));
    expect(readFileSync(written!.markdownPath, 'utf8')).toContain('| only | live | pass |');
    expect(written?.summary.reconciliation.planned).toBeNull();
  });
});
