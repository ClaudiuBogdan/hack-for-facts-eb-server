import { sql, type RawBuilder } from 'kysely';

import { execMvName } from './budget-repo-shared.js';

import type { BudgetFrequency } from '../../core/constants.js';

interface ObservedSummary {
  entity_cui: string;
  main_creditor_cui: string | null;
  report_type: string;
  year: number;
  month: number | null;
  quarter: number | null;
  total_income: string;
  total_expense: string;
  budget_balance: string;
}

/** Source presence distinguishes an observed all-zero report from an absent
 * report. A zero YTD following nonzero YTD has compensation facts; never replace
 * those signed movements with zero. No financial line items are invented.
 */
export function executionObservedSummary(
  frequency: BudgetFrequency,
  conditions: readonly RawBuilder<unknown>[]
) {
  const monthly = frequency === 'MONTH';
  const quarterly = frequency === 'QUARTER';
  const role = monthly ? sql`p.is_monthly` : quarterly ? sql`p.is_quarterly` : sql`p.is_latest_ytd`;
  const predicate = sql.join(conditions, sql` and `);
  const table = execMvName(frequency).replace(' as mv', '');
  return sql<ObservedSummary>`(with summaries as materialized (
    select mv.entity_cui,mv.main_creditor_cui,mv.report_type,mv.year,
      ${monthly ? sql`mv.month` : sql`null::int`} as month,
      ${quarterly ? sql`mv.quarter` : sql`null::int`} as quarter,
      mv.total_income,mv.total_expense,mv.budget_balance
    from ${sql.table(table)} mv where ${predicate}
  ), observed_zero as (
    select distinct mv.entity_cui,mv.main_creditor_cui,mv.report_type,mv.year,mv.month,mv.quarter
    from (
      select p.*,p.reporting_year as year,
        ${monthly ? sql`p.reporting_month` : sql`null::int`} as month,
        ${quarterly ? sql`(p.reporting_month+2)/3` : sql`null::int`} as quarter
      from budget.scope_periods p where p.stream='execution' and p.financially_admitted
        and p.observation='declared-zero' and ${role}
        and not exists(select from budget.execution_line_items f
          where f.reporting_year=p.reporting_year and f.report_type=p.report_type and f.report_id=p.report_id)
    ) mv where ${predicate}
  ) select * from summaries union all
    select z.*,0::numeric,0::numeric,0::numeric from observed_zero z
    where not exists(select from summaries s
      where row(s.entity_cui,s.main_creditor_cui,s.report_type,s.year,s.month,s.quarter)
        is not distinct from row(z.entity_cui,z.main_creditor_cui,z.report_type,z.year,z.month,z.quarter)))`.as(
    'mv'
  );
}
