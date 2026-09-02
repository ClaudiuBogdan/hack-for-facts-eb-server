/**
 * Cutover case runner: runs ONE document+variables against the BASELINE
 * (expected, today's `/graphql`) and the TARGET (actual, `/api/v1/graphql`),
 * compares the full envelopes, applies the data-parity allowlist, writes the
 * per-case report and produces the assertion for vitest.
 *
 * Verdict rules:
 * - a case DEFECT (see `CaseDefect` in report.ts)          → fail, always:
 *   `transport-error` (a side did not answer with a GraphQL envelope — a
 *   Fastify 404 body, a refused connection, a timeout, a redirect, non-JSON,
 *   a non-finite number), `no-data` (a `live`/`dead` case where either side
 *   is not `200` + non-null `data` + no `errors`), `baseline-error`,
 *   `baseline-unexpectedly-valid`
 * - any `contract-break`                                    → fail
 * - any `data-parity` not pinned by the allowlist            → fail
 * - `rounding`, extra keys, allowlisted parity, warnings     → pass-with-warnings
 * - nothing at all                                           → pass
 */

import { applyAllowlist, summarizeAllowed, type AllowlistFile } from './allowlist.js';
import {
  compareEnvelopes,
  describeRootShape,
  emptyTotals,
  isEmptyRootShape,
  type ComparisonWarning,
  type Difference,
  type GraphQLEnvelope,
} from './compare.js';
import { writeCaseReport, type CaseDefect, type CaseReport, type SideReport } from './report.js';

import type { CorpusStatus } from './corpus.js';

export interface QueryEnvelopeOptions {
  timeoutMs?: number;
}

export interface EnvelopeSource {
  url: string;
  queryEnvelope(
    gql: string,
    variables?: Record<string, unknown>,
    options?: QueryEnvelopeOptions
  ): Promise<GraphQLEnvelope>;
}

export interface CutoverCaseInput {
  id: string;
  key: string;
  documentHash: string;
  variablesHash: string;
  operationName: string | null;
  status: CorpusStatus;
  source: string | null;
  document: string;
  variables: Record<string, unknown>;
}

export interface CutoverCaseResult {
  report: CaseReport;
  reportPath: string;
  baseline: GraphQLEnvelope;
  target: GraphQLEnvelope;
}

export interface RunCutoverCaseDeps {
  baseline: EnvelopeSource;
  target: EnvelopeSource;
  allowlist: AllowlistFile;
  runId: string;
  reportDir?: string;
  decimalPlaces?: number;
  /** Per-side fetch timeout. Default 30 s. */
  fetchTimeoutMs?: number;
  now?: () => Date;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

/**
 * Both sides are fetched SEQUENTIALLY, so two hanging sides take two fetch
 * timeouts; the per-side timeout is derived from the vitest case timeout so
 * that a hang is recorded as a `transport-error` defect (and a case file is
 * written) BEFORE vitest kills the test and writes nothing.
 */
export const CASE_TIMEOUT_MARGIN_MS = 2_000;
export const MIN_FETCH_TIMEOUT_MS = 1_000;

export function fetchTimeoutForCase(caseTimeoutMs: number): number {
  return Math.max(MIN_FETCH_TIMEOUT_MS, Math.floor((caseTimeoutMs - CASE_TIMEOUT_MARGIN_MS) / 2));
}

/**
 * Envelope used in the report when a side could not be reached at all.
 * `status: 0` is never a real HTTP status, so it cannot be mistaken for a
 * server answer.
 */
const UNREACHABLE: GraphQLEnvelope = { status: 0 };

// =============================================================================
// Judgement (pure)
// =============================================================================

export interface Judgement {
  verdict: CaseReport['verdict'];
  defects: CaseReport['defects'];
  blocking: Difference[];
  allowed: CaseReport['allowed'];
  informational: Difference[];
}

function isNonNullObject(value: unknown): boolean {
  return (
    value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
  );
}

/** `200` + non-null object `data` + no `errors`: the only shape a live case may answer with. */
export function isUsableAnswer(envelope: GraphQLEnvelope): boolean {
  return (
    envelope.status === 200 &&
    isNonNullObject(envelope.data) &&
    (envelope.errors === undefined || envelope.errors.length === 0)
  );
}

function describeAnswer(envelope: GraphQLEnvelope): string {
  const errors = envelope.errors ?? [];
  return `HTTP ${String(envelope.status)}, data ${
    envelope.data === undefined ? 'absent' : envelope.data === null ? 'null' : 'present'
  }, ${String(errors.length)} error(s)${errors.length > 0 ? `: ${errors.map((e) => e.message).join(' | ')}` : ''}`;
}

/**
 * Verdict over an already-compared pair. The answer gates run BEFORE the
 * differences are considered: two identical unusable answers are not
 * equivalence.
 */
export function judgeCase(params: {
  status: CorpusStatus;
  baseline: GraphQLEnvelope;
  target: GraphQLEnvelope;
  differences: readonly Difference[];
  warnings: readonly ComparisonWarning[];
  allowlist: AllowlistFile;
  caseKey: string;
}): Judgement {
  const defects: CaseReport['defects'] = [];
  const baselineErrors = params.baseline.errors ?? [];

  if (params.status === 'invalid-today') {
    const baselineRejected = params.baseline.status !== 200 || baselineErrors.length > 0;
    if (!baselineRejected) {
      defects.push({
        kind: 'baseline-unexpectedly-valid' satisfies CaseDefect,
        message: `corpus marks this document invalid-today but the baseline answered it (${describeAnswer(params.baseline)}) — re-classify the entry before trusting the replay`,
      });
    }
  } else {
    for (const [side, envelope] of [
      ['baseline', params.baseline],
      ['target', params.target],
    ] as const) {
      if (isUsableAnswer(envelope)) continue;
      const errors = envelope.errors ?? [];
      if (side === 'baseline' && errors.length > 0) {
        defects.push({
          kind: 'baseline-error' satisfies CaseDefect,
          message: `baseline returned errors on a ${params.status} document (corpus/variables defect, or the baseline schema moved): ${errors
            .map((e) => e.message)
            .join(' | ')}`,
        });
        continue;
      }
      defects.push({
        kind: 'no-data' satisfies CaseDefect,
        message: `${side} did not answer a ${params.status} document with 200 + non-null data + no errors (${describeAnswer(envelope)})`,
      });
    }
  }

  const applied = applyAllowlist(params.differences, params.allowlist, params.caseKey);

  let verdict: CaseReport['verdict'] = 'pass';
  if (defects.length > 0 || applied.blocking.length > 0) {
    verdict = 'fail';
  } else if (
    applied.allowed.length > 0 ||
    applied.informational.length > 0 ||
    params.warnings.length > 0
  ) {
    verdict = 'pass-with-warnings';
  }

  return { verdict, defects, ...applied };
}

// =============================================================================
// Running
// =============================================================================

interface TimedEnvelope {
  envelope: GraphQLEnvelope;
  ms: number;
  transportError: string | null;
}

async function timed(
  source: EnvelopeSource,
  document: string,
  variables: Record<string, unknown>,
  timeoutMs: number
): Promise<TimedEnvelope> {
  const started = Date.now();
  try {
    const envelope = await source.queryEnvelope(document, variables, { timeoutMs });
    return { envelope, ms: Date.now() - started, transportError: null };
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    // `TimeoutError` (AbortSignal.timeout) and `EnvelopeError` carry their
    // meaning in the name; a plain `Error` does not need the prefix.
    const named =
      cause.name === 'Error' || cause.name.length === 0
        ? cause.message
        : `${cause.name}: ${cause.message}`;
    const detail =
      cause.cause instanceof Error && cause.cause.message.length > 0
        ? `${named} (${cause.cause.message})`
        : named;
    return { envelope: UNREACHABLE, ms: Date.now() - started, transportError: detail };
  }
}

function sideReport(source: EnvelopeSource, timed: TimedEnvelope): SideReport {
  return {
    url: source.url,
    finalUrl: timed.envelope.url ?? null,
    status: timed.envelope.status,
    durationMs: timed.ms,
    errors: (timed.envelope.errors ?? []).map((e) => e.message),
    rootShape: describeRootShape(timed.envelope.data),
  };
}

export async function runCutoverCase(
  input: CutoverCaseInput,
  deps: RunCutoverCaseDeps
): Promise<CutoverCaseResult> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  // Sequential on purpose: both endpoints share one server process in the
  // documented local setup; parallel POSTs would only skew the timings.
  const baseline = await timed(deps.baseline, input.document, input.variables, timeoutMs);
  const target = await timed(deps.target, input.document, input.variables, timeoutMs);

  const transportDefects: CaseReport['defects'] = [];
  if (baseline.transportError !== null) {
    transportDefects.push({
      kind: 'transport-error',
      message: `baseline ${deps.baseline.url} did not answer with a GraphQL envelope: ${baseline.transportError}`,
    });
  }
  if (target.transportError !== null) {
    transportDefects.push({
      kind: 'transport-error',
      message: `target ${deps.target.url} did not answer with a GraphQL envelope: ${target.transportError}`,
    });
  }

  const reachable = transportDefects.length === 0;
  const comparison = reachable
    ? compareEnvelopes(baseline.envelope, target.envelope, {
        ...(deps.decimalPlaces !== undefined && { decimalPlaces: deps.decimalPlaces }),
      })
    : {
        differences: [],
        warnings: [],
        stats: { leavesCompared: 0, totals: emptyTotals() },
      };

  const baselineShape = describeRootShape(baseline.envelope.data);
  const warnings: ComparisonWarning[] = [...comparison.warnings];
  if (reachable && input.status !== 'invalid-today' && isEmptyRootShape(baselineShape)) {
    warnings.push({
      kind: 'baseline-empty',
      path: '$.data',
      message:
        'every list-bearing root field is empty on the baseline — the pair proves nothing about the data; check the variables',
    });
  }

  const judgement: Judgement = reachable
    ? judgeCase({
        status: input.status,
        baseline: baseline.envelope,
        target: target.envelope,
        differences: comparison.differences,
        warnings,
        allowlist: deps.allowlist,
        caseKey: input.key,
      })
    : {
        verdict: 'fail',
        defects: transportDefects,
        blocking: [],
        allowed: [],
        informational: [],
      };

  const allowedByEntry = summarizeAllowed(judgement.allowed);
  const report: CaseReport = {
    runId: deps.runId,
    id: input.id,
    key: input.key,
    documentHash: input.documentHash,
    variablesHash: input.variablesHash,
    operationName: input.operationName,
    status: input.status,
    source: input.source,
    baselineUrl: deps.baseline.url,
    targetUrl: deps.target.url,
    sides: {
      baseline: sideReport(deps.baseline, baseline),
      target: sideReport(deps.target, target),
    },
    recordedAt: now().toISOString(),
    verdict: judgement.verdict,
    defects: judgement.defects,
    counts: comparison.stats.totals,
    // Filled in by the report writer: differences it did not list (per-array cap).
    hidden: emptyTotals(),
    leavesCompared: comparison.stats.leavesCompared,
    blocking: judgement.blocking,
    allowed: judgement.allowed,
    allowedByEntry,
    allowedEntryIds: allowedByEntry.map((e) => e.entryId),
    informational: judgement.informational,
    warnings,
    baselineErrors: (baseline.envelope.errors ?? []).map((e) => e.message),
    targetErrors: (target.envelope.errors ?? []).map((e) => e.message),
    durationMs: { baseline: baseline.ms, target: target.ms },
  };

  const reportPath = writeCaseReport(report, deps.reportDir);
  return { report, reportPath, baseline: baseline.envelope, target: target.envelope };
}

/** Human-readable failure text for the vitest assertion. */
export function describeFailure(result: CutoverCaseResult): string {
  const { report } = result;
  const lines: string[] = [];
  lines.push(`[Golden Master cutover] ${report.id} (${report.status}) FAILED — key ${report.key}`);
  lines.push(`  baseline: ${report.baselineUrl} → HTTP ${String(report.sides.baseline.status)}`);
  lines.push(`  target:   ${report.targetUrl} → HTTP ${String(report.sides.target.status)}`);
  for (const defect of report.defects) {
    lines.push(`  defect ${defect.kind}: ${defect.message}`);
  }
  for (const difference of report.blocking.slice(0, 30)) {
    lines.push(
      `  ${difference.class}/${difference.kind} ${difference.path}: ${difference.message}` +
        (difference.expected === undefined && difference.actual === undefined
          ? ''
          : ` (expected ${short(difference.expected)}, actual ${short(difference.actual)})`)
    );
  }
  if (report.blocking.length > 30) {
    lines.push(`  … ${String(report.blocking.length - 30)} more blocking difference(s)`);
  }
  lines.push(`  full report: ${result.reportPath}`);
  return lines.join('\n');
}

function short(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return 'undefined';
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
