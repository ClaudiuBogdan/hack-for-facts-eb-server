/**
 * Read-only release gate: three fresh server processes per case, followed by
 * per-case cold/warm percentiles and an EXPLAIN of the measured worst accepted
 * distinct-series case.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import {
  buildProcurementPerformanceCorpus,
  type ProcurementPerformanceCase,
} from './procurement-analysis-performance-corpus.js';
import { ANALYSIS_MATRIX_SHA256 } from '../src/modules/procurement/core/combinations.js';

interface WorkerSample {
  readonly caseIndex: number;
  readonly label: string;
  readonly coldMs: number;
  readonly warmMs: readonly number[];
  readonly responseBuildId: string | null;
  readonly processBuildId: string;
}

interface CaseSummary {
  readonly label: string;
  readonly cold: ReturnType<typeof summarize>;
  readonly warm: ReturnType<typeof summarize>;
  readonly targets: {
    readonly coldP95Under5s: boolean;
    readonly warmP95Under300ms: boolean;
  };
}

const AUTHORITY = process.env['PROCUREMENT_PERF_AUTHORITY_CUI'] ?? '29170968';
const SUPPLIER = process.env['PROCUREMENT_PERF_SUPPLIER_CUI'] ?? '28022254';
const COLD_PROCESSES_PER_CASE = 3;
const HARD_LIMIT_MS = 12_000;
const REJECTION_LIMIT_MS = 300;
const WORKER_DEADLINE_MS = 60_000;
const RESULT_PREFIX = 'PROCUREMENT_PERF_RESULT\t';
const CONCURRENCY_PREFIX = 'PROCUREMENT_PERF_CONCURRENCY\t';
const workerPath = fileURLToPath(
  new URL('./procurement-analysis-performance-worker.ts', import.meta.url)
);
const corpus = buildProcurementPerformanceCorpus({
  authorityCui: AUTHORITY,
  supplierCui: SUPPLIER,
});

const percentile = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
};

const summarize = (values: readonly number[]) => ({
  count: values.length,
  medianMs: Number(percentile(values, 0.5).toFixed(1)),
  p95Ms: Number(percentile(values, 0.95).toFixed(1)),
  maxMs: Number(Math.max(...values).toFixed(1)),
});

const parseWorkerResult = (stdout: string, caseIndex: number): WorkerSample => {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (line === undefined) throw new Error(`case ${String(caseIndex)} emitted no result sentinel`);
  const fields = line.split('\t');
  const parsedIndex = Number(fields[1]);
  const label = decodeURIComponent(fields[2] ?? '');
  const coldMs = Number(fields[3]);
  const warmMs = (fields[4] ?? '').split(',').map(Number);
  const responseBuildId = fields[5]?.length === 0 ? null : (fields[5] ?? null);
  const processBuildId = fields[6] ?? '';
  if (
    parsedIndex !== caseIndex ||
    label.length === 0 ||
    !Number.isFinite(coldMs) ||
    warmMs.length !== 3 ||
    warmMs.some((value) => !Number.isFinite(value)) ||
    processBuildId.length === 0
  ) {
    throw new Error(`case ${String(caseIndex)} emitted an invalid result sentinel`);
  }
  return { caseIndex, label, coldMs, warmMs, responseBuildId, processBuildId };
};

const runFreshProcess = async (caseIndex: number): Promise<WorkerSample> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', workerPath, '--case', String(caseIndex)],
      { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(
        new Error(
          `fresh process for case ${String(caseIndex)} exceeded ${String(WORKER_DEADLINE_MS)}ms: ${stderr.trim()}`
        )
      );
    }, WORKER_DEADLINE_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (code !== 0) {
        reject(
          new Error(
            `fresh process for case ${String(caseIndex)} exited ${String(code)}: ${stderr.trim()}`
          )
        );
        return;
      }
      try {
        resolve(parseWorkerResult(stdout, caseIndex));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

const runConcurrencyFreshProcess = async (): Promise<{
  readonly requests: number;
  readonly elapsedMs: number;
  readonly slowestRequestMs: number;
  readonly buildId: string;
}> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, '--concurrency'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(
        new Error(`concurrency process exceeded ${String(WORKER_DEADLINE_MS)}ms: ${stderr.trim()}`)
      );
    }, WORKER_DEADLINE_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (code !== 0) {
        reject(new Error(`concurrency process exited ${String(code)}: ${stderr.trim()}`));
        return;
      }
      const line = stdout
        .split(/\r?\n/u)
        .find((candidate) => candidate.startsWith(CONCURRENCY_PREFIX));
      const fields = line?.split('\t') ?? [];
      const requests = Number(fields[1]);
      const elapsedMs = Number(fields[2]);
      const slowestRequestMs = Number(fields[3]);
      const buildId = fields[4] ?? '';
      if (
        requests !== 8 ||
        !Number.isFinite(elapsedMs) ||
        !Number.isFinite(slowestRequestMs) ||
        buildId.length === 0
      ) {
        reject(new Error('concurrency process emitted an invalid result sentinel'));
        return;
      }
      resolve({ requests, elapsedMs, slowestRequestMs, buildId });
    });
  });

const activeGeneration = async (
  pool: Pool
): Promise<{ readonly build_id: string; readonly matrix_hash: string }> => {
  const generation = await pool.query<{ build_id: string; matrix_hash: string }>(
    `select build_id::text, matrix_hash from procurement.analysis_generations
      where status = 'active' limit 1`
  );
  const active = generation.rows[0];
  if (active === undefined) throw new Error('no active procurement analysis generation');
  return active;
};

const explainWorstDistinct = async (
  pool: Pool,
  buildId: string,
  testCase: ProcurementPerformanceCase
): Promise<unknown> => {
  const distinct = testCase.distinct;
  if (distinct === undefined) throw new Error('worst distinct case has no SQL descriptor');
  const conditions = ['build_id = $1', 'grain = $2'];
  const params: unknown[] = [buildId, distinct.grain];
  if (distinct.authorityCui !== undefined) {
    params.push(distinct.authorityCui);
    conditions.push(`authority_cui = $${String(params.length)}`);
  }
  if (distinct.supplierCui !== undefined) {
    params.push(distinct.supplierCui);
    conditions.push(`supplier_cui = $${String(params.length)}`);
  }
  params.push(distinct.bucket);
  const bucketParameter = `$${String(params.length)}`;
  params.push(
    distinct.bucket === 'month' ? 'YYYY-MM' : distinct.bucket === 'quarter' ? 'YYYY-"Q"Q' : 'YYYY'
  );
  const formatParameter = `$${String(params.length)}`;
  const result = await pool.query<Record<string, unknown>>(
    `explain (analyze, buffers, format json)
     select date_trunc(${bucketParameter}, month_start)::date::text bucket_start,
            to_char(date_trunc(${bucketParameter}, month_start), ${formatParameter}) bucket,
            count(distinct ${distinct.key})::text value,
            coalesce(sum(record_count),0)::text record_count,
            coalesce(sum(with_value_count),0)::text with_value,
            sum(value_awarded_sum)::text value_awarded_sum
       from procurement.analysis_rollup_edge_monthly
      where ${conditions.join(' and ')}
      group by 1, 2 order by 1 asc nulls last`,
    params
  );
  return result.rows[0]?.['QUERY PLAN'] ?? null;
};

const main = async (): Promise<void> => {
  const rawUrl = process.env['PROD_DATABASE_URL'];
  if (rawUrl === undefined || rawUrl.length === 0) {
    throw new Error('PROD_DATABASE_URL is required for the procurement performance gate');
  }
  const pool = new Pool({
    connectionString: rawUrl.replace(/[?&]sslmode=[a-z-]+/iu, ''),
    ssl: { rejectUnauthorized: false },
  });
  try {
    const active = await activeGeneration(pool);
    if (active.matrix_hash !== ANALYSIS_MATRIX_SHA256) {
      throw new Error(
        `active matrix ${active.matrix_hash} does not match server pin ${ANALYSIS_MATRIX_SHA256}`
      );
    }
    console.info(
      `procurement performance buildId=${active.build_id} matrixHash=${active.matrix_hash} cases=${String(corpus.length)} freshProcessesPerCase=${String(COLD_PROCESSES_PER_CASE)}`
    );

    const samplesByCase: WorkerSample[][] = [];
    for (const [caseIndex, testCase] of corpus.entries()) {
      const samples: WorkerSample[] = [];
      for (let sample = 0; sample < COLD_PROCESSES_PER_CASE; sample += 1) {
        const measured = await runFreshProcess(caseIndex);
        if (measured.processBuildId !== active.build_id) {
          throw new Error(
            `${testCase.label}: fresh process probed build ${measured.processBuildId}, expected ${active.build_id}`
          );
        }
        const expectedResponseBuildId =
          testCase.expectsInvalidInput === true ? null : active.build_id;
        if (measured.responseBuildId !== expectedResponseBuildId) {
          throw new Error(
            `${testCase.label}: measured response returned build ${measured.responseBuildId ?? 'none'}, expected ${expectedResponseBuildId ?? 'none'}`
          );
        }
        samples.push(measured);
      }
      samplesByCase.push(samples);
      console.info(
        `${testCase.label}: cold=${samples.map((entry) => entry.coldMs.toFixed(1)).join(',')}ms`
      );
    }

    const summaries: CaseSummary[] = corpus.map((testCase, index) => {
      const samples = samplesByCase[index] ?? [];
      const cold = samples.map((sample) => sample.coldMs);
      const warm = samples.flatMap((sample) => sample.warmMs);
      if (cold.length !== COLD_PROCESSES_PER_CASE) {
        throw new Error(`${testCase.label}: missing fresh-process cold samples`);
      }
      return {
        label: testCase.label,
        cold: summarize(cold),
        warm: summarize(warm),
        targets: {
          coldP95Under5s: percentile(cold, 0.95) <= 5_000,
          warmP95Under300ms: percentile(warm, 0.95) <= 300,
        },
      };
    });
    const worstDistinct = corpus
      .map((testCase, index) => ({
        testCase,
        p95: summaries[index]?.cold.p95Ms ?? 0,
      }))
      .filter((entry) => entry.testCase.distinct !== undefined)
      .sort((a, b) => b.p95 - a.p95)[0];
    if (worstDistinct === undefined) throw new Error('performance corpus has no distinct case');
    const worstDistinctPlan = await explainWorstDistinct(
      pool,
      active.build_id,
      worstDistinct.testCase
    );
    const concurrency = await runConcurrencyFreshProcess();
    if (concurrency.buildId !== active.build_id) {
      throw new Error(
        `concurrency process returned build ${concurrency.buildId}, expected ${active.build_id}`
      );
    }
    const activeAfter = await activeGeneration(pool);
    if (
      activeAfter.build_id !== active.build_id ||
      activeAfter.matrix_hash !== active.matrix_hash
    ) {
      throw new Error(
        `active procurement generation changed during performance gate: ${active.build_id}/${active.matrix_hash} -> ${activeAfter.build_id}/${activeAfter.matrix_hash}`
      );
    }

    console.info(
      JSON.stringify(
        {
          buildId: active.build_id,
          matrixHash: active.matrix_hash,
          processIsolation: {
            coldProcessesPerCase: COLD_PROCESSES_PER_CASE,
            totalFreshProcesses: corpus.length * COLD_PROCESSES_PER_CASE,
            warmSamplesPerCase: COLD_PROCESSES_PER_CASE * 3,
          },
          concurrency,
          cases: summaries,
          worstDistinct: {
            label: worstDistinct.testCase.label,
            coldP95Ms: worstDistinct.p95,
            plan: worstDistinctPlan,
          },
        },
        null,
        2
      )
    );

    for (const [index, testCase] of corpus.entries()) {
      const samples = samplesByCase[index] ?? [];
      const all = samples.flatMap((sample) => [sample.coldMs, ...sample.warmMs]);
      if (all.some((elapsedMs) => elapsedMs >= HARD_LIMIT_MS)) {
        throw new Error(`${testCase.label}: at least one request reached 12 seconds`);
      }
      if (
        testCase.expectsInvalidInput === true &&
        all.some((elapsedMs) => elapsedMs >= REJECTION_LIMIT_MS)
      ) {
        throw new Error(`${testCase.label}: rejection took at least 300ms`);
      }
    }
    if (concurrency.slowestRequestMs >= HARD_LIMIT_MS) {
      throw new Error('concurrent request reached 12 seconds');
    }
  } finally {
    await pool.end();
  }
};

await main();
