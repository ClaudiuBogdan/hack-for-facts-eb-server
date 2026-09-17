/** Read-side eligibility over real DDL; literal expectations do not reuse SQL predicates. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { makeBudgetRepo } from '@/modules/budget/shell/repo/budget-repo.js';
import { makeLegacyAnalyticsRepo } from '@/modules/budget/shell/repo/legacy-analytics-repo.js';
import {
  mapAnalyticsSql,
  decodeBudgetMapRows,
} from '@/modules/budget/shell/repo/map-analytics-repo.js';

import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;

export function registerBudgetPeriodEligibilityCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
): void {
  for (const frequency of ['YEAR', 'MONTH', 'QUARTER'] as const) {
    it(`period eligibility excludes unsupported spans at ${frequency} frequency`, async () =>
      fixture(async (db) => {
        // This transaction is rolled back in the disposable test database.
        await sql`delete from budget.execution_line_items where reporting_year=2024`.execute(db);
        await sql`insert into budget.execution_line_items
          (report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,
           main_creditor_cui,budget_sector_id,account_category,functional_code,economic_code,
           funding_source,funding_source_id,program_code,ytd_amount,monthly_amount,quarterly_amount,
           is_monthly,is_quarterly,is_yearly,quarter)
          select 'eligibility-'||v.code,v.code,v.ord,2024,v.month,'111','Executie bugetara detaliata',
            '111',2,'ch','65.02.04','10.01.01','A',f.source_id,v.code,v.ytd,v.monthly,v.quarterly,
            v.month_ok,v.quarter_ok,true,v.quarter
          from (values
            ('interval',1,8,100::numeric,100::numeric,100::numeric,false,false,3),
            ('signed',2,8,80::numeric,-20::numeric,80::numeric,true,false,3),
            ('zero',3,3,40::numeric,0::numeric,40::numeric,true,true,1)
          ) v(code,ord,month,ytd,monthly,quarterly,month_ok,quarter_ok,quarter)
          cross join budget.funding_sources f where f.source_code='A'`.execute(db);
        for (const suffix of ['annual', 'monthly', 'quarterly']) {
          await sql`refresh materialized view ${sql.ref('budget.mv_execution_summary_' + suffix)}`.execute(
            db
          );
        }
        const expected = frequency === 'YEAR' ? '220' : frequency === 'MONTH' ? '-20' : '40';
        const expectedCodes =
          frequency === 'YEAR'
            ? ['interval', 'signed', 'zero']
            : frequency === 'MONTH'
              ? ['signed', 'zero']
              : ['zero'];
        const expectedPoints =
          frequency === 'YEAR'
            ? [['2024', '220']]
            : frequency === 'MONTH'
              ? [
                  ['2024-03', '0'],
                  ['2024-08', '-20'],
                ]
              : [['2024-Q1', '40']];
        const repo = makeBudgetRepo(db);
        const items = (
          await repo.listExecutionLineItems({
            filter: {
              reportingYear: { eq: 2024 },
              reportType: { eq: 'EXECUTION_DETAILED' },
              accountCategory: { eq: 'EXPENSE' },
              frequency: { eq: frequency },
              entityCuis: { in: ['111'] },
            },
            normalization: 'TOTAL',
            sort: 'LINE_ORDER',
            page: { first: 100 },
          })
        )._unsafeUnwrap({ withStackTrace: true }).items;
        expect(items.map((row) => row.programCode)).toEqual(expectedCodes);
        const sum = (values: readonly string[]): string =>
          values.reduce((a, b) => a.plus(b), new Decimal(0)).toString();
        expect(
          sum(
            items.map((row) =>
              frequency === 'YEAR'
                ? row.ytdAmount
                : frequency === 'MONTH'
                  ? row.monthlyAmount
                  : row.quarterlyAmount!
            )
          )
        ).toBe(expected);
        const classification = (
          await repo.aggregateByClassification({
            filter: {
              reportingYear: { eq: 2024 },
              reportType: { eq: 'EXECUTION_DETAILED' },
              accountCategory: { eq: 'EXPENSE' },
              frequency: { eq: frequency },
              entityCuis: { in: ['111'] },
            },
            normalization: 'TOTAL',
            limit: 50,
          })
        )._unsafeUnwrap({ withStackTrace: true });
        expect(classification).toHaveLength(1);
        expect(new Decimal(classification[0]!.amount).toString()).toBe(expected);
        const query = {
          reportType: 'EXECUTION_DETAILED' as const,
          metric: 'EXPENSE' as const,
          frequency,
          yearFrom: 2024,
          yearTo: 2024,
          normalization: 'TOTAL' as const,
        };
        for (const result of [
          await repo.aggregateTimeseries(query),
          await repo.executionTimeseries({ ...query, entityCui: '111' }),
        ]) {
          expect(
            result
              ._unsafeUnwrap({ withStackTrace: true })
              .map((row) => [row.periodLabel, new Decimal(row.amount).toString()])
          ).toEqual(expectedPoints);
        }
        const dates =
          frequency === 'YEAR'
            ? ['2024']
            : frequency === 'MONTH'
              ? ['2024-03', '2024-08']
              : ['2024-Q1', '2024-Q3'];
        const filter: LegacyAnalyticsFilter = {
          account_category: 'ch',
          entity_cuis: ['111'],
          report_type: 'Executie bugetara detaliata',
          report_period: { type: frequency, selection: { dates } },
        };
        const cleaned = cleanFilter(filter)._unsafeUnwrap({ withStackTrace: true });
        const legacy = (
          await makeLegacyAnalyticsRepo(db).legacyExecutionAggregate(cleaned)
        )._unsafeUnwrap({ withStackTrace: true }).rows;
        expect(sum(legacy.map((row) => row.amount))).toBe(expected);
        expect(legacy.map((row) => new Decimal(row.amount).toString())).toEqual(
          expectedPoints.map((row) => row[1])
        );
        for (const level of ['UAT', 'County'] as const) {
          // Execute the repository SQL inside this rollback fixture; its public wrapper opens its own transaction.
          const rows = (await mapAnalyticsSql(cleaned, level, () => undefined).execute(db)).rows;
          const map = decodeBudgetMapRows(rows)._unsafeUnwrap({ withStackTrace: true });
          expect(map).toHaveLength(1);
          expect(new Decimal(map[0]!.nominalAmount).toString()).toBe(expected);
        }
      }));
  }
}
