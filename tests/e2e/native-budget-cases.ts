/** Real native adapter, public identity and INS source admission over actual DDL. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeNativeBudgetRepo } from '@/app/native-budget-repo.js';
import { makeNativeGroupedClassifications } from '@/app/native-grouped-classifications.js';
import { makeInsRepo } from '@/modules/ins-native/shell/repo/ins-repo.js';

import { seedSectors } from './ins-native-map-population-cases.js';

import type { FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';
import type { TimeseriesQuery } from '@/modules/budget/core/types.js';
import type { GroupedInput } from '@/modules/budget/index.js';
import type { AnnualPopulationAdmission } from '@/modules/ins-native/index.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

export async function seedNativeBudget(db: Kysely<ProdDatabase>): Promise<void> {
  await sql`insert into core.public_entities(cui,name,is_territorial_executive,territory_id)
    values('991','Native county fixture',true,7002)`.execute(db);
  for (const year of [2018, 2019, 2020]) {
    for (const creditor of ['991', '992']) {
      await sql`insert into budget.execution_line_items
        (report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,main_creditor_cui,
         budget_sector_id,account_category,functional_code,economic_code,ytd_amount,monthly_amount,
         quarterly_amount,is_monthly,is_quarterly,is_yearly,quarter)
        values(${`native-${String(year)}-${creditor}`},'fixture',1,${year},12,'991','Executie bugetara detaliata',${creditor},
        1,'ch','65.02.04','20.01.30',${creditor === '991' ? '100' : '200'}::numeric,0,0,false,false,true,null)`.execute(
        db
      );
    }
  }
  await sql`refresh materialized view budget.mv_execution_summary_annual`.execute(db);
}
const Exact = Decimal.clone({ precision: 80 });
const query: TimeseriesQuery = {
  entityCui: '991',
  reportType: 'EXECUTION_DETAILED',
  metric: 'EXPENSE',
  frequency: 'YEAR',
  normalization: 'PER_CAPITA',
  yearFrom: 2018,
  yearTo: 2020,
};
const admission = async (db: Kysely<ProdDatabase>): Promise<AnnualPopulationAdmission> => {
  const dataset = (await makeInsRepo(db).getDataset('POPTEST'))._unsafeUnwrap()!;
  return {
    datasetCode: 'POPTEST',
    revisionId: dataset.revisionId!,
    custodySha256: dataset.custodySha256!,
    transformContractSha256: dataset.transformContractSha256!,
    ageDimension: 0,
    allAgesMember: 1,
    sexDimension: 1,
    allSexesMember: 105,
    personsUnit: 9685,
  };
};
export function registerNativeBudgetCases(
  it: (name: string, run: () => Promise<void>) => void,
  database: () => Kysely<ProdDatabase>,
  singleConnectionDatabase: () => Kysely<ProdDatabase>
): void {
  const groupedInput = (extra: Partial<GroupedInput['filter']> = {}): GroupedInput => ({
    filter: {
      account_category: 'ch',
      report_type: 'Executie bugetara detaliata',
      report_period: { type: 'YEAR', selection: { dates: ['2019', '2020'] } },
      entity_cuis: ['991'],
      normalization: 'per_capita',
      ...extra,
    },
  });
  it('native grouped classifications normalize annual populations before bounds and paging', async () => {
    const db = database();
    const run = makeNativeGroupedClassifications(db, await admission(db), undefined, {
      yearly: async () => ok(null),
    });
    const result = (await run(groupedInput()))._unsafeUnwrap();
    const expected = new Exact(300).div(281105).plus(new Exact(300).div(291105));
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.count).toBe(4);
    expect(result.nodes[0]!.amount.minus(expected).abs().lt('1e-20')).toBe(true);
    expect(result.pageInfo.totalCount).toBe(1);
    const creditor = (await run(groupedInput({ main_creditor_cui: '992' })))._unsafeUnwrap();
    expect(creditor.nodes[0]!.amount.minus(expected.mul(2).div(3)).abs().lt('1e-20')).toBe(true);
    const empty = (await run({ ...groupedInput(), limit: 0 }))._unsafeUnwrap();
    expect(empty.nodes).toEqual([]);
    expect(empty.pageInfo.totalCount).toBe(1);
    const beyond = (await run({ ...groupedInput(), offset: 1 }))._unsafeUnwrap();
    expect(beyond.nodes).toEqual([]);
    expect(beyond.pageInfo.totalCount).toBe(1);
    const rejected = (await run(groupedInput({ aggregate_min_amount: 0.003 })))._unsafeUnwrap();
    expect(rejected.pageInfo.totalCount).toBe(0);
  });
  it('native grouped classification county scope retains full denominator with entity search', async () => {
    const db = database();
    const run = makeNativeGroupedClassifications(db, await admission(db), undefined, {
      yearly: async () => ok(null),
    });
    const result = (
      await run(
        groupedInput({ entity_cuis: undefined, county_codes: ['CJ'], search: 'Native county' })
      )
    )._unsafeUnwrap();
    expect(result.nodes).toHaveLength(1);
    expect(
      result.nodes[0]!.amount.minus(new Exact(300).div(281105).plus(new Exact(300).div(291105)))
        .abs()
        .lt('1e-20')
    ).toBe(true);
    for (const extra of [
      { county_codes: ['CJ', 'XX'], entity_cuis: undefined },
      { uat_ids: ['7002', '999999'], entity_cuis: undefined },
    ]) {
      expect((await run({ ...groupedInput(extra), limit: 0 }))._unsafeUnwrapErr().type).toBe(
        'ServiceUnavailable'
      );
    }
  });

  it('native grouped classifications retain equal-valued siblings and reject incomplete unions', async () => {
    const db = database();
    const run = makeNativeGroupedClassifications(db, await admission(db), undefined, {
      yearly: async () => ok(null),
    });
    const both = (
      await run(groupedInput({ entity_cuis: undefined, county_codes: ['CJ', 'AB'] }))
    )._unsafeUnwrap();
    const expected = new Exact(300).div(562210).plus(new Exact(300).div(582210));
    expect(both.nodes[0]!.amount.minus(expected).abs().lt('1e-20')).toBe(true);
    await sql`insert into core.territories(id,territorial_siruta_code,siruta_code,county_siruta_code,name,county_code,level,kind,territory_key,parent_id) overriding system value values(7004,'1213','1213','10','Aiud','AB','uat','municipality','siruta:1213',7003)`.execute(
      db
    );
    try {
      for (const page of [{ limit: 0 }, { offset: 999 }]) {
        const result = await run({
          ...groupedInput({
            entity_cuis: undefined,
            uat_ids: ['7002', '7004'],
            main_creditor_cui: '991',
            aggregate_min_amount: 10000,
          }),
          ...page,
        });
        expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
      }
    } finally {
      await sql`delete from core.territories where id=7004`.execute(db);
    }
  });
  it('native grouped classifications use admitted sector unions and preserve PMB ancestry', async () => {
    const db = database();
    const sector = await seedSectors(db, makeInsRepo(db));
    await sql`insert into core.public_entities(cui,name,is_territorial_executive,territory_id) values('993','Grouped sector fixture',true,8101)`.execute(
      db
    );
    await sql`insert into budget.execution_line_items(report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,main_creditor_cui,budget_sector_id,account_category,functional_code,economic_code,ytd_amount,monthly_amount,is_yearly,is_monthly,is_quarterly)
      select 'grouped-sector-'||y.year,'fixture',1,y.year,12,'993','Executie bugetara detaliata','993',1,'ch','65.02.04','20.01.30',300,0,true,false,false from (values(2024),(2025)) y(year)`.execute(
      db
    );
    try {
      const run = makeNativeGroupedClassifications(db, await admission(db), sector, {
        yearly: async () => ok(null),
      });
      const input = groupedInput({
        entity_cuis: undefined,
        uat_ids: ['8101', '8102', '8101'],
        report_period: { type: 'YEAR', selection: { dates: ['2024', '2025'] } },
      });
      const siblings = (await run(input))._unsafeUnwrap();
      expect(siblings.nodes[0]!.amount.toString()).toBe('1.9375'); // 300/300 + 300/320
      const own = (
        await run({ ...input, filter: { ...input.filter, uat_ids: ['8101'] } })
      )._unsafeUnwrap();
      expect(
        // PostgreSQL numeric division retains 16 fractional digits for this quotient.
        own.nodes[0]!.amount.minus(new Exact(3).plus(new Exact(300).div(110)))
          .abs()
          .lt('1e-15')
      ).toBe(true);
      const parent = await run({
        ...input,
        filter: { ...input.filter, uat_ids: ['8100', '8101', '8102'] },
        limit: 0,
      });
      expect(parent._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    } finally {
      await sql`delete from budget.execution_line_items where entity_cui='993'`.execute(db);
      await sql`delete from core.public_entities where cui='993'`.execute(db);
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
  it('native grouped classifications reject a missing year or admission before empty pagination', async () => {
    const db = database();
    const admitted = await admission(db);
    const run = makeNativeGroupedClassifications(db, admitted, undefined, {
      yearly: async () => ok(null),
    });
    for (const page of [{ limit: 0 }, { offset: 999 }]) {
      expect(
        (
          await run({
            ...groupedInput({
              report_period: { type: 'YEAR', selection: { dates: ['2018', '2019'] } },
            }),
            ...page,
          })
        )._unsafeUnwrapErr().type
      ).toBe('ServiceUnavailable');
    }
    const unavailable = makeNativeGroupedClassifications(
      db,
      { ...admitted, custodySha256: '0'.repeat(64) },
      undefined,
      { yearly: async () => ok(null) }
    );
    expect((await unavailable({ ...groupedInput(), limit: 0 }))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
    // Nominal requests neither admit nor read INS population.
    const nominal = (await unavailable(groupedInput({ normalization: 'total' })))._unsafeUnwrap();
    expect(nominal.nodes[0]!.amount.toString()).toBe('600');
  });
  it('native grouped classifications preload cold CPI and base-year FX with one connection', async () => {
    const db = singleConnectionDatabase();
    try {
      const reads: string[] = [];
      const factors: FactorSource = {
        yearly: async (kind) => {
          reads.push(kind);
          await sql`select 1`.execute(db);
          return ok(
            new Map([
              [2019, new Exact(kind === 'cpi_index' ? 100 : 2)],
              [2020, new Exact(kind === 'cpi_index' ? 110 : 3)],
              [2021, new Exact(kind === 'cpi_index' ? 120 : 4)],
            ])
          );
        },
      };
      const run = makeNativeGroupedClassifications(db, await admission(db), undefined, factors);
      const result = (
        await run(groupedInput({ currency: 'EUR', inflation_adjusted: true }))
      )._unsafeUnwrap();
      const expected = new Exact(300)
        .mul(120)
        .div(100)
        .div(4)
        .div(281105)
        .plus(new Exact(300).mul(120).div(110).div(4).div(291105));
      expect(result.nodes[0]!.amount.minus(expected).abs().lt('1e-20')).toBe(true);
      expect(reads).toEqual(['cpi_index', 'ron_per_eur']);
    } finally {
      await db.destroy();
    }
  });
  it('native grouped country uses distinct admitted NATIONAL observations, not resident factors', async () => {
    const db = database();
    // Scope this root: existing parent-null counties deliberately exercise old snapshots.
    await sql`insert into core.territories(id,name,level,kind,territory_key,nuts_code) overriding system value values(7999,'Romania','country','country','nuts:RO','RO')`.execute(
      db
    );
    await sql`update core.territories set parent_id=7999 where id in (7002,7003)`.execute(db);
    await sql`update ins.observations set value=value+1000000 where dataset_code='POPTEST' and dim1_member_id=1 and dim2_member_id=105 and dim3_member_id=3064 and dim4_member_id=112`.execute(
      db
    );
    await sql`insert into budget.execution_line_items(report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,main_creditor_cui,budget_sector_id,account_category,functional_code,economic_code,ytd_amount,monthly_amount,is_yearly,is_monthly,is_quarterly)
      values('country-unregistered','fixture',1,2020,12,'994','Executie bugetara detaliata','994',1,'ch','65.02.04','20.01.30',100,0,true,false,false)`.execute(
      db
    );
    try {
      const run = makeNativeGroupedClassifications(db, await admission(db), undefined, {
        yearly: async () => {
          throw new Error('Resident population must not be read');
        },
      });
      const result = (await run(groupedInput({ entity_cuis: undefined })))._unsafeUnwrap();
      const expected = new Exact(300).div(1281105).plus(new Exact(400).div(1291105));
      expect(result.nodes[0]!.amount.minus(expected).abs().lt('1e-20')).toBe(true);
      expect(result.nodes[0]!.count).toBe(5);
      const county = (
        await run(groupedInput({ entity_cuis: undefined, county_codes: ['CJ'] }))
      )._unsafeUnwrap();
      expect(county.nodes[0]!.count).toBe(4);
      expect(
        county.nodes[0]!.amount.minus(new Exact(300).div(281105).plus(new Exact(300).div(291105)))
          .abs()
          .lt('1e-20')
      ).toBe(true);
      for (const page of [{ limit: 0 }, { offset: 999 }]) {
        expect(
          (
            await run({
              ...groupedInput({ entity_cuis: ['991', '994'], aggregate_min_amount: 10000 }),
              ...page,
            })
          )._unsafeUnwrapErr().type
        ).toBe('ServiceUnavailable');
      }
      await sql`update core.territories set parent_id=7002 where id=7999`.execute(db);
      expect(
        (await run({ ...groupedInput({ entity_cuis: undefined }), limit: 0 }))._unsafeUnwrapErr()
          .type
      ).toBe('ServiceUnavailable');
      await sql`update core.territories set parent_id=null where id=7999`.execute(db);
    } finally {
      await sql`delete from budget.execution_line_items where entity_cui='994'`.execute(db);
      await sql`update ins.observations set value=value-1000000 where dataset_code='POPTEST' and dim1_member_id=1 and dim2_member_id=105 and dim3_member_id=3064 and dim4_member_id=112`.execute(
        db
      );
      await sql`update core.territories set parent_id=null where id in (7002,7003)`.execute(db);
      await sql`delete from core.territories where id=7999`.execute(db);
    }
  });
  it('native sparse monetary series use exact yearly factors at every frequency', async () => {
    const db = database();
    let reads = 0;
    const factors: FactorSource = {
      yearly: async (kind) => {
        reads++;
        return ok(
          new Map([
            [2019, new Decimal(kind === 'gdp_ron' ? 1000 : 2)],
            [2020, new Decimal(kind === 'gdp_ron' ? 2000 : 3)],
          ])
        );
      },
    };
    const repo = makeNativeBudgetRepo(db, await admission(db), undefined, factors);
    try {
      await sql`update budget.execution_line_items set is_monthly=true,is_quarterly=true,quarter=4,
        monthly_amount=ytd_amount,quarterly_amount=ytd_amount where entity_cui='991' and line_key='fixture'`.execute(
        db
      );
      await sql`refresh materialized view budget.mv_execution_summary_monthly`.execute(db);
      await sql`refresh materialized view budget.mv_execution_summary_quarterly`.execute(db);
      for (const frequency of ['YEAR', 'MONTH', 'QUARTER'] as const) {
        for (const normalization of ['TOTAL_EURO', 'PERCENT_GDP'] as const) {
          const q = { ...query, normalization, frequency };
          const before = reads;
          const rows = (await repo.executionTimeseries(q))._unsafeUnwrap();
          expect(reads - before).toBe(1);
          expect(rows.map((row) => row.period.year)).toEqual([2019, 2020]);
          expect(rows.map((row) => new Decimal(row.amount).toNumber())).toEqual(
            normalization === 'TOTAL_EURO' ? [150, 100] : [30, 15]
          );
          const aggregate = (
            await repo.aggregateTimeseries({ ...q, yearFrom: 2018, yearTo: 2020 })
          )._unsafeUnwrap();
          expect(aggregate).toEqual(rows);
          const scoped = (
            await repo.executionTimeseries({ ...q, mainCreditorCui: '991' })
          )._unsafeUnwrap();
          scoped.forEach((row, index) => {
            expect(new Decimal(row.amount).mul(3).toFixed(10)).toBe(
              new Decimal(rows[index]!.amount).toFixed(10)
            );
          });
          const zero = (await repo.executionTimeseries({ ...q, metric: 'INCOME' }))._unsafeUnwrap();
          expect(zero).toHaveLength(2);
          expect(zero.every((row) => new Decimal(row.amount).isZero())).toBe(true);
        }
      }
      const perCapita = (
        await repo.executionTimeseries({ ...query, normalization: 'PER_CAPITA_EURO' })
      )._unsafeUnwrap();
      perCapita.forEach((row, index) => {
        expect(new Decimal(row.amount).toFixed(15)).toBe(
          new Decimal(index === 0 ? 150 : 100).div(index === 0 ? 281105 : 291105).toFixed(15)
        );
      });
    } finally {
      await sql`update budget.execution_line_items set is_monthly=false,is_quarterly=false,quarter=null,
        monthly_amount=0,quarterly_amount=0 where entity_cui='991' and line_key='fixture'`.execute(
        db
      );
      await sql`refresh materialized view budget.mv_execution_summary_monthly`.execute(db);
      await sql`refresh materialized view budget.mv_execution_summary_quarterly`.execute(db);
    }
  });
  it('native monetary series propagate admission failures and reject invalid factors', async () => {
    const db = database();
    const a = await admission(db);
    for (const factors of [
      {
        yearly: async () =>
          err({ type: 'ServiceUnavailable' as const, message: 'factor admission failed' }),
      },
      { yearly: async () => ok(new Map([[2019, new Decimal(0)]])) },
      { yearly: async () => ok(null) },
    ]) {
      const repo = makeNativeBudgetRepo(db, a, undefined, factors);
      expect(
        (await repo.executionTimeseries({ ...query, normalization: 'TOTAL_EURO' })).isErr()
      ).toBe(true);
      expect(
        (
          await repo.aggregateTimeseries({
            ...query,
            normalization: 'TOTAL_EURO',
            yearFrom: 2018,
            yearTo: 2020,
          })
        ).isErr()
      ).toBe(true);
      expect(
        (await repo.executionTimeseries({ ...query, normalization: 'TOTAL' }))._unsafeUnwrap()
      ).toHaveLength(3);
    }
  });
  it('cold monetary series complete concurrently with a one-connection pool', async () => {
    const db = singleConnectionDatabase();
    try {
      let reads = 0;
      const factors: FactorSource = {
        yearly: async () => {
          await sql`select 1`.execute(db);
          reads++;
          return ok(
            new Map([
              [2019, new Decimal(2)],
              [2020, new Decimal(3)],
            ])
          );
        },
      };
      const repo = makeNativeBudgetRepo(db, await admission(database()), undefined, factors);
      const results = await Promise.all([
        repo.executionTimeseries({ ...query, normalization: 'PER_CAPITA_EURO' }),
        repo.aggregateTimeseries({
          ...query,
          normalization: 'TOTAL_EURO',
          yearFrom: 2018,
          yearTo: 2020,
        }),
      ]);
      expect(results.map((result) => result._unsafeUnwrap().length)).toEqual([2, 2]);
      expect(reads).toBe(2);
    } finally {
      await db.destroy();
    }
  });
  it('concurrent cold native rankings complete with a single database connection', async () => {
    const db = singleConnectionDatabase();
    try {
      let reads = 0;
      const factors: FactorSource = {
        yearly: async () => {
          await sql`select 1`.execute(db);
          reads++;
          return ok(new Map([[2019, new Decimal('4.7452')]]));
        },
      };
      const repo = makeNativeBudgetRepo(db, await admission(database()), undefined, factors);
      const q = {
        year: 2019,
        reportType: 'EXECUTION_DETAILED' as const,
        frequency: 'YEAR' as const,
        metric: 'EXPENSE' as const,
        normalization: 'TOTAL_EURO' as const,
        entityCuis: ['991'],
        limit: 1,
      };
      const [top, page] = await Promise.all([
        repo.rankEntities(q),
        repo.rankEntitiesPage({ ...q, offset: 0 }),
      ]);
      expect(top._unsafeUnwrap()).toHaveLength(1);
      expect(page._unsafeUnwrap().items).toEqual(top._unsafeUnwrap());
      expect(reads).toBe(2); // One pre-snapshot read per request, none while it holds the connection.
    } finally {
      await db.destroy();
    }
  });
  it('native line-item amounts use the entity annual population across creditor filters and preserve cursors', async () => {
    const db = database();
    const factors: FactorSource = {
      yearly: async () => ok(new Map([[2019, new Decimal('4.7452')]])),
    };
    const repo = makeNativeBudgetRepo(db, await admission(db), undefined, factors);
    const filter = {
      reportingYear: { eq: 2019 },
      reportType: { eq: 'EXECUTION_DETAILED' },
      accountCategory: { eq: 'EXPENSE' },
      frequency: { eq: 'YEAR' },
      entityCuis: { in: ['991'] },
    };
    for (const sort of ['LINE_ORDER', 'AMOUNT_ASC', 'AMOUNT_DESC'] as const) {
      let after: string | undefined;
      for (let page = 0; page < 2; page++) {
        const q = { filter, sort, page: { first: 1, ...(after === undefined ? {} : { after }) } };
        const raw = (await repo.listExecutionLineItems(q))._unsafeUnwrap();
        const normalized = (
          await repo.listExecutionLineItems({ ...q, normalization: 'PER_CAPITA_EURO' })
        )._unsafeUnwrap();
        expect(normalized.next).toBe(raw.next);
        expect(normalized.items.map(({ normalizedAmounts: _amounts, ...item }) => item)).toEqual(
          raw.items
        );
        expect(normalized.items).toHaveLength(1);
        const row = normalized.items[0]!;
        expect(new Decimal(row.normalizedAmounts!.ytdAmount).toFixed(15)).toBe(
          new Decimal(row.ytdAmount).div('4.7452').div(281105).toFixed(15)
        );
        after = raw.next ?? undefined;
      }
    }
    const creditor = (
      await repo.listExecutionLineItems({
        filter: { ...filter, mainCreditorCui: { eq: '992' } },
        sort: 'LINE_ORDER',
        page: { first: 100 },
        normalization: 'PER_CAPITA',
      })
    )._unsafeUnwrap();
    expect(creditor.items).toHaveLength(1);
    expect(new Decimal(creditor.items[0]!.normalizedAmounts!.ytdAmount).toFixed(15)).toBe(
      new Decimal(200).div(281105).toFixed(15)
    );
    for (const normalization of ['PER_CAPITA', 'TOTAL_EURO'] as const) {
      const gap = (
        await repo.listExecutionLineItems({
          filter: { ...filter, reportingYear: { eq: 2018 } },
          sort: 'LINE_ORDER',
          page: { first: 100 },
          normalization,
        })
      )._unsafeUnwrap();
      expect(gap.items).toHaveLength(2);
      expect(gap.items.every((row) => row.normalizedAmounts === null)).toBe(true);
    }
    const bad = makeNativeBudgetRepo(
      db,
      { ...(await admission(db)), custodySha256: 'f'.repeat(64) },
      undefined,
      factors
    );
    const q = {
      filter,
      sort: 'LINE_ORDER' as const,
      page: { first: 100 },
      normalization: 'PER_CAPITA' as const,
    };
    expect((await bad.listExecutionLineItems(q))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
    expect(
      (await bad.listExecutionLineItems({ ...q, normalization: 'TOTAL' }))._unsafeUnwrap().items
    ).toHaveLength(2);
  });
  it('direct normalized fact rows survive cancelling totals in both categories and every frequency', async () => {
    const db = database();
    const repo = makeNativeBudgetRepo(db, await admission(db));
    try {
      for (const category of ['ch', 'vn'])
        for (const [index, value] of [100, -100, 0].entries()) {
          await sql`insert into budget.execution_line_items
          (report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,main_creditor_cui,budget_sector_id,account_category,functional_code,economic_code,ytd_amount,monthly_amount,quarterly_amount,is_monthly,is_quarterly,is_yearly,quarter)
          values('line-normalization','line-normalization-' || ${category} || ${String(index)},${index + 1},2019,12,'991','Executie bugetara detaliata','993',1,${category},'65.02.04','20.01.30',${value},${value / 10},${value / 4},true,true,true,4)`.execute(
            db
          );
        }
      for (const category of ['INCOME', 'EXPENSE'])
        for (const frequency of ['YEAR', 'MONTH', 'QUARTER']) {
          const page = (
            await repo.listExecutionLineItems({
              filter: {
                reportingYear: { eq: 2019 },
                reportType: { eq: 'EXECUTION_DETAILED' },
                accountCategory: { eq: category },
                frequency: { eq: frequency },
                entityCuis: { in: ['991'] },
                mainCreditorCui: { eq: '993' },
              },
              normalization: 'PER_CAPITA',
              sort: 'LINE_ORDER',
              page: { first: 100 },
            })
          )._unsafeUnwrap();
          expect(page.items).toHaveLength(3);
          expect(
            page.items.map((row) => new Decimal(row.normalizedAmounts!.ytdAmount).toFixed(15))
          ).toEqual([100, -100, 0].map((value) => new Decimal(value).div(281105).toFixed(15)));
          expect(
            page.items.map((row) => new Decimal(row.normalizedAmounts!.monthlyAmount).toFixed(15))
          ).toEqual([10, -10, 0].map((value) => new Decimal(value).div(281105).toFixed(15)));
          expect(
            page.items.map((row) =>
              new Decimal(row.normalizedAmounts!.quarterlyAmount!).toFixed(15)
            )
          ).toEqual([25, -25, 0].map((value) => new Decimal(value).div(281105).toFixed(15)));
        }
    } finally {
      await sql`delete from budget.execution_line_items where report_id='line-normalization' and reporting_year=2019`.execute(
        db
      );
    }
  });
  it('rejects normalized line-item scopes without an explicit year and one entity', async () => {
    const db = database();
    const repo = makeNativeBudgetRepo(db, await admission(db));
    const filter = {
      reportingYear: { eq: 2019 },
      reportType: { eq: 'EXECUTION_DETAILED' },
      accountCategory: { eq: 'EXPENSE' },
      frequency: { eq: 'YEAR' },
      entityCuis: { in: ['991'] },
    };
    for (const invalid of [
      { ...filter, entityCuis: { in: [] } },
      { ...filter, entityCuis: { in: ['991', '992'] } },
      { ...filter, entityCuis: { eq: '991' } },
      { ...filter, reportingYear: { between: [2018, 2019] } },
      { ...filter, reportingYear: { in: [2019] } },
    ]) {
      const result = await repo.listExecutionLineItems({
        filter: invalid,
        normalization: 'PER_CAPITA',
        sort: 'LINE_ORDER',
        page: { first: 100 },
      });
      expect(result._unsafeUnwrapErr().type).toBe('InvalidInput');
    }
  });
  it('cold per-capita EUR line items finish with one pool connection', async () => {
    const db = singleConnectionDatabase();
    try {
      const factors: FactorSource = {
        yearly: async () => {
          await sql`select 1`.execute(db);
          return ok(new Map([[2019, new Decimal('4.7452')]]));
        },
      };
      const repo = makeNativeBudgetRepo(db, await admission(database()), undefined, factors);
      const result = await repo.listExecutionLineItems({
        filter: {
          reportingYear: { eq: 2019 },
          reportType: { eq: 'EXECUTION_DETAILED' },
          accountCategory: { eq: 'EXPENSE' },
          frequency: { eq: 'YEAR' },
          entityCuis: { in: ['991'] },
        },
        normalization: 'PER_CAPITA_EURO',
        sort: 'LINE_ORDER',
        page: { first: 100 },
      });
      expect(result._unsafeUnwrap().items).toHaveLength(2);
      expect(result._unsafeUnwrap().items.every((row) => row.normalizedAmounts !== null)).toBe(
        true
      );
    } finally {
      await db.destroy();
    }
  });
  it('native base and snapshot repositories share exact monetary admission', async () => {
    const db = database();
    const factors: FactorSource = {
      yearly: async () => ok(new Map([[2019, new Decimal('4.7452')]])),
    };
    const repo = makeNativeBudgetRepo(db, await admission(db), undefined, factors);
    const q = {
      year: 2019,
      reportType: 'EXECUTION_DETAILED' as const,
      frequency: 'YEAR' as const,
      metric: 'EXPENSE' as const,
      normalization: 'TOTAL_EURO' as const,
      entityCuis: ['991'],
      limit: 1,
    };
    const expected = new Decimal(300).div('4.7452').toFixed(2);
    expect(new Decimal((await repo.rankEntities(q))._unsafeUnwrap()[0]!.amount).toFixed(2)).toBe(
      expected
    );
    expect(
      new Decimal(
        (await repo.rankEntitiesPage({ ...q, offset: 0 }))._unsafeUnwrap().items[0]!.amount
      ).toFixed(2)
    ).toBe(expected);
    const failure: FactorSource = {
      yearly: async () =>
        err({ type: 'ServiceUnavailable', message: 'Unadmitted native factor set' }),
    };
    const denied = makeNativeBudgetRepo(db, await admission(db), undefined, failure);
    for (const result of [
      await denied.rankEntities(q),
      await denied.rankEntitiesPage({ ...q, offset: 999 }),
      await denied.uatHeatmap(q),
      await denied.countyHeatmap(q),
    ])
      expect(result._unsafeUnwrapErr().message).toBe('Unadmitted native factor set');
    expect(
      (await denied.rankEntities({ ...q, normalization: 'TOTAL' }))._unsafeUnwrap()
    ).toHaveLength(1);
  });
  it('native budget adapter uses independently seeded annual INS values and omits missing years', async () => {
    const db = database(),
      repo = makeNativeBudgetRepo(db, await admission(db));
    for (const creditor of [undefined, '991', '992']) {
      const rows = (
        await repo.executionTimeseries({
          ...query,
          ...(creditor === undefined ? {} : { mainCreditorCui: creditor }),
        })
      )._unsafeUnwrap();
      expect(rows.map((r) => r.periodLabel)).toEqual(['2019', '2020']);
      // Source fixture encodes period*10000 + age*1000 + sex. No serving-value oracle.
      rows.forEach((row, index) => {
        expect(
          new Decimal(row.amount)
            .toDecimalPlaces(15)
            .eq(
              new Decimal(creditor === undefined ? 300 : creditor === '991' ? 100 : 200)
                .div(index === 0 ? 281105 : 291105)
                .toDecimalPlaces(15)
            )
        ).toBe(true);
      });
    }
  });
  it('both native ranking entrypoints return annual metadata, including nominal requests and missing years', async () => {
    const db = database(),
      repo = makeNativeBudgetRepo(db, await admission(db));
    for (const year of [2018, 2019, 2020]) {
      const q = {
        year,
        reportType: 'EXECUTION_DETAILED' as const,
        metric: 'EXPENSE' as const,
        frequency: 'YEAR' as const,
        normalization: 'TOTAL' as const,
        entityCuis: ['991'],
        limit: 1,
      };
      const top = (await repo.rankEntities(q))._unsafeUnwrap();
      const page = (await repo.rankEntitiesPage({ ...q, offset: 0 }))._unsafeUnwrap();
      expect(top).toEqual(page.items);
      expect(page.total).toBe(1);
      expect(top[0]!.population).toBe(year === 2018 ? null : year === 2019 ? 281105 : 291105);
      expect(new Decimal(top[0]!.amount).eq(300)).toBe(true);
      if (year === 2018) expect(top[0]!.perCapita).toBeNull();
      else
        expect(
          new Decimal(top[0]!.perCapita!)
            .toDecimalPlaces(15)
            .eq(new Decimal(300).div(year === 2019 ? 281105 : 291105).toDecimalPlaces(15))
        ).toBe(true);
    }
  });
  it('native budget adapter fails admission closed while nominal and empty series remain independent', async () => {
    const db = database(),
      repo = makeNativeBudgetRepo(db, { ...(await admission(db)), custodySha256: 'f'.repeat(64) });
    expect(
      (
        await repo.rankEntities({
          year: 2020,
          reportType: 'EXECUTION_DETAILED',
          frequency: 'YEAR',
          metric: 'EXPENSE',
          normalization: 'TOTAL',
          entityCuis: ['991'],
          limit: 1,
        })
      )._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
    expect((await repo.executionTimeseries(query))._unsafeUnwrapErr().type).toBe(
      'ServiceUnavailable'
    );
    expect(
      (await repo.executionTimeseries({ ...query, normalization: 'TOTAL' }))._unsafeUnwrap()
    ).toHaveLength(3);
    expect(
      (await repo.executionTimeseries({ ...query, mainCreditorCui: '999' }))._unsafeUnwrap()
    ).toEqual([]);
  });
}
