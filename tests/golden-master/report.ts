/**
 * Cutover report writer.
 *
 * Vitest isolates the module graph per test file, so an in-memory list would
 * reset between spec files. Each case result is therefore written to its own
 * JSON file as soon as the comparison completes:
 *
 *   <TEST_GM_REPORT_DIR>/<runId>/cases/<id>.<doc8>-<vars8>.json
 *
 * and the run summary (`summary.json` + `summary.md`) is assembled from those
 * files by the vitest `globalSetup` teardown (`global-setup.ts`), reconciled
 * against `planned.json` (written by the spec at collection time).
 *
 * The classifier returns EVERY difference and the allowlist sees every
 * difference; only what is WRITTEN is bounded: per list and per innermost
 * array, at most `MAX_LISTED_PER_ARRAY` records are listed and the rest are
 * summarised by one `array-diff-truncated` marker (strongest class, kinds,
 * counts). `counts` and `allowedByEntry` are computed over everything;
 * `hidden` counts what the file does not list.
 *
 * The run directory is created EXCLUSIVELY (a reused run id is refused), so a
 * summary can never merge case files of two runs. `TEST_GM_REPORT_DIR`
 * defaults to `tests/golden-master/reports/` (gitignored).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  describeEntry,
  entryId,
  fingerprintOf,
  fingerprintSha256,
  type AllowedDifference,
  type AllowlistEntry,
  type EntryMatchSummary,
} from './allowlist.js';
import {
  emptyTotals,
  type ClassTotals,
  type ComparisonWarning,
  type Difference,
  type DifferenceClass,
  type DifferenceKind,
  type RootFieldShape,
} from './compare.js';

import type { CorpusStatus } from './corpus.js';

// =============================================================================
// Types
// =============================================================================

export type CaseVerdict = 'pass' | 'pass-with-warnings' | 'fail';

/**
 * Defects of the CASE itself, distinct from the three difference classes.
 * Every defect fails the case.
 * - `transport-error`: a side could not be reached or did not answer with a
 *   GraphQL envelope (refused, timeout, redirect, non-JSON, Fastify 404 body,
 *   non-finite number);
 * - `no-data`: a `live`/`dead` case where a side answered without
 *   `200` + non-null `data` + no `errors`;
 * - `baseline-error`: a `live`/`dead` case whose baseline carries `errors[]`
 *   (corpus/variables defect — identical errors on both sides are not
 *   equivalence);
 * - `baseline-unexpectedly-valid`: an `invalid-today` case the baseline now
 *   accepts (the corpus status is stale).
 */
export type CaseDefect =
  'transport-error' | 'no-data' | 'baseline-error' | 'baseline-unexpectedly-valid';

export interface SideReport {
  url: string;
  finalUrl: string | null;
  status: number;
  durationMs: number;
  errors: string[];
  rootShape: Record<string, RootFieldShape>;
}

export interface CaseReport {
  runId: string;
  id: string;
  key: string;
  documentHash: string;
  variablesHash: string;
  operationName: string | null;
  status: CorpusStatus;
  source: string | null;
  baselineUrl: string;
  targetUrl: string;
  sides: { baseline: SideReport; target: SideReport };
  recordedAt: string;
  verdict: CaseVerdict;
  defects: { kind: CaseDefect; message: string }[];
  /** Every difference by class, listed or not. */
  counts: ClassTotals;
  /** Differences the written file does not list (per-array cap). */
  hidden: ClassTotals;
  leavesCompared: number;
  blocking: Difference[];
  allowed: AllowedDifference[];
  /** Per allowlist entry: matches and the largest relative difference. */
  allowedByEntry: EntryMatchSummary[];
  allowedEntryIds: string[];
  informational: Difference[];
  warnings: ComparisonWarning[];
  baselineErrors: string[];
  targetErrors: string[];
  durationMs: { baseline: number; target: number };
}

export interface PlannedFile {
  specs: { spec: string; caseIds: string[] }[];
}

/** Run-wide aggregate of one allowlist entry (a delta id maps to ≥1 entries). */
export interface DeltaSummary {
  entryId: string;
  type: AllowlistEntry['type'];
  deltaId: string | null;
  description: string;
  cases: number;
  matches: number;
  maxRelativeDifference: number | null;
  /** `<case id> <path>` of the largest relative difference. */
  maxRelativeDifferenceAt: string | null;
}

export interface RunSummary {
  runId: string;
  generatedAt: string;
  reportDir: string;
  baselineUrl: string | null;
  targetUrl: string | null;
  strictAllowlist: boolean;
  totals: {
    cases: number;
    pass: number;
    passWithWarnings: number;
    fail: number;
    byStatus: Record<CorpusStatus, number>;
    differences: ClassTotals;
    hidden: ClassTotals;
    leavesCompared: number;
    extraKeyWarnings: number;
    baselineEmpty: number;
    defects: number;
  };
  reconciliation: {
    planned: number | null;
    executed: number;
    missing: string[];
    unplanned: string[];
    ok: boolean;
  };
  failing: { id: string; key: string; file: string; reasons: string[] }[];
  /** Every allowlist entry that matched, with its magnitude. */
  deltas: DeltaSummary[];
  staleAllowlistEntries: AllowlistEntry[];
  /** False when any case failed, the reconciliation failed, or (strict) stale entries exist. */
  ok: boolean;
}

// =============================================================================
// Paths
// =============================================================================

export const DEFAULT_REPORT_DIR = path.resolve(import.meta.dirname, 'reports');

/** Per list and per innermost array, the number of records a case file lists. */
export const MAX_LISTED_PER_ARRAY = 25;
/** Sample lines under the per-entry table in summary.md. */
export const MAX_SAMPLE_LINES = 30;

export function resolveReportDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['TEST_GM_REPORT_DIR'];
  if (configured !== undefined && configured.length > 0) {
    return path.resolve(configured);
  }
  return DEFAULT_REPORT_DIR;
}

/** Run id from the environment (set by global-setup.ts), else a fresh nonce. */
export function resolveRunId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['TEST_GM_RUN_ID'];
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  return newRunId();
}

/** Timestamp for humans + a random nonce so two runs can never collide. */
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

export function runDir(reportDir: string, runId: string): string {
  return path.join(reportDir, runId);
}

function casesDir(reportDir: string, runId: string): string {
  return path.join(runDir(reportDir, runId), 'cases');
}

/**
 * Creates the run directory exclusively. A reused run id is refused so a
 * summary can never merge two runs' case files.
 */
export function createRunDir(reportDir: string, runId: string): string {
  mkdirSync(reportDir, { recursive: true });
  const dir = runDir(reportDir, runId);
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `Golden Master run directory already exists: ${dir} — run ids are single-use (unset TEST_GM_RUN_ID or choose a fresh one)`,
        { cause: error }
      );
    }
    throw error;
  }
  return dir;
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 160);
}

/**
 * Case file name: id + a short document/variables fingerprint. Legacy spec
 * tests may call `client.query()` several times inside one `it` (same vitest
 * test name, different document or variables); the fingerprint keeps those
 * from overwriting each other's report.
 */
export function caseFileName(
  report: Pick<CaseReport, 'id' | 'documentHash' | 'variablesHash'>
): string {
  return `${safeFileName(report.id)}.${report.documentHash.slice(0, 8)}-${report.variablesHash.slice(0, 8)}.json`;
}

// =============================================================================
// Listing bound (write-time only)
// =============================================================================

/** The innermost array a path sits in (`$.data.nodes[3].a[1].b` → `$.data.nodes[3].a`), or null. */
export function innermostArrayPath(differencePath: string): string | null {
  const last = differencePath.lastIndexOf('[');
  return last < 0 ? null : differencePath.slice(0, last);
}

interface Truncated<T> {
  listed: T[];
  hidden: ClassTotals;
}

function strongestClass(totals: ClassTotals): DifferenceClass {
  return totals['contract-break'] > 0
    ? 'contract-break'
    : totals['data-parity'] > 0
      ? 'data-parity'
      : 'rounding';
}

/**
 * Keeps at most `MAX_LISTED_PER_ARRAY` records per innermost array and adds
 * one `array-diff-truncated` marker per array for the remainder. Records
 * outside any array are always listed.
 */
export function truncateForListing<T>(
  items: readonly T[],
  differenceOf: (item: T) => Difference,
  markerOf: (marker: Difference) => T
): Truncated<T> {
  const listed: T[] = [];
  const hidden = emptyTotals();
  const perArray = new Map<
    string,
    { listed: number; hidden: ClassTotals; kinds: Set<DifferenceKind>; markerIndex: number }
  >();

  for (const item of items) {
    const difference = differenceOf(item);
    const arrayPath = innermostArrayPath(difference.path);
    if (arrayPath === null) {
      listed.push(item);
      continue;
    }
    const frame = perArray.get(arrayPath) ?? {
      listed: 0,
      hidden: emptyTotals(),
      kinds: new Set<DifferenceKind>(),
      markerIndex: -1,
    };
    perArray.set(arrayPath, frame);
    if (frame.listed < MAX_LISTED_PER_ARRAY) {
      frame.listed += 1;
      listed.push(item);
      continue;
    }
    frame.hidden[difference.class] += 1;
    frame.kinds.add(difference.kind);
    hidden[difference.class] += 1;
    if (frame.markerIndex < 0) {
      frame.markerIndex = listed.length;
      listed.push(item); // placeholder, replaced below
    }
  }

  for (const [arrayPath, frame] of perArray) {
    if (frame.markerIndex < 0) continue;
    const total =
      frame.hidden['contract-break'] + frame.hidden['data-parity'] + frame.hidden.rounding;
    const kinds = [...frame.kinds].sort();
    listed[frame.markerIndex] = markerOf({
      class: strongestClass(frame.hidden),
      kind: 'array-diff-truncated',
      path: arrayPath,
      expected: { ...frame.hidden },
      actual: kinds,
      message: `${String(MAX_LISTED_PER_ARRAY)} record(s) listed for this array; ${String(total)} more were classified but not listed (contract-break ${String(frame.hidden['contract-break'])}, data-parity ${String(frame.hidden['data-parity'])}, rounding ${String(frame.hidden.rounding)}; kinds ${kinds.join(', ')})`,
    });
  }

  return { listed, hidden };
}

function addTotals(into: ClassTotals, from: ClassTotals): void {
  for (const cls of ['contract-break', 'data-parity', 'rounding'] as const) {
    into[cls] += from[cls];
  }
}

/** The bounded view of a report that goes to disk (`hidden` filled in). */
export function listingOf(report: CaseReport): CaseReport {
  const hidden = emptyTotals();
  const blocking = truncateForListing(
    report.blocking,
    (d) => d,
    (marker) => marker
  );
  addTotals(hidden, blocking.hidden);
  const informational = truncateForListing(
    report.informational,
    (d) => d,
    (marker) => marker
  );
  addTotals(hidden, informational.hidden);
  const allowed = truncateForListing<AllowedDifference>(
    report.allowed,
    (a) => a.difference,
    (marker) => ({
      difference: marker,
      entry: {
        type: 'pinned',
        key: '',
        path: marker.path,
        kind: 'value-change',
        reason: '(marker)',
      },
      relativeDifference: null,
    })
  );
  addTotals(hidden, allowed.hidden);
  return {
    ...report,
    hidden,
    blocking: blocking.listed,
    informational: informational.listed,
    allowed: allowed.listed,
  };
}

// =============================================================================
// Writing
// =============================================================================

export function writeCaseReport(
  report: CaseReport,
  reportDir: string = resolveReportDir()
): string {
  const dir = casesDir(reportDir, report.runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, caseFileName(report));
  writeFileSync(file, `${JSON.stringify(listingOf(report), null, 2)}\n`, 'utf8');
  return file;
}

const PLANNED_FILE = 'planned.json';

/** Registers the cases a spec file intends to execute (merged per spec). */
export function writePlanned(
  reportDir: string,
  runId: string,
  spec: string,
  caseIds: readonly string[]
): string {
  const dir = runDir(reportDir, runId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PLANNED_FILE);
  const current = readPlanned(reportDir, runId) ?? { specs: [] };
  const others = current.specs.filter((entry) => entry.spec !== spec);
  const next: PlannedFile = { specs: [...others, { spec, caseIds: [...caseIds] }] };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return file;
}

const PlannedFileSchema = Type.Object({
  specs: Type.Array(Type.Object({ spec: Type.String(), caseIds: Type.Array(Type.String()) })),
});

export function readPlanned(reportDir: string, runId: string): PlannedFile | null {
  const file = path.join(runDir(reportDir, runId), PLANNED_FILE);
  if (!existsSync(file)) return null;
  // eslint-disable-next-line no-restricted-syntax -- file written by writePlanned above; shape-checked with TypeBox
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Value.Check(PlannedFileSchema, raw)) {
    throw new Error(`Unrecognised planned file: ${file}`);
  }
  return raw;
}

const TotalsSchema = Type.Object({
  'contract-break': Type.Integer(),
  'data-parity': Type.Integer(),
  rounding: Type.Integer(),
});

// A loose schema: enough to reject foreign files, not a full re-validation.
const CaseReportFileSchema = Type.Object({
  runId: Type.String(),
  id: Type.String(),
  key: Type.String(),
  documentHash: Type.String(),
  variablesHash: Type.String(),
  status: Type.String(),
  verdict: Type.String(),
  defects: Type.Array(Type.Object({ kind: Type.String(), message: Type.String() })),
  counts: TotalsSchema,
  hidden: TotalsSchema,
  leavesCompared: Type.Integer(),
  blocking: Type.Array(Type.Unknown()),
  allowed: Type.Array(Type.Unknown()),
  allowedByEntry: Type.Array(
    Type.Object(
      {
        entryId: Type.String(),
        type: Type.String(),
        deltaId: Type.Union([Type.String(), Type.Null()]),
        matches: Type.Integer(),
        maxRelativeDifference: Type.Union([Type.Number(), Type.Null()]),
        maxRelativeDifferencePath: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: true }
    )
  ),
  allowedEntryIds: Type.Array(Type.String()),
  warnings: Type.Array(Type.Object({ kind: Type.String() }, { additionalProperties: true })),
  baselineUrl: Type.String(),
  targetUrl: Type.String(),
  sides: Type.Object({
    baseline: Type.Object({ status: Type.Integer() }, { additionalProperties: true }),
    target: Type.Object({ status: Type.Integer() }, { additionalProperties: true }),
  }),
});

export function readCaseReports(reportDir: string, runId: string): CaseReport[] {
  const dir = casesDir(reportDir, runId);
  if (!existsSync(dir)) return [];
  const reports: CaseReport[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const text = readFileSync(path.join(dir, name), 'utf8');
    // eslint-disable-next-line no-restricted-syntax -- files written by writeCaseReport above; shape-checked with TypeBox
    const raw: unknown = JSON.parse(text);
    if (!Value.Check(CaseReportFileSchema, raw)) {
      throw new Error(`Unrecognised case report file: ${path.join(dir, name)}`);
    }
    reports.push(raw as CaseReport);
  }
  return reports;
}

// =============================================================================
// Summary
// =============================================================================

export function reconcile(
  planned: PlannedFile | null,
  reports: readonly CaseReport[]
): RunSummary['reconciliation'] {
  const executed = new Set(reports.map((r) => r.id));
  if (planned === null) {
    return {
      planned: null,
      executed: reports.length,
      missing: [],
      unplanned: [],
      ok: true,
    };
  }
  const plannedIds = new Set(planned.specs.flatMap((s) => s.caseIds));
  const missing = [...plannedIds].filter((id) => !executed.has(id)).sort();
  const unplanned = [...executed].filter((id) => !plannedIds.has(id)).sort();
  return {
    planned: plannedIds.size,
    executed: reports.length,
    missing,
    unplanned,
    ok: missing.length === 0 && unplanned.length === 0 && plannedIds.size === reports.length,
  };
}

/** Run-wide per-entry aggregates from the per-case `allowedByEntry` blocks. */
export function summarizeDeltas(
  reports: readonly CaseReport[],
  allowlist: readonly AllowlistEntry[]
): DeltaSummary[] {
  const byEntry = new Map<string, DeltaSummary>();
  for (const report of reports) {
    for (const item of report.allowedByEntry) {
      const current = byEntry.get(item.entryId) ?? {
        entryId: item.entryId,
        type: item.type,
        deltaId: item.deltaId,
        description: describeEntryId(item.entryId, allowlist),
        cases: 0,
        matches: 0,
        maxRelativeDifference: null,
        maxRelativeDifferenceAt: null,
      };
      current.cases += 1;
      current.matches += item.matches;
      if (
        item.maxRelativeDifference !== null &&
        (current.maxRelativeDifference === null ||
          item.maxRelativeDifference > current.maxRelativeDifference)
      ) {
        current.maxRelativeDifference = item.maxRelativeDifference;
        current.maxRelativeDifferenceAt = `${report.id} ${item.maxRelativeDifferencePath ?? ''}`;
      }
      byEntry.set(item.entryId, current);
    }
  }
  return [...byEntry.values()].sort((a, b) => (a.entryId < b.entryId ? -1 : 1));
}

function describeEntryId(id: string, allowlist: readonly AllowlistEntry[]): string {
  const entry = allowlist.find((candidate) => entryId(candidate) === id);
  return entry === undefined ? id : describeEntry(entry);
}

export function buildSummary(params: {
  reportDir: string;
  runId: string;
  reports: readonly CaseReport[];
  planned: PlannedFile | null;
  allowlist: readonly AllowlistEntry[];
  staleAllowlistEntries: readonly AllowlistEntry[];
  strictAllowlist: boolean;
  now?: Date;
}): RunSummary {
  const { reports } = params;
  const byStatus: Record<CorpusStatus, number> = { live: 0, dead: 0, 'invalid-today': 0 };
  const differences = emptyTotals();
  const hidden = emptyTotals();
  let pass = 0;
  let passWithWarnings = 0;
  let fail = 0;
  let extraKeyWarnings = 0;
  let baselineEmpty = 0;
  let defects = 0;
  let leavesCompared = 0;
  const failing: RunSummary['failing'] = [];

  for (const report of reports) {
    byStatus[report.status] += 1;
    addTotals(differences, report.counts);
    addTotals(hidden, report.hidden);
    leavesCompared += report.leavesCompared;
    extraKeyWarnings += report.warnings.filter((w) => w.kind !== 'baseline-empty').length;
    baselineEmpty += report.warnings.filter((w) => w.kind === 'baseline-empty').length;
    defects += report.defects.length;
    switch (report.verdict) {
      case 'pass':
        pass += 1;
        break;
      case 'pass-with-warnings':
        passWithWarnings += 1;
        break;
      case 'fail':
        fail += 1;
        failing.push({
          id: report.id,
          key: report.key,
          file: caseFileName(report),
          reasons: [
            ...report.defects.map((defect) => `${defect.kind}: ${defect.message}`),
            ...report.blocking.map(
              (difference) => `${difference.class}/${difference.kind} at ${difference.path}`
            ),
          ],
        });
        break;
    }
  }

  const reconciliation = reconcile(params.planned, reports);
  const first = reports[0];
  const staleBlocks = params.strictAllowlist && params.staleAllowlistEntries.length > 0;
  return {
    runId: params.runId,
    generatedAt: (params.now ?? new Date()).toISOString(),
    reportDir: params.reportDir,
    baselineUrl: first?.baselineUrl ?? null,
    targetUrl: first?.targetUrl ?? null,
    strictAllowlist: params.strictAllowlist,
    totals: {
      cases: reports.length,
      pass,
      passWithWarnings,
      fail,
      byStatus,
      differences,
      hidden,
      leavesCompared,
      extraKeyWarnings,
      baselineEmpty,
      defects,
    },
    reconciliation,
    failing,
    deltas: summarizeDeltas(reports, params.allowlist),
    staleAllowlistEntries: [...params.staleAllowlistEntries],
    ok: fail === 0 && reconciliation.ok && !staleBlocks,
  };
}

function listText(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

function shapeText(shape: Record<string, RootFieldShape>): string {
  return Object.entries(shape)
    .map(([key, s]) => {
      if (s.kind === 'array' || s.kind === 'connection') {
        return `${key}[${String(s.length ?? 0)}${s.totalCount === undefined ? '' : `/${s.totalCount}`}]`;
      }
      return `${key}:${s.kind}`;
    })
    .join(' ');
}

function percentText(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(4)}%`;
}

export function renderSummaryMarkdown(summary: RunSummary, reports: readonly CaseReport[]): string {
  const lines: string[] = [];
  const t = summary.totals;
  lines.push(`# Golden Master cutover report — run ${summary.runId}`);
  lines.push('');
  lines.push(`- Result: **${summary.ok ? 'OK' : 'FAILED'}**`);
  lines.push(`- Generated: ${summary.generatedAt}`);
  lines.push(`- Baseline (expected): ${summary.baselineUrl ?? '(none)'}`);
  lines.push(`- Target (actual): ${summary.targetUrl ?? '(none)'}`);
  lines.push(`- Report dir: ${summary.reportDir}`);
  lines.push(`- Strict allowlist: ${String(summary.strictAllowlist)}`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(
    '| Cases | Pass | Pass w/ warnings | Fail | Contract breaks | Data parity | Rounding | Not listed (in markers) | Leaves compared | Extra-key warnings | Baseline empty | Case defects |'
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  lines.push(
    `| ${String(t.cases)} | ${String(t.pass)} | ${String(t.passWithWarnings)} | ${String(t.fail)} | ${String(t.differences['contract-break'])} | ${String(t.differences['data-parity'])} | ${String(t.differences.rounding)} | ${String(t.hidden['contract-break'] + t.hidden['data-parity'] + t.hidden.rounding)} | ${String(t.leavesCompared)} | ${String(t.extraKeyWarnings)} | ${String(t.baselineEmpty)} | ${String(t.defects)} |`
  );
  lines.push('');
  lines.push(
    `By status: live ${String(t.byStatus.live)}, invalid-today ${String(t.byStatus['invalid-today'])}, dead ${String(t.byStatus.dead)}`
  );
  const r = summary.reconciliation;
  lines.push('');
  lines.push(
    r.planned === null
      ? `Reconciliation: no planned.json (unplanned run, e.g. the extended legacy specs) — ${String(r.executed)} case(s) executed`
      : `Reconciliation: planned ${String(r.planned)}, executed ${String(r.executed)} — ${r.ok ? 'OK' : `MISMATCH (missing: ${listText(r.missing)}; unplanned: ${listText(r.unplanned)})`}`
  );
  lines.push('');

  if (summary.failing.length > 0) {
    lines.push('## Failing cases');
    lines.push('');
    for (const failing of summary.failing) {
      lines.push(`### ${failing.id}`);
      lines.push('');
      lines.push(`key: \`${failing.key}\``);
      lines.push('');
      for (const reason of failing.reasons.slice(0, 40)) {
        lines.push(`- ${reason}`);
      }
      if (failing.reasons.length > 40) {
        lines.push(`- … ${String(failing.reasons.length - 40)} more (see cases/${failing.file})`);
      }
      lines.push('');
    }
  }

  if (summary.staleAllowlistEntries.length > 0) {
    lines.push(
      `## Stale allowlist entries (matched no difference in this run)${summary.strictAllowlist ? ' — FAIL (strict)' : ''}`
    );
    lines.push('');
    for (const entry of summary.staleAllowlistEntries) {
      lines.push(`- ${describeEntry(entry)}`);
    }
    lines.push('');
  }

  if (summary.deltas.length > 0) {
    lines.push('## Allowlisted differences by entry');
    lines.push('');
    lines.push('| Delta id | Type | Entry | Cases | Matches | Largest relative difference | At |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const delta of summary.deltas) {
      lines.push(
        `| ${delta.deltaId ?? '(pinned)'} | ${delta.type} | ${delta.description.replace(/\|/g, '\\|')} | ${String(delta.cases)} | ${String(delta.matches)} | ${percentText(delta.maxRelativeDifference)} | ${delta.maxRelativeDifferenceAt ?? ''} |`
      );
    }
    lines.push('');
    lines.push(`Samples (first listed per case, at most ${String(MAX_SAMPLE_LINES)} lines):`);
    lines.push('');
    let samples = 0;
    for (const rep of reports) {
      for (const a of rep.allowed.slice(0, 3)) {
        if (a.difference.kind === 'array-diff-truncated' || samples >= MAX_SAMPLE_LINES) continue;
        samples += 1;
        lines.push(
          `- ${rep.id} ${a.difference.path} ${a.difference.kind} (rel ${percentText(a.relativeDifference)}; before ${fingerprintSha256(a.difference.expected).slice(0, 12)}…, after ${fingerprintSha256(a.difference.actual).slice(0, 12)}…)`
        );
      }
    }
    lines.push('');
  }

  lines.push('## All cases');
  lines.push('');
  lines.push(
    '| Case | Status | Verdict | HTTP b/t | Contract | Parity (blocking/allowed) | Rounding | Leaves | Baseline root shape | Extra keys | Defects |'
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const report of reports) {
    const allowedCount = report.allowedByEntry.reduce((sum, e) => sum + e.matches, 0);
    const parityBlocking = report.counts['data-parity'] - allowedCount;
    lines.push(
      `| ${report.id} | ${report.status} | ${report.verdict} | ${String(report.sides.baseline.status)}/${String(report.sides.target.status)} | ${String(report.counts['contract-break'])} | ${String(parityBlocking)}/${String(allowedCount)} | ${String(report.counts.rounding)} | ${String(report.leavesCompared)} | ${shapeText(report.sides.baseline.rootShape)} | ${String(report.warnings.filter((w) => w.kind !== 'baseline-empty').length)} | ${String(report.defects.length)} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Fingerprint texts a reviewer can paste into a pinned allowlist entry. */
export function describeDifferenceFingerprints(difference: Difference): {
  before: string;
  after: string;
  beforeSha256: string;
  afterSha256: string;
} {
  return {
    before: fingerprintOf(difference.expected),
    after: fingerprintOf(difference.actual),
    beforeSha256: fingerprintSha256(difference.expected),
    afterSha256: fingerprintSha256(difference.actual),
  };
}

export function writeSummary(params: {
  reportDir: string;
  runId: string;
  allowlist: readonly AllowlistEntry[];
  staleAllowlistEntries: readonly AllowlistEntry[];
  strictAllowlist: boolean;
}): { summary: RunSummary; jsonPath: string; markdownPath: string } | null {
  const reports = readCaseReports(params.reportDir, params.runId);
  const planned = readPlanned(params.reportDir, params.runId);
  if (reports.length === 0 && planned === null) return null;

  const summary = buildSummary({ ...params, reports, planned });
  const dir = runDir(params.reportDir, params.runId);
  mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, 'summary.json');
  const markdownPath = path.join(dir, 'summary.md');
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderSummaryMarkdown(summary, reports), 'utf8');
  return { summary, jsonPath, markdownPath };
}
