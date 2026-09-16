/**
 * The recorded cutover reference: the failing-case id SET of one accepted
 * replay (baseline Phoenix dev at `phoenix-last-full`, target Chronos dev),
 * committed as `cutover-reference.json`. The codebase plan's gate is set
 * equality ("the failing-case ID SET must equal the reference set"); the run
 * computes the comparison so the reviewer reads it from `summary.md` instead
 * of diffing a list kept in `/tmp`. `ok` and the exit code do not encode it.
 *
 * Like the kernel-root partition (`kernel-roots.ts`) this is a CLASSIFICATION
 * of the run, not a second gate: the run already fails on every failing case;
 * `summary.md` / `summary.json` add "Failing set versus the recorded reference"
 * (identical, only in this run, only in the reference, totals drift) and the
 * teardown prints one line. The reference holds only while Chronos data is
 * static: after a scrapper load, re-record it (`pnpm gm:reference:record`,
 * `scripts/gm/record-cutover-reference.mts`) before trusting a diff.
 *
 * `TEST_GM_REFERENCE_PATH` points a run at another file; a missing file means
 * no comparison (the summary carries `referenceComparison: null`).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import type { ClassTotals, DifferenceClass } from './compare.js';

const CASE_ID_PATTERN = '^[a-z0-9][a-z0-9-]*$';

/** Every difference class, exhaustively (a class added to `compare.ts` fails here at typecheck). */
const CLASS_KEYS: Record<DifferenceClass, null> = {
  'contract-break': null,
  'data-parity': null,
  rounding: null,
};
export const DIFFERENCE_CLASSES = Object.keys(CLASS_KEYS) as readonly DifferenceClass[];

export const CutoverReferenceSchema = Type.Object(
  {
    /** ISO instant the recorded run's summary was generated (its `generatedAt`, after the last case). */
    recordedAt: Type.String({ minLength: 1 }),
    /** The run id whose summary was recorded (`<timestamp>-<nonce>`). */
    runId: Type.String({ minLength: 1 }),
    baselineUrl: Type.String({ minLength: 1 }),
    targetUrl: Type.String({ minLength: 1 }),
    /** The image (commit sha) the target served when the run was recorded. */
    targetImage: Type.String({ pattern: '^[0-9a-f]{7,40}$' }),
    /** Why this run is the reference (what it was verified against). */
    provenance: Type.String({ minLength: 1 }),
    totals: Type.Object(
      {
        cases: Type.Integer({ minimum: 0 }),
        fail: Type.Integer({ minimum: 0 }),
        leavesCompared: Type.Integer({ minimum: 0 }),
        differences: Type.Object(
          Object.fromEntries(
            DIFFERENCE_CLASSES.map((cls) => [cls, Type.Integer({ minimum: 0 })])
          ) as Record<keyof ClassTotals, ReturnType<typeof Type.Integer>>,
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
    /** Sorted, unique corpus case ids that failed the recorded run. */
    failingCaseIds: Type.Array(Type.String({ pattern: CASE_ID_PATTERN }), {
      uniqueItems: true,
    }),
  },
  { additionalProperties: false }
);

export type CutoverReference = Static<typeof CutoverReferenceSchema>;

export interface ReferenceTotals {
  cases: number;
  fail: number;
  leavesCompared: number;
  differences: ClassTotals;
}

export interface ReferenceComparison {
  recordedAt: string;
  runId: string;
  targetImage: string;
  /** True when the failing id set of this run equals the recorded set. */
  identical: boolean;
  onlyInRun: string[];
  onlyInReference: string[];
  totals: { recorded: ReferenceTotals; run: ReferenceTotals };
  /** True when every recorded total equals this run's. */
  totalsIdentical: boolean;
}

export const DEFAULT_REFERENCE_PATH = path.resolve(import.meta.dirname, 'cutover-reference.json');

/** `TEST_GM_REFERENCE_PATH` overrides the committed file (offline fixtures, dry runs). */
export function resolveReferencePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['TEST_GM_REFERENCE_PATH'];
  return configured !== undefined && configured.length > 0
    ? path.resolve(configured)
    : DEFAULT_REFERENCE_PATH;
}

export function validateReference(raw: unknown): CutoverReference {
  if (!Value.Check(CutoverReferenceSchema, raw)) {
    const problems = [...Value.Errors(CutoverReferenceSchema, raw)]
      .slice(0, 5)
      .map((error) => `${error.path}: ${error.message}`);
    throw new Error(`cutover reference is invalid: ${problems.join('; ')}`);
  }
  const sorted = [...raw.failingCaseIds].sort();
  if (raw.failingCaseIds.some((id, index) => id !== sorted[index])) {
    throw new Error('cutover reference is invalid: failingCaseIds must be sorted');
  }
  return raw;
}

export function loadReference(filePath: string = resolveReferencePath()): CutoverReference {
  // eslint-disable-next-line no-restricted-syntax -- Test harness reference file; validated with TypeBox right after
  const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  return validateReference(raw);
}

/** The committed (or overridden) reference, or `null` when the file does not exist. */
export function loadReferenceIfPresent(
  filePath: string = resolveReferencePath()
): CutoverReference | null {
  return existsSync(filePath) ? loadReference(filePath) : null;
}

/**
 * What `toReference` needs of a run summary (`RunSummary` in report.ts is
 * assignable; the unit test pins that, so a summary field moving fails there
 * at typecheck instead of at record time).
 */
export interface RecordableSummary {
  runId: string;
  generatedAt: string;
  baselineUrl: string | null;
  targetUrl: string | null;
  totals: ReferenceTotals;
  failing: readonly { id: string }[];
}

/** The reference a run's summary records: its failing ids (sorted, unique) and totals. */
export function toReference(
  summary: RecordableSummary,
  targetImage: string,
  provenance: string
): CutoverReference {
  if (summary.baselineUrl === null || summary.targetUrl === null) {
    throw new Error('cannot record a reference from a run that compared no case');
  }
  const failingCaseIds = [...new Set(summary.failing.map((entry) => entry.id))].sort();
  if (failingCaseIds.length !== summary.totals.fail) {
    throw new Error(
      `cannot record a reference: ${String(failingCaseIds.length)} distinct failing id(s) but totals.fail is ${String(summary.totals.fail)}`
    );
  }
  return validateReference({
    recordedAt: summary.generatedAt,
    runId: summary.runId,
    baselineUrl: summary.baselineUrl,
    targetUrl: summary.targetUrl,
    targetImage,
    provenance,
    totals: {
      cases: summary.totals.cases,
      fail: summary.totals.fail,
      leavesCompared: summary.totals.leavesCompared,
      differences: { ...summary.totals.differences },
    },
    failingCaseIds,
  });
}

export function compareToReference(
  run: { failingCaseIds: readonly string[]; totals: ReferenceTotals },
  reference: CutoverReference
): ReferenceComparison {
  const runIds = new Set(run.failingCaseIds);
  const referenceIds = new Set(reference.failingCaseIds);
  const onlyInRun = [...runIds].filter((id) => !referenceIds.has(id)).sort();
  const onlyInReference = [...referenceIds].filter((id) => !runIds.has(id)).sort();
  const recorded: ReferenceTotals = {
    cases: reference.totals.cases,
    fail: reference.totals.fail,
    leavesCompared: reference.totals.leavesCompared,
    differences: { ...reference.totals.differences },
  };
  const totalsIdentical =
    recorded.cases === run.totals.cases &&
    recorded.fail === run.totals.fail &&
    recorded.leavesCompared === run.totals.leavesCompared &&
    DIFFERENCE_CLASSES.every((cls) => recorded.differences[cls] === run.totals.differences[cls]);
  return {
    recordedAt: reference.recordedAt,
    runId: reference.runId,
    targetImage: reference.targetImage,
    identical: onlyInRun.length === 0 && onlyInReference.length === 0,
    onlyInRun,
    onlyInReference,
    totals: { recorded, run: { ...run.totals, differences: { ...run.totals.differences } } },
    totalsIdentical,
  };
}

/** One-line rendering shared by the teardown console line and `summary.md`. */
export function describeReferenceComparison(comparison: ReferenceComparison): string {
  const set = comparison.identical
    ? 'identical to the recorded reference'
    : `differs from the recorded reference (only in this run: ${listText(comparison.onlyInRun)}; only in the reference: ${listText(comparison.onlyInReference)})`;
  const totals = comparison.totalsIdentical
    ? 'totals unchanged'
    : `totals drifted (recorded fail ${String(comparison.totals.recorded.fail)} / leaves ${String(comparison.totals.recorded.leavesCompared)} / ${totalsText(comparison.totals.recorded.differences)}; this run fail ${String(comparison.totals.run.fail)} / leaves ${String(comparison.totals.run.leavesCompared)} / ${totalsText(comparison.totals.run.differences)})`;
  return `failing set ${set}; ${totals} (reference run ${comparison.runId}, target image ${comparison.targetImage})`;
}

function listText(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.join(', ');
}

function totalsText(differences: ClassTotals): string {
  return DIFFERENCE_CLASSES.map((cls) => `${cls} ${String(differences[cls])}`).join(', ');
}
