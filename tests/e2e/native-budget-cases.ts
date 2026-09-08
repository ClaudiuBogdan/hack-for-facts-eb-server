/** Real native adapter, public identity and INS source admission over actual DDL. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';
import { expect } from 'vitest';

import { makeNativeBudgetRepo } from '@/app/native-budget-repo.js';
import { makeInsRepo } from '@/modules/ins-native/shell/repo/ins-repo.js';

import type { FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';
import type { TimeseriesQuery } from '@/modules/budget/core/types.js';
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
