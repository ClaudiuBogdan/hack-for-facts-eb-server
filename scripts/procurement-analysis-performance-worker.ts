/** Runs exactly one case in a fresh server process for isolated cold evidence. */
import { performance } from 'node:perf_hooks';

import { buildProcurementPerformanceCorpus } from './procurement-analysis-performance-corpus.js';
import { buildRedesignApp } from '../src/app/build-redesign-app.js';
import { loadRedesignConfig } from '../src/infra/config/redesign-env.js';

const RESULT_PREFIX = 'PROCUREMENT_PERF_RESULT';
const CONCURRENCY_PREFIX = 'PROCUREMENT_PERF_CONCURRENCY';
const WARM_SAMPLES = 3;

const authorityCui = process.env['PROCUREMENT_PERF_AUTHORITY_CUI'] ?? '29170968';
const supplierCui = process.env['PROCUREMENT_PERF_SUPPLIER_CUI'] ?? '28022254';
const corpus = buildProcurementPerformanceCorpus({ authorityCui, supplierCui });

const concurrencyMode = process.argv.includes('--concurrency');
const caseFlag = process.argv.indexOf('--case');
const caseIndex = caseFlag >= 0 ? Number(process.argv[caseFlag + 1]) : Number.NaN;
if (
  !concurrencyMode &&
  (!Number.isInteger(caseIndex) || caseIndex < 0 || caseIndex >= corpus.length)
) {
  throw new Error(`--case must identify one corpus entry from 0 to ${String(corpus.length - 1)}`);
}
const testCase = corpus[caseIndex];
if (!concurrencyMode && testCase === undefined) {
  throw new Error('performance case disappeared');
}

const config = loadRedesignConfig(process.env);
const built = await buildRedesignApp({
  kernelConfig: config.kernel,
  modules: ['procurement'],
  procurementWarmCache: false,
  logLevel: 'silent',
});
const app = built.app;

try {
  await app.ready();
  const responseBuildIds = (data: unknown): readonly string[] => {
    const buildIds: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'buildId' && typeof child === 'string') buildIds.push(child);
        else visit(child);
      }
    };
    visit(data);
    return [...new Set(buildIds)];
  };

  const run = async (
    selected: (typeof corpus)[number]
  ): Promise<{ readonly elapsedMs: number; readonly responseBuildId: string | null }> => {
    const started = performance.now();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      headers: { 'content-type': 'application/json' },
      payload: { query: selected.query, variables: selected.variables },
    });
    const elapsedMs = performance.now() - started;
    const body = response.json<{
      readonly data?: unknown;
      readonly errors?: readonly { readonly extensions?: { readonly code?: string } }[];
    }>();
    const errorCode = body.errors?.[0]?.extensions?.code;
    if (selected.expectsInvalidInput === true) {
      if (errorCode !== 'INVALID_INPUT') {
        throw new Error(
          `${selected.label}: expected INVALID_INPUT, received ${errorCode ?? 'none'}`
        );
      }
    } else if (body.errors !== undefined) {
      throw new Error(`${selected.label}: GraphQL returned ${errorCode ?? 'an untyped error'}`);
    }
    const uniqueBuildIds = responseBuildIds(body.data);
    if (selected.expectsInvalidInput !== true && uniqueBuildIds.length !== 1) {
      const observed = uniqueBuildIds.length === 0 ? 'none' : uniqueBuildIds.join(',');
      throw new Error(`${selected.label}: expected one response buildId, received ${observed}`);
    }
    return { elapsedMs, responseBuildId: uniqueBuildIds[0] ?? null };
  };

  /** Untimed and deliberately after samples so it cannot warm a measured request. */
  const processBuildId = async (): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/graphql',
      headers: { 'content-type': 'application/json' },
      payload: {
        query: `query { procurementStats(scope:{grain:contract}) { blocks { meta { buildId } } } }`,
      },
    });
    const body = response.json<{ readonly data?: unknown; readonly errors?: readonly unknown[] }>();
    if (body.errors !== undefined) throw new Error('process build probe returned GraphQL errors');
    const buildIds = responseBuildIds(body.data);
    if (buildIds.length !== 1) {
      const observed = buildIds.length === 0 ? 'none' : buildIds.join(',');
      throw new Error(`process build probe expected one build, received ${observed}`);
    }
    return buildIds[0] ?? '';
  };

  if (concurrencyMode) {
    const concurrentCases = corpus.slice(0, 8);
    const started = performance.now();
    const results = await Promise.all(concurrentCases.map(run));
    const buildIds = [
      ...new Set(
        results.flatMap((result) =>
          result.responseBuildId === null ? [] : [result.responseBuildId]
        )
      ),
    ];
    if (buildIds.length !== 1) {
      const observed = buildIds.length === 0 ? 'none' : buildIds.join(',');
      throw new Error(`concurrency probe crossed builds: ${observed}`);
    }
    console.info(
      [
        CONCURRENCY_PREFIX,
        String(concurrentCases.length),
        (performance.now() - started).toFixed(3),
        Math.max(...results.map((result) => result.elapsedMs)).toFixed(3),
        buildIds[0] ?? '',
      ].join('\t')
    );
  } else if (testCase !== undefined) {
    const cold = await run(testCase);
    const warm: { readonly elapsedMs: number; readonly responseBuildId: string | null }[] = [];
    for (let sample = 0; sample < WARM_SAMPLES; sample += 1) warm.push(await run(testCase));
    const buildIds = [
      ...new Set(
        [cold, ...warm].flatMap((result) =>
          result.responseBuildId === null ? [] : [result.responseBuildId]
        )
      ),
    ];
    if (testCase.expectsInvalidInput !== true && buildIds.length !== 1) {
      throw new Error(`${testCase.label}: process crossed builds`);
    }
    console.info(
      [
        RESULT_PREFIX,
        String(caseIndex),
        encodeURIComponent(testCase.label),
        cold.elapsedMs.toFixed(3),
        warm.map((sample) => sample.elapsedMs.toFixed(3)).join(','),
        buildIds[0] ?? '',
        await processBuildId(),
      ].join('\t')
    );
  }
} finally {
  await app.close();
}
