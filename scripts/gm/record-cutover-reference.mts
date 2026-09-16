/**
 * Record a cutover run as the reference failing set
 * (`tests/golden-master/cutover-reference.json`, see `cutover-reference.ts`).
 *
 *   pnpm gm:reference:record <run>/summary.json --image <deployed sha> --provenance "<why this run>" [--out <path>]
 *
 * Reads the run's `summary.json` (written by the cutover teardown), keeps its
 * failing ids and totals (`toReference`, unit-tested in
 * `tests/unit/golden-master/cutover-reference.test.ts`), and writes the
 * reference the next runs compare against. Re-record after a scrapper load
 * into Chronos: the set holds only while the data is static.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  DEFAULT_REFERENCE_PATH,
  toReference,
  type RecordableSummary,
} from '../../tests/golden-master/cutover-reference.js';

const USAGE =
  'usage: pnpm gm:reference:record <run>/summary.json --image <deployed sha> --provenance "<why>" [--out <path>]';

/** The part of a run's `summary.json` the reference keeps (`RecordableSummary`). */
const RecordedSummarySchema = Type.Object({
  runId: Type.String({ minLength: 1 }),
  generatedAt: Type.String({ minLength: 1 }),
  baselineUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  targetUrl: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  totals: Type.Object({
    cases: Type.Integer({ minimum: 0 }),
    fail: Type.Integer({ minimum: 0 }),
    leavesCompared: Type.Integer({ minimum: 0 }),
    differences: Type.Object({
      'contract-break': Type.Integer({ minimum: 0 }),
      'data-parity': Type.Integer({ minimum: 0 }),
      rounding: Type.Integer({ minimum: 0 }),
    }),
  }),
  failing: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }) })),
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseCli(): { values: Record<string, string | undefined>; positionals: string[] } {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        image: { type: 'string' },
        provenance: { type: 'string' },
        out: { type: 'string' },
      },
    });
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
}

function main(): void {
  const { values, positionals } = parseCli();
  const summaryPath = positionals[0];
  const image = values['image'];
  const provenance = values['provenance'];
  if (summaryPath === undefined || image === undefined || provenance === undefined) {
    fail(USAGE);
  }
  if (!/^[0-9a-f]{7,40}$/u.test(image)) {
    fail(
      `--image must be the deployed image's commit sha (7-40 hex chars), got "${image}"\n${USAGE}`
    );
  }

  const resolvedSummary = path.resolve(summaryPath);
  if (!existsSync(resolvedSummary)) {
    fail(`${resolvedSummary} does not exist\n${USAGE}`);
  }
  // eslint-disable-next-line no-restricted-syntax -- summary.json written by the cutover teardown; shape-checked with TypeBox right after
  const raw: unknown = JSON.parse(readFileSync(resolvedSummary, 'utf8'));
  if (!Value.Check(RecordedSummarySchema, raw)) {
    const problems = [...Value.Errors(RecordedSummarySchema, raw)]
      .slice(0, 5)
      .map((error) => `${error.path}: ${error.message}`);
    fail(`${summaryPath} is not a cutover summary.json: ${problems.join('; ')}`);
  }
  const summary: RecordableSummary = raw;
  const reference = toReference(summary, image, provenance);

  const outPath =
    values['out'] === undefined ? DEFAULT_REFERENCE_PATH : path.resolve(values['out']);
  writeFileSync(outPath, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');
  console.log(
    `recorded ${String(reference.failingCaseIds.length)} failing case id(s) from run ${reference.runId} → ${outPath}`
  );
}

main();
