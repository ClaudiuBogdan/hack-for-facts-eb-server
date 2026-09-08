import { Decimal } from 'decimal.js';
import { sql, type Kysely, type KyselyPlugin } from 'kysely';
import { ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeNativeExecutionSeries } from '@/app/native-execution-series.js';
import { readGroupedPopulationAnchors, type LegacyAnalyticsInput } from '@/modules/budget/index.js';
import { makeInsRepo } from '@/modules/ins-native/shell/repo/ins-repo.js';

import { seedSectors } from './ins-native-map-population-cases.js';
import { nativeBudgetAdmission } from './native-budget-cases.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

const Exact = Decimal.clone({ precision: 80 });
const input = (extra: Partial<LegacyAnalyticsInput['filter']> = {}): LegacyAnalyticsInput => ({
  seriesId: 'native',
  filter: {
    account_category: 'ch',
    report_type: 'Executie bugetara detaliata',
    entity_cuis: ['991'],
    report_period: { type: 'YEAR', selection: { dates: ['2018', '2019', '2020'] } },
    normalization: 'per_capita',
    ...extra,
  },
});
export function registerNativeExecutionSeriesCases(
  it: (name: string, run: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>,
  singleConnection: () => Kysely<ProdDatabase>
) {
  it('native execution series use annual population and preserve creditor filters and gaps', async () => {
    const db = database();
    const run = makeNativeExecutionSeries(db, await nativeBudgetAdmission(db), undefined, {
      yearly: async () => ok(null),
    });
    const [all, creditor] = (
      await run([input(), input({ main_creditor_cui: '992' })])
    )._unsafeUnwrap();
    expect(all!.missingPeriods).toEqual(['2018']);
    expect(all!.data.map((p) => p.x)).toEqual(['2019', '2020']);
    expect(all!.data[0]!.y.minus(new Exact(300).div(281105)).abs().lt('1e-35')).toBe(true);
    expect(all!.data[1]!.y.minus(new Exact(300).div(291105)).abs().lt('1e-35')).toBe(true);
    expect(creditor!.data[0]!.y.minus(new Exact(200).div(281105)).abs().lt('1e-35')).toBe(true);
    const bounds = (await run([input({ aggregate_min_amount: 1000 })]))._unsafeUnwrap()[0]!;
    expect(bounds.data).toEqual([]);
    expect(bounds.missingPeriods).toEqual(['2018']);
    expect((await run([input({ entity_cuis: ['991', 'missing'] })]))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
    const bad = makeNativeExecutionSeries(
      db,
      { ...(await nativeBudgetAdmission(db)), custodySha256: '0'.repeat(64) },
      undefined,
      { yearly: async () => ok(null) }
    );
    expect((await bad([input()]))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect((await bad([input({ normalization: 'total' })]))._unsafeUnwrap()[0]!.data).toHaveLength(
      3
    );
  });
  it('native execution series preload CPI FX with pool one and reuse one annual read for five inputs', async () => {
    const db = singleConnection();
    let observationReads = 0;
    const plugin: KyselyPlugin = {
      transformQuery(args) {
        if (JSON.stringify(args.node).includes('observations')) observationReads++;
        return args.node;
      },
      transformResult: (args) => Promise.resolve(args.result),
    };
    const tracked = db.withPlugin(plugin);
    const factorReads: string[] = [];
    try {
      const admitted = await nativeBudgetAdmission(db);
      const run = makeNativeExecutionSeries(tracked, admitted, undefined, {
        yearly: async (kind) => {
          factorReads.push(kind);
          await sql`select 1`.execute(db);
          return ok(
            new Map([
              [2019, new Exact(kind === 'cpi_index' ? 100 : 2)],
              [2020, new Exact(kind === 'cpi_index' ? 110 : 3)],
              [2021, new Exact(kind === 'cpi_index' ? 120 : 4)],
            ])
          );
        },
      });
      const request = input({ currency: 'EUR', inflation_adjusted: true });
      const oneStart = performance.now();
      const one = (await run([request]))._unsafeUnwrap();
      const oneMs = performance.now() - oneStart;
      const oneReads = observationReads;
      observationReads = 0;
      factorReads.length = 0;
      const fiveStart = performance.now();
      const five = (
        await run(
          [
            {},
            { main_creditor_cui: '992' },
            { functional_prefixes: ['65'] },
            { economic_prefixes: ['20'] },
            { functional_codes: ['not-present'] },
          ].map((filter, i) => ({
            ...request,
            filter: { ...request.filter, ...filter },
            seriesId: String(i),
          }))
        )
      )._unsafeUnwrap();
      const fiveMs = performance.now() - fiveStart;
      expect(oneReads).toBeGreaterThan(0);
      expect(observationReads).toBe(oneReads);
      expect(factorReads).toEqual(['cpi_index', 'ron_per_eur']);
      expect(five).toHaveLength(5);
      expect(five.map((s) => s.seriesId)).toEqual(['0', '1', '2', '3', '4']);
      expect(five[2]!.data).toEqual(one[0]!.data);
      expect(five[4]!.data).toEqual([]);
      expect(five[1]!.data[0]!.y.minus(one[0]!.data[0]!.y.mul(2).div(3)).abs().lt('1e-35')).toBe(
        true
      );
      expect(
        one[0]!.data[0]!.y.minus(new Exact(300).mul(1.2).div(4).div(281105)).abs().lt('1e-35')
      ).toBe(true);
      process.stdout.write(
        JSON.stringify({
          nativeSeriesFixture: {
            oneMs,
            fiveMs,
            oneObservationReads: oneReads,
            fiveObservationReads: observationReads,
          },
        }) + '\n'
      );
    } finally {
      await db.destroy();
    }
  });
  it('native execution scopes preserve the old UAT universe and explicit ancestor meaning', async () => {
    const db = database();
    const sector = await seedSectors(db, makeInsRepo(db));
    await sql`insert into core.public_entities(cui,name,is_territorial_executive,is_uat,entity_type,territory_id) values
      ('native-pmb','PMB fixture',true,true,'native-scope',8100),
      ('native-sector','Sector fixture',true,true,'native-scope',8101)`.execute(db);
    try {
      expect(
        await readGroupedPopulationAnchors(db, { kind: 'entityTypes', types: ['native-scope'] })
      ).toEqual([8101]);
      expect(
        await readGroupedPopulationAnchors(db, {
          kind: 'entities',
          cuis: ['native-pmb', 'native-sector'],
        })
      ).toEqual([8100]);
      expect(
        await readGroupedPopulationAnchors(db, { kind: 'territories', ids: [8100, 8101, 8101] })
      ).toEqual([8100]);
      expect(
        await readGroupedPopulationAnchors(db, {
          kind: 'entities',
          cuis: ['native-sector', 'missing'],
        })
      ).toBeNull();
      await sql`insert into core.public_entities(cui,name,is_territorial_executive,is_uat,entity_type) values('native-missing','Missing anchor',true,true,'native-scope')`.execute(
        db
      );
      expect(
        await readGroupedPopulationAnchors(db, { kind: 'entityTypes', types: ['native-scope'] })
      ).toBeNull();
      expect(await readGroupedPopulationAnchors(db, { kind: 'allUats' })).toBeNull();
      await sql`delete from core.public_entities where cui='native-missing'`.execute(db);
      const run = makeNativeExecutionSeries(db, await nativeBudgetAdmission(db), sector, {
        yearly: async () => ok(null),
      });
      const filter = {
        entity_cuis: ['native-sector'],
        report_period: { type: 'YEAR' as const, selection: { dates: ['2023', '2024', '2025'] } },
      };
      const own = (await run([input(filter)]))._unsafeUnwrap()[0]!;
      expect(own.missingPeriods).toEqual(['2023']);
      const parent = (
        await run([input({ ...filter, entity_cuis: ['native-pmb', 'native-sector'] })])
      )._unsafeUnwrap()[0]!;
      expect(parent.missingPeriods).toEqual(['2023', '2024', '2025']);
    } finally {
      await sql`delete from core.public_entities where cui in ('native-pmb','native-sector','native-missing')`.execute(
        db
      );
      await sql`delete from core.territory_population where territory_id between 8101 and 8106`.execute(
        db
      );
      await sql`delete from core.territory_identifiers where territory_id between 8101 and 8106`.execute(
        db
      );
      await sql`delete from core.territories where id between 8101 and 8106`.execute(db);
      await sql`delete from core.territories where id=8100`.execute(db);
    }
  });
}
