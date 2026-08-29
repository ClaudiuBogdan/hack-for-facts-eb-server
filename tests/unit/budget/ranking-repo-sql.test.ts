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

import { makeBudgetRepo } from '@/modules/budget/shell/repo/budget-repo.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

interface CapturedQuery {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

const makeCapturingDb = (captured: CapturedQuery[]): Kysely<ProdDatabase> => {
  const connection: DatabaseConnection = {
    executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      captured.push({ sql: query.sql, parameters: query.parameters });
      return Promise.resolve({ rows: [] });
    },
    streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      throw new Error('streamQuery not supported');
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

const flat = (value: string): string => value.replace(/\s+/gu, ' ').trim();

describe('budget ranking repository filters', () => {
  it('uses the requested MV and parameterizes entity scope filters', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'QUARTER',
      quarter: 3,
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      entityCuis: ['111', '222'],
      mainCreditorCui: '999',
      excludeEntityCuis: ['999'],
      limit: 5,
    });

    expect(result.isOk()).toBe(true);
    const query = captured[0];
    expect(query).toBeDefined();
    const sql = flat(query!.sql);
    expect(sql).toContain('from "budget"."mv_execution_summary_quarterly" as "mv"');
    expect(sql).toContain('"mv"."quarter" =');
    expect(sql).toContain('mv.entity_cui in');
    expect(sql).toContain('mv.main_creditor_cui =');
    expect(sql).toContain('mv.entity_cui not in');
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).toContain('group by mv.entity_cui, e.name, mv.year');
    expect(query!.parameters).toEqual(expect.arrayContaining([2025, 3, '111', '222', '999']));
  });

  it('rejects an incompatible period tuple before executing SQL', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      month: 5,
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 5,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field: 'frequency',
    });
    expect(captured).toHaveLength(0);
  });

  it.each([
    ['MONTH', 'month'],
    ['QUARTER', 'quarter'],
  ] as const)('requires the period selected by %s frequency', async (frequency, field) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency,
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 5,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field,
    });
    expect(captured).toHaveLength(0);
  });

  it.each([
    [{ year: 0 }, 'year'],
    [{ mainCreditorCui: '' }, 'mainCreditorCui'],
  ] as const)('rejects invalid core ranking input before SQL', async (override, field) => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      limit: 5,
      ...override,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      type: 'InvalidInput',
      field,
    });
    expect(captured).toHaveLength(0);
  });

  it('compiles explicit empty inclusion filters to false', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'TOTAL',
      entityCuis: [],
      countyCodes: [],
      regions: [],
      limit: 5,
    });

    expect(result.isOk()).toBe(true);
    const sql = flat(captured[0]!.sql);
    expect(sql.match(/\bfalse\b/gu)).toHaveLength(3);
  });

  it('aggregates unscoped creditor rows and groups territory columns for per-capita rank', async () => {
    const captured: CapturedQuery[] = [];
    const repo = makeBudgetRepo(makeCapturingDb(captured));

    const result = await repo.rankEntities({
      year: 2025,
      reportType: 'EXECUTION_DETAILED',
      frequency: 'YEAR',
      metric: 'EXPENSE',
      normalization: 'PER_CAPITA',
      isUat: true,
      limit: 50,
    });

    expect(result.isOk()).toBe(true);
    const query = captured[0];
    expect(query).toBeDefined();
    const sql = flat(query!.sql);
    expect(sql).toContain('sum(coalesce(mv."total_expense",0))');
    expect(sql).not.toContain('mv.main_creditor_cui =');
    expect(sql).toContain('left join "core"."territories" as "t"');
    expect(sql).toContain('group by mv.entity_cui, e.name, mv.year, t.population, t.county_code');
    expect(sql).toContain('case when t.population > 0 then');
  });
});
