/** Real native adapter, public identity and INS source admission over actual DDL. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { makeNativeBudgetRepo } from '@/app/native-budget-repo.js';
import { makeInsRepo } from '@/modules/ins-native/shell/repo/ins-repo.js';

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
  database: () => Kysely<ProdDatabase>
): void {
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
  it('native budget adapter fails admission closed while nominal and empty series remain independent', async () => {
    const db = database(),
      repo = makeNativeBudgetRepo(db, { ...(await admission(db)), custodySha256: 'f'.repeat(64) });
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
