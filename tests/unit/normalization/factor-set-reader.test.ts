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

import fixture from './fixtures/factor-set-1.json' with { type: 'json' };
import {
  FACTOR_DATASET_IDS,
  makeDatasetFactorSource,
} from '../../../src/modules/budget/shell/factors/dataset-factor-source.js';
import { makeFactorSetSource } from '../../../src/modules/budget/shell/factors/factor-set-source.js';
import { createDatasetRepo } from '../../../src/modules/datasets/index.js';
import { makeFactorSetReader } from '../../../src/modules/normalization/index.js';

import type { FactorKind } from '../../../src/modules/budget/core/legacy-analytics/ports.js';
import type { ProdDatabase } from '../../../src/modules/shared/index.js';

const digest = 'a'.repeat(64);
const row = { kind: 'ron_per_eur', frequency: 'YEAR', periodKey: '2024', value: '4.974600000000' };
const database = (rowsFor: (q: CompiledQuery) => unknown[]) => {
  const queries: CompiledQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(q: CompiledQuery): Promise<QueryResult<R>> {
      queries.push(q);
      return Promise.resolve({ rows: rowsFor(q) as R[] });
    },
    async *streamQuery(): AsyncIterableIterator<QueryResult<never>> {
      /* unused */
    },
  };
  const driver: Driver = {
    init: async () => undefined,
    acquireConnection: async () => connection,
    beginTransaction: async () => undefined,
    commitTransaction: async () => undefined,
    rollbackTransaction: async () => undefined,
    releaseConnection: async () => undefined,
    destroy: async () => undefined,
  };
  const db = new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
};

describe('immutable factor reader', () => {
  it('does not cache the mutable pointer or invent a current set', async () => {
    let current: unknown[] = [];
    const { db } = database(() => current);
    const reader = makeFactorSetReader(db);
    expect((await reader.current())._unsafeUnwrap()).toBeNull();
    current = [{ id: '2' }];
    expect((await reader.current())._unsafeUnwrap()).toBe('2');
    current = [{ id: '1' }];
    expect((await reader.current())._unsafeUnwrap()).toBe('1');
  });

  it('deduplicates concurrent loads and freezes cached payloads', async () => {
    const { db, queries } = database(() => [{ digest, row }]);
    const reader = makeFactorSetReader(db);
    const [a, b] = await Promise.all([reader.load('1'), reader.load('1')]);
    expect(queries).toHaveLength(1);
    expect(a._unsafeUnwrap()).toBe(b._unsafeUnwrap());
    expect(Object.isFrozen(a._unsafeUnwrap().rows)).toBe(true);
    expect(Object.isFrozen(a._unsafeUnwrap().rows[0])).toBe(true);
    expect(a._unsafeUnwrap().manifestDigest).toBe(digest);
    await reader.load('2');
    expect(queries).toHaveLength(2);
    expect(queries[1]?.parameters).toEqual(['2']);
  });

  it('retries missing sets and database failures without caching either', async () => {
    let mode = 0;
    const { db, queries } = database(() => {
      if (mode === 0) return [];
      if (mode === 1) throw new Error('private connection details');
      return [{ digest, row }];
    });
    const reader = makeFactorSetReader(db);
    expect((await reader.load('1'))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    mode = 1;
    expect((await reader.load('1'))._unsafeUnwrapErr()).toEqual({
      type: 'Database',
      message: 'Could not read factor set 1',
    });
    mode = 2;
    expect((await reader.load('1')).isOk()).toBe(true);
    expect(queries).toHaveLength(3);
  });

  it.each(['NaN', 'Infinity', '0', '-1', '3e4'])(
    'rejects malformed/nonpositive factor %s',
    async (value) => {
      const { db } = database(() => [{ digest, row: { ...row, value } }]);
      expect((await makeFactorSetReader(db).load('1'))._unsafeUnwrapErr().type).toBe(
        'ServiceUnavailable'
      );
    }
  );

  it('rejects duplicate and malformed keys, accepting negative inflation', async () => {
    for (const rows of [
      [
        { digest, row },
        { digest, row },
      ],
      [{ digest, row: { ...row, periodKey: '2024-13' } }],
    ]) {
      expect((await makeFactorSetReader(database(() => rows).db).load('1')).isErr()).toBe(true);
    }
    const { db } = database(() => [
      { digest, row: { ...row, kind: 'inflation_rate', value: '-1.5' } },
    ]);
    expect((await makeFactorSetReader(db).load('1')).isOk()).toBe(true);
  });

  it.each(['0', '-1', '1 OR true', '01', '1.0'])(
    'rejects invalid set id %s before querying',
    async (id) => {
      const { db, queries } = database(() => []);
      expect((await makeFactorSetReader(db).load(id))._unsafeUnwrapErr().type).toBe('InvalidInput');
      expect(queries).toHaveLength(0);
    }
  );

  it('explicit pin never calls current and never falls back to missing factors', async () => {
    const { db, queries } = database(() => [{ digest, row }]);
    const source = makeFactorSetSource(makeFactorSetReader(db), '1', digest);
    expect((await source.yearly('ron_per_eur'))._unsafeUnwrap()?.get(2024)?.toString()).toBe(
      '4.9746'
    );
    expect((await source.yearly('gdp_ron'))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.parameters).toEqual(['1']);
  });

  it('rejects a rebuilt database with another manifest at the pinned id', async () => {
    const { db } = database(() => [{ digest: 'b'.repeat(64), row }]);
    const source = makeFactorSetSource(makeFactorSetReader(db), '1', digest);
    expect((await source.yearly('ron_per_eur'))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });

  it('rejects a reader returning a different set id with the expected digest', async () => {
    const { db } = database(() => [{ digest, row }]);
    const reader = makeFactorSetReader(db);
    const source = makeFactorSetSource({ load: () => reader.load('2') }, '1', digest);
    expect((await source.yearly('ron_per_eur'))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });

  it('rejects gaps in a yearly series and ignores subannual factors', async () => {
    const { db } = database(() => [
      { digest, row },
      { digest, row: { ...row, periodKey: '2026' } },
    ]);
    expect(
      (
        await makeFactorSetSource(makeFactorSetReader(db), '1', digest).yearly('ron_per_eur')
      ).isErr()
    ).toBe(true);
    const annual = database(() => [
      { digest, row },
      { digest, row: { ...row, frequency: 'MONTH', periodKey: '2024-01', value: '5' } },
    ]);
    const result = (
      await makeFactorSetSource(makeFactorSetReader(annual.db), '1', digest).yearly('ron_per_eur')
    )._unsafeUnwrap()!;
    expect([...result].map(([year, value]) => [year, value.toString()])).toEqual([
      [2024, '4.9746'],
    ]);
  });

  it('all five set-1 series exactly match current YAML, including every CPI level', async () => {
    const { db } = database(() => fixture.rows.map((r) => ({ digest: fixture.digest, row: r })));
    const source = makeFactorSetSource(makeFactorSetReader(db), '1', fixture.digest);
    const yaml = makeDatasetFactorSource(createDatasetRepo({ rootDir: './datasets/yaml' }));
    let compared = 0;
    for (const kind of Object.keys(FACTOR_DATASET_IDS) as FactorKind[]) {
      const actual = (await source.yearly(kind))._unsafeUnwrap()!;
      const expected = (await yaml.yearly(kind))._unsafeUnwrap()!;
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [year, value] of expected) {
        expect(actual.get(year)?.equals(value), `${kind}/${String(year)}`).toBe(true);
        compared += 1;
      }
    }
    expect(compared).toBe(120);
  });
});
