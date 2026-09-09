/**
 * The two helpers that replaced the copies under `src/app/` (review X/F6):
 * ONE population relation shape for every native adapter, and the
 * "load factors before borrowing the snapshot connection" pattern.
 */
import {
  sql,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  DummyDriver,
} from 'kysely';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { populationRelation, preloadFactors, type FactorSource } from '@/modules/budget/index.js';
import { databaseError } from '@/modules/shared/core/errors.js';

import type { AnnualPopulationSnapshot, ProdDatabase } from '@/modules/shared/index.js';

const compilingDb = (): Kysely<ProdDatabase> =>
  new Kysely<ProdDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

const snapshotWith = (
  cells: AnnualPopulationSnapshot['cells'],
  db = compilingDb()
): AnnualPopulationSnapshot => ({ trx: db, cells });

describe('populationRelation', () => {
  it('compiles the port cells into one recordset relation keyed by territory and year', async () => {
    const db = compilingDb();
    const asked: unknown[] = [];
    const relation = await populationRelation(
      snapshotWith((ids, years) => {
        asked.push([ids, years]);
        return Promise.resolve(
          ok([
            { territoryId: 7, year: 2024, population: '1234' },
            { territoryId: 9, year: 2024, population: null },
          ])
        );
      }, db),
      { territoryIds: [7, 9], years: [2024] }
    );
    expect(asked).toEqual([[[7, 9], [2024]]]);
    const compiled = sql`select * from (${relation._unsafeUnwrap()}) x`.compile(db);
    expect(compiled.sql).toContain('jsonb_to_recordset($1::jsonb) as "population"');
    expect(compiled.sql).toContain('(territory_id bigint, year int, population numeric)');
    expect(compiled.parameters[0]).toBe(
      JSON.stringify([
        { territory_id: 7, year: 2024, population: '1234' },
        { territory_id: 9, year: 2024, population: null },
      ])
    );
  });

  it('honours the alias the grouped repo joins on and propagates a port failure', async () => {
    const db = compilingDb();
    const aliased = await populationRelation(
      snapshotWith(() => Promise.resolve(ok([])), db),
      { territoryIds: [], years: [] },
      'p'
    );
    expect(sql`${aliased._unsafeUnwrap()}`.compile(db).sql).toContain(') as "p"(');
    const failed = await populationRelation(
      snapshotWith(() => Promise.resolve(err(databaseError('down'))), db),
      { territoryIds: [1], years: [2024] }
    );
    expect(failed.isErr()).toBe(true);
  });
});

describe('preloadFactors', () => {
  const series = { years: [2024], values: {} } as never;
  const counting = () => {
    const reads: string[] = [];
    const factors: FactorSource = {
      yearly: (kind) => {
        reads.push(kind);
        return Promise.resolve(ok(series));
      },
    };
    return { factors, reads };
  };

  it('reads each needed kind exactly once across plans and serves it from memory afterwards', async () => {
    const { factors, reads } = counting();
    const ready = await preloadFactors(factors, [
      { mode: 'total', currency: 'EUR', inflationAdjusted: true } as never,
      { mode: 'total', currency: 'EUR', inflationAdjusted: true } as never,
    ]);
    const loaded = ready._unsafeUnwrap();
    expect(new Set(reads)).toEqual(new Set(['cpi_index', 'ron_per_eur']));
    expect(reads.length).toBe(2);
    expect((await loaded.yearly('cpi_index'))._unsafeUnwrap()).toBe(series);
    // No new read happened on the way out.
    expect(reads.length).toBe(2);
  });

  it('refuses a kind that was not planned instead of reading it late inside the snapshot', async () => {
    const { factors } = counting();
    const ready = (
      await preloadFactors(factors, [{ mode: 'total', currency: 'RON' } as never])
    )._unsafeUnwrap();
    const late = await ready.yearly('gdp_ron');
    expect(late.isErr()).toBe(true);
    if (late.isErr()) expect(late.error.type).toBe('ServiceUnavailable');
  });

  it('fails the preload when a factor read fails', async () => {
    const factors: FactorSource = { yearly: () => Promise.resolve(err(databaseError('cold'))) };
    const ready = await preloadFactors(factors, [
      { mode: 'total', currency: 'RON', inflationAdjusted: true } as never,
    ]);
    expect(ready.isErr()).toBe(true);
  });
});
