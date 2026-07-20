/**
 * Analysis repo over a hand-rolled Kysely driver (canned rows in, executed SQL +
 * parameters out — no mocking library):
 *
 *  - generation micro-cache: single-flight refresh (a concurrent burst issues ONE
 *    statement), TTL-driven via an injected clock, follows the authoritative
 *    active pointer for intentional rollback, errors never cached;
 *  - every rollup statement pins `build_id` to the caller's generation;
 *  - the breakdown statement scans its selected rollup once, excludes
 *    undated-only keys from ranked/other (S9), and keeps money sums
 *    null-preserving (S8);
 *  - the concentration statement discloses the unknown-supplier basis measure in
 *    the same statement (S7);
 *  - the scope cache holds only non-entity scopes.
 */

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';

import { WAVE1_CAPABILITIES, type AnalysisRoute } from '@/modules/procurement/core/combinations.js';
import { makeProcurementAnalysisRepo } from '@/modules/procurement/shell/repo/analysis-repo.js';
import { makeScopeCache } from '@/modules/procurement/shell/scope-cache.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

// ── the recording fake driver ───────────────────────────────────────────────────

interface Recorded {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

interface Recorder {
  readonly queries: Recorded[];
  /** Rows to return, chosen by a substring match on the compiled SQL. May throw. */
  rowsFor: (sql: string) => Record<string, unknown>[];
}

const makeFakeDb = (recorder: Recorder): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      recorder.queries.push({ sql: compiled.sql, parameters: compiled.parameters });
      // A microtask hop so concurrent callers genuinely overlap.
      await Promise.resolve();
      return { rows: recorder.rowsFor(compiled.sql) as R[] };
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: [] };
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

const generationRow = (buildId: string): Record<string, unknown> => ({
  build_id: buildId,
  published_at: '2026-07-12T00:00:00Z',
  quality: {},
  matrix_hash: 'h',
});

const generationQueries = (recorder: Recorder): Recorded[] =>
  recorder.queries.filter((q) => q.sql.includes('analysis_generations'));

const routeFor = (
  rollup: string,
  grain: AnalysisRoute['grain'] = 'direct_acquisition'
): AnalysisRoute => {
  const capability = WAVE1_CAPABILITIES.find((cap) => cap.rollup === rollup);
  if (capability === undefined) throw new Error(`no capability ${rollup}`);
  return { rollup: capability, grain };
};

describe('raw quality jsonb parsing (fail-safe, spend-class widening)', () => {
  const rawVerdict = (spend: string): Record<string, unknown> => ({
    coverage: { date: 0.97, value: 0.99, geo: 0.9, cpv: 0.95 },
    classes: { spend, time: 'allow', geo: 'allow' },
  });

  it("accepts 'allow' AND 'allow_disclosed'; DROPS an unknown spend class", async () => {
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => [
        {
          ...generationRow('50'),
          quality: {
            direct_acquisition: rawVerdict('allow'),
            procedure: rawVerdict('allow_disclosed'),
            // a future/unknown class must be dropped, not admitted — the
            // grain then abstains ('no quality verdict'), the fail-safe.
            contract: rawVerdict('partial'),
          },
        },
      ],
    };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);
    const gen = (await repo.activeGeneration())._unsafeUnwrap();
    expect(gen?.quality.direct_acquisition?.classes.spend).toBe('allow');
    expect(gen?.quality.procedure?.classes.spend).toBe('allow_disclosed');
    expect(gen?.quality.contract).toBeUndefined();
  });
});

describe('generation micro-cache', () => {
  it('single-flights a concurrent burst into ONE statement and caches the result', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => [generationRow('42')] };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);

    const results = await Promise.all([
      repo.activeGeneration(),
      repo.activeGeneration(),
      repo.activeGeneration(),
    ]);
    for (const r of results) expect(r._unsafeUnwrap()?.buildId).toBe('42');
    expect(generationQueries(recorder)).toHaveLength(1);

    // Within the TTL: served from cache, still one statement.
    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('42');
    expect(generationQueries(recorder)).toHaveLength(1);
  });

  it('refreshes after the TTL and follows an intentional active-generation rollback', async () => {
    let clock = 0;
    let nextBuild = '43';
    const recorder: Recorder = { queries: [], rowsFor: () => [generationRow(nextBuild)] };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => clock);

    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('43');

    // The active row is authoritative: operators retain N-1 specifically so
    // they can reactivate it when the current generation must be rolled back.
    clock = 10_000;
    nextBuild = '42';
    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('42');
    expect(generationQueries(recorder)).toHaveLength(2);

    // A genuinely newer build wins.
    clock = 20_000;
    nextBuild = '44';
    expect((await repo.activeGeneration())._unsafeUnwrap()?.buildId).toBe('44');
  });

  it('serves ok(null) when unpublished and never caches an errored refresh', async () => {
    let fail = true;
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => {
        if (fail) throw new Error('boom');
        return [];
      },
    };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);

    expect((await repo.activeGeneration()).isErr()).toBe(true);
    fail = false;
    expect((await repo.activeGeneration())._unsafeUnwrap()).toBeNull();
    // Both calls hit the DB — the error was not memoized.
    expect(generationQueries(recorder)).toHaveLength(2);
  });
});

describe('rollup statements', () => {
  const statsRows = (): Record<string, unknown>[] => [
    {
      rows: '10',
      with_value: '8',
      with_estimated: '5',
      value_awarded_sum: null,
      value_estimated_sum: null,
      min_month: null,
      max_month: null,
      undated_count: '0',
      undated_value_ron: null,
    },
  ];

  it('pins every read to the caller-provided build_id', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => statsRows() };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);

    const read = await repo.statsFor(routeFor('authorityDims'), { authorityCui: 'x' }, '77');
    expect(read.isOk()).toBe(true);
    const query = recorder.queries[0];
    expect(query?.sql).toContain('build_id = ');
    expect(query?.parameters).toContain('77');
    // Null SQL money sums survive as null — never coalesced to '0' (S8).
    expect(read._unsafeUnwrap().valueAwardedSum).toBeNull();
  });

  it('maps PostgreSQL 57014 to Timeout and logs only safe diagnostics', async () => {
    const canceled = Object.assign(new Error('statement timeout with private SQL'), {
      code: '57014',
    });
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => {
        throw canceled;
      },
    };
    const warnings: unknown[] = [];
    const logger = {
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      warn: (obj: unknown) => warnings.push(obj),
    };
    const repo = makeProcurementAnalysisRepo(
      makeFakeDb(recorder),
      makeScopeCache(),
      () => 100,
      logger
    );

    const result = await repo.statsFor(
      routeFor('authorityDims'),
      { authorityCui: 'sensitive' },
      '77'
    );
    expect(result._unsafeUnwrapErr().type).toBe('Timeout');
    expect(warnings[0]).toMatchObject({
      operation: 'stats',
      grain: 'direct_acquisition',
      rollup: 'authorityDims',
      buildId: '77',
      postgresCode: '57014',
    });
    expect(JSON.stringify(warnings)).not.toContain('private SQL');
    expect(JSON.stringify(warnings)).not.toContain('sensitive');
  });

  it('keeps ordinary PostgreSQL failures classified as Database', async () => {
    const recorder: Recorder = {
      queries: [],
      rowsFor: () => {
        throw Object.assign(new Error('connection reset'), { code: '08006' });
      },
    };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 100);

    const result = await repo.statsFor(
      routeFor('authorityDims'),
      { authorityCui: '4267117' },
      '77'
    );
    expect(result._unsafeUnwrapErr().type).toBe('Database');
  });

  it('breakdown ranks only keys with a dated contribution and keeps money nullable', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => [] };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);

    await repo.breakdownFor(
      routeFor('authorityDims'),
      { authorityCui: 'x', from: '2024-01', to: '2024-06' },
      '77',
      'cpvDivision',
      10,
      'value'
    );
    const sql = recorder.queries[0]?.sql ?? '';
    // S9: undated-only keys (no dated rows, no dated money) never rank.
    expect(sql).toMatch(/rc > 0 or coalesce\(va, 0\) <> 0/u);
    expect(sql).toMatch(/desc nulls last/u);
    // S8: the money sum is raw (nullable), not coalesced to zero.
    expect(sql).not.toMatch(/coalesce\(sum\(value_awarded_sum\) filter \(where .*\), 0\)/u);
    // The undated bucket rides in the SAME statement.
    expect(sql).toMatch(/month_start is null/u);
  });

  it.each([
    { grain: 'contract' as const, bounded: false },
    { grain: 'contract' as const, bounded: true },
    { grain: 'direct_acquisition' as const, bounded: false },
    { grain: 'direct_acquisition' as const, bounded: true },
  ])(
    'uses one $grain rollup scan when bounded=$bounded and preserves null/undated totals',
    async ({ grain, bounded }) => {
      const recorder: Recorder = {
        queries: [],
        rowsFor: () => [
          {
            kind: 'top',
            key: 'supplier-1',
            rc: '4',
            wv: '0',
            va: null,
            we: null,
            ve: null,
            min_month: null,
            max_month: null,
            undated_rc: null,
            undated_va: null,
          },
          {
            kind: 'other',
            key: null,
            rc: '2',
            wv: '1',
            va: '10.00',
            we: null,
            ve: null,
            min_month: null,
            max_month: null,
            undated_rc: null,
            undated_va: null,
          },
          {
            kind: 'unknown',
            key: null,
            rc: '1',
            wv: '0',
            va: null,
            we: null,
            ve: null,
            min_month: null,
            max_month: null,
            undated_rc: null,
            undated_va: null,
          },
          {
            kind: 'total',
            key: null,
            rc: '7',
            wv: '1',
            va: '10.00',
            we: '3',
            ve: null,
            min_month: '2024-01',
            max_month: '2024-06',
            undated_rc: '2',
            undated_va: null,
          },
        ],
      };
      const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);
      const scope = bounded
        ? { authorityCui: 'authority-1', from: '2024-01', to: '2024-06' }
        : { authorityCui: 'authority-1' };

      const result = await repo.breakdownFor(
        routeFor('edge', grain),
        scope,
        '77',
        'supplier',
        10,
        'value'
      );

      expect(result.isOk()).toBe(true);
      const sql = recorder.queries[0]?.sql ?? '';
      expect(sql.match(/analysis_rollup_edge_monthly/gu) ?? []).toHaveLength(1);
      expect(sql).toMatch(/per_key as materialized/u);
      expect(sql).not.toMatch(/with base as/u);
      expect(sql.includes('month_start >=')).toBe(bounded);
      expect(recorder.queries[0]?.parameters).toContain(grain);

      const read = result._unsafeUnwrap();
      expect(read.buckets).toEqual([
        {
          kind: 'top',
          key: 'supplier-1',
          recordCount: '4',
          withValue: '0',
          valueAwardedSum: null,
        },
        {
          kind: 'other',
          key: null,
          recordCount: '2',
          withValue: '1',
          valueAwardedSum: '10.00',
        },
        {
          kind: 'unknown',
          key: null,
          recordCount: '1',
          withValue: '0',
          valueAwardedSum: null,
        },
      ]);
      expect(read.totals).toEqual({
        rows: '7',
        withValue: '1',
        valueAwardedSum: '10.00',
        withEstimated: '3',
        valueEstimatedSum: null,
        minMonth: '2024-01',
        maxMonth: '2024-06',
        undatedCount: '2',
        undatedValueRon: null,
      });
    }
  );

  it('concentration discloses the unknown-supplier basis measure in the same statement', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => [] };
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), makeScopeCache(), () => 0);

    await repo.concentrationRowsFor(routeFor('edge'), { authorityCui: 'x' }, '77', 'value');
    const sql = recorder.queries[0]?.sql ?? '';
    expect(sql).toMatch(/supplier_cui is null/u);
    expect(recorder.queries).toHaveLength(1); // one statement, totals + unknown included
  });

  it('caches non-entity scopes and never caches entity scopes', async () => {
    const recorder: Recorder = { queries: [], rowsFor: () => statsRows() };
    const cache = makeScopeCache();
    const repo = makeProcurementAnalysisRepo(makeFakeDb(recorder), cache, () => 0);

    await repo.statsFor(routeFor('authorityDims'), { cpvDivision: '33' }, '77');
    await repo.statsFor(routeFor('authorityDims'), { cpvDivision: '33' }, '77');
    expect(recorder.queries.filter((q) => q.sql.includes('cpv_division')).length).toBe(1);

    await repo.statsFor(routeFor('authorityDims'), { authorityCui: 'x' }, '77');
    await repo.statsFor(routeFor('authorityDims'), { authorityCui: 'x' }, '77');
    expect(recorder.queries.filter((q) => q.sql.includes('authority_cui')).length).toBe(2);
  });
});
