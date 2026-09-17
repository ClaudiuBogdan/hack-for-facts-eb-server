/** Observed zero and absent reports are distinct; use real DDL and literal amounts. */
import { Decimal } from 'decimal.js';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';

import { cleanFilter } from '@/modules/budget/core/legacy-analytics/clean.js';
import { makeBudgetRepo } from '@/modules/budget/shell/repo/budget-repo.js';
import { legacyAggregateSql } from '@/modules/budget/shell/repo/legacy-analytics-repo.js';

import type { LegacyAnalyticsFilter } from '@/modules/budget/core/legacy-analytics/types.js';
import type { ProdDatabase } from '@/modules/shared/index.js';

type Fixture = (run: (db: Kysely<ProdDatabase>) => Promise<void>) => Promise<void>;

export function registerBudgetObservedZeroCases(
  it: (name: string, run: () => Promise<void>) => void,
  fixture: Fixture
): void {
  it('observed zero preserves gaps, signed compensation and source filters', async () =>
    fixture(async (db) => {
      const rt = 'Executie bugetara detaliata';
      await sql`delete from budget.execution_line_items where reporting_year=2024`.execute(db);
      await sql`create table budget.scope_periods_execution_y2024 partition of budget.scope_periods_execution for values from (2024) to (2025)`.execute(
        db
      );
      const run = (
        await sql<{
          run_id: string;
        }>`insert into etl.load_runs(source_id,target_table) values ('observed-zero-fixture','budget.scope_periods') returning run_id`.execute(
          db
        )
      ).rows[0]!.run_id;
      await sql`insert into budget.reporting_calendar(calendar_version,stream,report_type,report_family,reporting_year,months,valid_from,listing_sha256,source_url)
      values (repeat('a',64),'execution',${rt},'detailed',2024,array[1,2,3,5],now(),repeat('a',64),'https://example.com/listing')`.execute(
        db
      );
      await sql`insert into budget.scope_periods(
      stream,reporting_year,report_id,report_type,report_family,entity_cui,main_creditor_cui,budget_sector_id,reporting_month,
      calendar_version,source_url,xml_sha256,parser_version,configuration_version,membership_sha256,admission_sha256,build_run_id,
      report_status,observation,financially_admitted,continuity,is_latest_present,
      previous_available_month,interval_start_month,months_covered,is_monthly,is_interval,is_quarterly,is_latest_ytd,is_year_end,quarter_span_months)
      select 'execution',2024,v.id,${rt},'detailed','111','111',2,v.month,
        repeat('a',64),'https://example.com/'||v.id,repeat('a',64),'fixture','fixture',repeat('a',64),repeat('a',64),${run}::bigint,
        'final',v.observation,v.admitted,'first',false,
        case when v.month=3 then 2 end,case when v.admitted then v.month end,case when v.admitted then 1 end,
        v.admitted,false,v.month=3,v.month=3,false,case when v.month=3 then 3 end
      from (values ('observed-zero',1,'declared-zero',true),('source-empty',2,'source-empty-no-amounts',false),
        ('compensation',3,'declared-zero',true),('unadmitted-zero',5,'declared-zero',false)) v(id,month,observation,admitted)`.execute(
        db
      );
      await sql`insert into budget.execution_line_items
      (report_id,line_key,line_order,reporting_year,reporting_month,entity_cui,report_type,main_creditor_cui,
       budget_sector_id,account_category,functional_code,economic_code,ytd_amount,monthly_amount,quarterly_amount,
       is_monthly,is_quarterly,is_yearly,quarter)
      values ('compensation','line',1,2024,3,'111',${rt},'111',2,'ch','65','10',0,-25,-25,true,true,true,1)`.execute(
        db
      );
      for (const suffix of ['annual', 'monthly', 'quarterly'])
        await sql`refresh materialized view ${sql.ref('budget.mv_execution_summary_' + suffix)}`.execute(
          db
        );
      const filter: LegacyAnalyticsFilter = {
        account_category: 'ch',
        report_type: rt,
        entity_cuis: ['111'],
        report_period: {
          type: 'MONTH',
          selection: { interval: { start: '2024-01', end: '2024-06' } },
        },
      };
      const read = async (changes: Partial<LegacyAnalyticsFilter> = {}) => {
        const rows = (
          await legacyAggregateSql(
            cleanFilter({ ...filter, ...changes })._unsafeUnwrap(),
            () => undefined
          ).execute(db)
        ).rows;
        return rows.map((r) => [r.period_value, new Decimal(r.amount).toString()]);
      };
      expect(await read()).toEqual([
        [1, '0'],
        [3, '-25'],
      ]);
      expect(await read({ functional_prefixes: ['99'] })).toEqual([[1, '0']]);
      expect(await read({ aggregate_min_amount: 1 })).toEqual([]);
      expect(await read({ main_creditor_cui: '222' })).toEqual([]);
      expect(await read({ budget_sector_ids: ['5'] })).toEqual([]);
      expect(await read({ exclude: { report_ids: ['observed-zero'] } })).toEqual([[3, '-25']]);
      const repo = makeBudgetRepo(db);
      const query = {
        reportType: 'EXECUTION_DETAILED' as const,
        metric: 'EXPENSE' as const,
        frequency: 'MONTH' as const,
        yearFrom: 2024,
        yearTo: 2024,
        normalization: 'TOTAL' as const,
      };
      for (const result of [
        await repo.executionTimeseries({ ...query, entityCui: '111' }),
        await repo.aggregateTimeseries(query),
        await repo.aggregateTimeseries({ ...query, isUat: true }),
        await repo.aggregateTimeseries({ ...query, isTerritorialExecutive: true }),
      ]) {
        if (result.isErr())
          throw new Error(result.error.message, {
            cause: 'cause' in result.error ? result.error.cause : undefined,
          });
        expect(
          result
            ._unsafeUnwrap({ withStackTrace: true })
            .map((r) => [r.periodLabel, new Decimal(r.amount).toString()])
        ).toEqual([
          ['2024-01', '0'],
          ['2024-03', '-25'],
        ]);
      }
    }));
}
