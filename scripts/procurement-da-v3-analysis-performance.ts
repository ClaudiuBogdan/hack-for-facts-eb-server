/**
 * Read-only measurement of the direct_acquisition analysis grain served from
 * procurement_v3 on Postgres (release 1 fallback): the heaviest buyer and
 * supplier pages of the client, each read through the real analysis usecases
 * and the routing repo, N times. Prints p50/p95 per read and per page (the
 * page's reads fired concurrently, as the client fires them).
 *
 * Usage (NEVER against a writable role; every transaction is also read-only):
 *   DA_V3_PERF_DATABASE_URL=postgres://… \
 *   DA_V3_PERF_AUTHORITY_CUI=… DA_V3_PERF_SUPPLIER_CUI=… \
 *   [DA_V3_PERF_YEAR=2025] [DA_V3_PERF_RUNS=10] \
 *   pnpm exec tsx scripts/procurement-da-v3-analysis-performance.ts
 *
 * Filtered scopes are never cached by the source, so every run is live. The
 * first run also pays the once-per-publication quality measurement, reported
 * separately as `generation (cold)`.
 */
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import {
  analysisBreakdown,
  analysisConcentration,
  analysisRecords,
  analysisSeries,
  analysisStats,
  type AnalysisDeps,
} from '../src/modules/procurement/core/analysis-usecases.js';
import { makeUnconfiguredAnalysisRepo } from '../src/modules/procurement/shell/repo/clickhouse-analysis-repo.js';
import { makeDaRoutingAnalysisRepo } from '../src/modules/procurement/shell/repo/da-routing-analysis-repo.js';
import { makeDaV3AnalysisSource } from '../src/modules/procurement/shell/repo/da-v3-analysis-source.js';

import type { AnalysisScope } from '../src/modules/procurement/core/analysis-scope.js';
import type { ProdDatabase } from '../src/modules/shared/index.js';

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
};

const DATABASE_URL = env('DA_V3_PERF_DATABASE_URL');
const AUTHORITY = env('DA_V3_PERF_AUTHORITY_CUI');
const SUPPLIER = env('DA_V3_PERF_SUPPLIER_CUI');
const YEAR = Number(process.env['DA_V3_PERF_YEAR'] ?? '2025');
const RUNS = Number(process.env['DA_V3_PERF_RUNS'] ?? '10');

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};

type Read = (deps: AnalysisDeps) => Promise<{ isErr(): boolean; error?: unknown }>;

const DA = { grain: 'direct_acquisition' } as const;

type Case = readonly [label: string, read: Read];

/** The client's buyer page (procurement/institutions/$cui), supplier geography dropped. */
const buyerPage = (scope: AnalysisScope, year: number): readonly Case[] => {
  const inYear = { ...scope, year };
  const since2019 = { ...scope, from: '2019-01' };
  return [
    ['stats year', (d) => analysisStats(d, { scope: inYear })],
    ['stats previous year', (d) => analysisStats(d, { scope: { ...scope, year: year - 1 } })],
    ['concentration year', (d) => analysisConcentration(d, { scope: inYear, basis: 'value' })],
    [
      'series value by year since 2019',
      (d) => analysisSeries(d, { scope: since2019, measure: 'valueAwardedSum', bucket: 'year' }),
    ],
    [
      'series count by year since 2019',
      (d) => analysisSeries(d, { scope: since2019, measure: 'recordCount', bucket: 'year' }),
    ],
    [
      'series value by month of year',
      (d) => analysisSeries(d, { scope: inYear, measure: 'valueAwardedSum', bucket: 'month' }),
    ],
    [
      'breakdown supplier top10 value',
      (d) =>
        analysisBreakdown(d, { scope: inYear, dimension: 'supplier', topN: 10, rankBy: 'value' }),
    ],
    [
      'breakdown buyerCounty top1 count',
      (d) =>
        analysisBreakdown(d, { scope: inYear, dimension: 'buyerCounty', topN: 1, rankBy: 'count' }),
    ],
    [
      'breakdown cpvDivision',
      (d) => analysisBreakdown(d, { scope: inYear, dimension: 'cpvDivision', topN: 50 }),
    ],
    [
      'breakdown cpvGroup',
      (d) => analysisBreakdown(d, { scope: inYear, dimension: 'cpvGroup', topN: 50 }),
    ],
    [
      'records value_desc',
      (d) => analysisRecords(d, { scope: inYear, sort: 'value_desc', pageSize: 25 }),
    ],
  ];
};

/** The client's supplier page (procurement/suppliers/$cui). */
const supplierPage = (scope: AnalysisScope, year: number): readonly Case[] => {
  const inYear = { ...scope, year };
  const since2019 = { ...scope, from: '2019-01' };
  return [
    ['stats year', (d) => analysisStats(d, { scope: inYear })],
    ['stats previous year', (d) => analysisStats(d, { scope: { ...scope, year: year - 1 } })],
    [
      'breakdown authority top10 since 2019',
      (d) => analysisBreakdown(d, { scope: since2019, dimension: 'authority', topN: 10 }),
    ],
    [
      'breakdown authority top10 year',
      (d) => analysisBreakdown(d, { scope: inYear, dimension: 'authority', topN: 10 }),
    ],
    [
      'distinct authorities by year',
      (d) =>
        analysisSeries(d, { scope: since2019, measure: 'distinctAuthorities', bucket: 'year' }),
    ],
    [
      'breakdown buyerCounty top42',
      (d) => analysisBreakdown(d, { scope: inYear, dimension: 'buyerCounty', topN: 42 }),
    ],
    [
      'series value by month since 2019',
      (d) => analysisSeries(d, { scope: since2019, measure: 'valueAwardedSum', bucket: 'month' }),
    ],
    [
      'breakdown cpvDivision',
      (d) => analysisBreakdown(d, { scope: inYear, dimension: 'cpvDivision', topN: 50 }),
    ],
    [
      'records value_desc',
      (d) => analysisRecords(d, { scope: inYear, sort: 'value_desc', pageSize: 25 }),
    ],
  ];
};

const timed = async (read: Read, deps: AnalysisDeps): Promise<number> => {
  const started = performance.now();
  const result = await read(deps);
  const elapsed = performance.now() - started;
  if (result.isErr()) throw new Error(`read failed: ${JSON.stringify(result.error)}`);
  return elapsed;
};

const measurePage = async (name: string, reads: readonly Case[], deps: AnalysisDeps) => {
  const perRead = new Map<string, number[]>(reads.map(([label]) => [label, []]));
  const page: number[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    for (const [label, read] of reads) perRead.get(label)?.push(await timed(read, deps));
    const started = performance.now();
    await Promise.all(reads.map(([, read]) => timed(read, deps)));
    page.push(performance.now() - started);
  }
  console.log(`\n${name} (${String(RUNS)} runs)`);
  for (const [label, values] of perRead)
    console.log(
      `  ${label.padEnd(40)} p50 ${percentile(values, 0.5).toFixed(0).padStart(6)} ms   p95 ${percentile(values, 0.95).toFixed(0).padStart(6)} ms`
    );
  console.log(
    `  ${'PAGE (concurrent)'.padEnd(40)} p50 ${percentile(page, 0.5).toFixed(0).padStart(6)} ms   p95 ${percentile(page, 0.95).toFixed(0).padStart(6)} ms`
  );
};

const main = async (): Promise<void> => {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 8,
    options: '-c default_transaction_read_only=on',
  });
  const db = new Kysely<ProdDatabase>({ dialect: new PostgresDialect({ pool }) });
  try {
    const source = makeDaV3AnalysisSource(db);
    const deps: AnalysisDeps = {
      analysisRepo: makeDaRoutingAnalysisRepo(makeUnconfiguredAnalysisRepo(), source),
    };
    const started = performance.now();
    const gen = await source.generation();
    if (gen.isErr()) throw new Error(`generation failed: ${JSON.stringify(gen.error)}`);
    console.log(
      `generation (cold, includes the quality measurement): ${(performance.now() - started).toFixed(0)} ms, build ${gen.value?.buildId ?? 'none'}`
    );
    await measurePage(
      `BUYER ${AUTHORITY} year ${String(YEAR)}`,
      buyerPage({ ...DA, authorityCui: AUTHORITY }, YEAR),
      deps
    );
    await measurePage(
      `SUPPLIER ${SUPPLIER} year ${String(YEAR)}`,
      supplierPage({ ...DA, supplierCui: SUPPLIER }, YEAR),
      deps
    );
  } finally {
    await db.destroy();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
