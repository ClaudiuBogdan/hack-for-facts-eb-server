import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import { databaseError, serviceUnavailable, type ProdDatabase } from '@/modules/shared/index.js';

import { transferExclusion } from './fact-predicates.js';
import { publicEntityIdentitySql } from './legacy-entity-predicates.js';
import {
  COMMITMENT_PERIOD_METRICS,
  type BudgetPeriodRepo,
  type CommitmentPeriodQuery,
} from '../../core/commitment-periods.js';
import { COMMITMENT_REPORT_TYPE_LABELS } from '../../core/constants.js';

interface PeriodRow {
  metadata_available: boolean;
  facts_valid: boolean;
  total: number;
  earliest_terminal: number | null;
  latest_terminal: number | null;
  report_id: string | null;
  budget_sector_id: number;
  creditor_cui: string | null;
  source_url: string;
  reporting_month: number;
  interval_start_month: number | null;
  months_covered: number | null;
  observation: string;
  continuity: string;
  financially_admitted: boolean;
  is_quarterly: boolean;
  is_latest_ytd: boolean;
  is_year_end: boolean;
  amounts: { metric: string; interval: string; ytd: string }[];
}

/** One snapshot for coverage, page and amounts. Nominal RON excluding transfers,
 * like the summary MVs. Presence includes empty sources; only financially
 * admitted endpoints have amounts (including independently admitted zero).
 */
export const commitmentPeriodsSql = (query: CommitmentPeriodQuery) => {
  const reportType = COMMITMENT_REPORT_TYPE_LABELS[query.reportType];
  const metricValues = COMMITMENT_PERIOD_METRICS.map(
    (metric) => sql`jsonb_build_object(
    'metric', ${metric}::text,
    'interval', coalesce(sum(${sql.ref(`f.monthly_${metric}`)}) filter(where ${transferExclusion('f')}),0)::text,
    'ytd', coalesce(sum(${sql.ref(`f.ytd_${metric}`)}) filter(where ${transferExclusion('f')}),0)::text)`
  );
  return sql<PeriodRow>`
    with periods as materialized (
      select p.* from budget.scope_periods p
      left join core.organizations o on o.cui=p.entity_cui
      where p.stream='angajamente' and p.reporting_year=${query.year}
        and p.report_type=${reportType} and p.entity_cui=${query.cui}
        and ${publicEntityIdentitySql('p.entity_cui')}
    ), coverage as (
      select exists(select from periods) metadata_available,
        (select count(*)::integer from periods
          where reporting_month between ${query.startMonth} and ${query.endMonth}) total,
        min(reporting_month) filter(where is_latest_ytd) earliest_terminal,
        max(reporting_month) filter(where is_latest_ytd) latest_terminal
      from periods
    ), page as (
      select * from periods
      where reporting_month between ${query.startMonth} and ${query.endMonth}
      order by reporting_month, budget_sector_id, report_id
      limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
    )
    select c.*, p.*,
      case when ${publicEntityIdentitySql('p.main_creditor_cui')} then p.main_creditor_cui end creditor_cui,
      a.amounts, a.facts_valid
    from coverage c
    left join page p on c.metadata_available
    left join core.organizations o on o.cui=p.main_creditor_cui
    left join lateral (
      select jsonb_build_array(${sql.join(metricValues)}) amounts,
        case when not p.financially_admitted then count(*)=0
          else (p.observation<>'values' or count(*)>0) and coalesce(bool_and(
            row(f.entity_cui,f.main_creditor_cui,f.budget_sector_id,f.reporting_month,
              f.interval_start_month,f.months_covered,f.previous_available_month,
              f.is_monthly,f.is_interval,f.is_quarterly,f.is_latest_ytd,f.is_year_end,
              f.previous_boundary_month,f.quarter_span_months,f.continuity,f.is_yearly)
            is not distinct from
            row(p.entity_cui,p.main_creditor_cui,p.budget_sector_id,p.reporting_month,
              p.interval_start_month,p.months_covered,p.previous_available_month,
              p.is_monthly,p.is_interval,p.is_quarterly,p.is_latest_ytd,p.is_year_end,
              p.previous_boundary_month,p.quarter_span_months,p.continuity,p.is_latest_ytd)
          ),true) end facts_valid
      from budget.commitment_line_items f
      where f.reporting_year=${query.year}
        and f.report_type=${reportType} and f.report_id=p.report_id

    ) a on true
    order by p.reporting_month, p.budget_sector_id, p.report_id
  `;
};

export const makeBudgetPeriodRepo = (db: Kysely<ProdDatabase>): BudgetPeriodRepo => ({
  async listCommitmentPeriods(query) {
    try {
      const { rows } = await commitmentPeriodsSql(query).execute(db);
      if (rows.some((row) => row.report_id !== null && !row.facts_valid)) {
        return err(serviceUnavailable('Published commitment period facts are inconsistent'));
      }
      const coverage = rows[0];
      const available = coverage?.metadata_available === true;
      return ok({
        metadataAvailable: available,
        total: available ? coverage.total : 0,
        earliestTerminalMonth: available ? coverage.earliest_terminal : null,
        latestTerminalMonth: available ? coverage.latest_terminal : null,
        items: rows.flatMap((row) =>
          row.report_id === null
            ? []
            : [
                {
                  reportId: row.report_id,
                  sectorId: row.budget_sector_id,
                  creditorCui: row.creditor_cui,
                  sourceUrl: row.source_url,
                  startMonth: row.interval_start_month,
                  endMonth: row.reporting_month,
                  monthsCovered: row.months_covered,
                  observation: row.observation,
                  continuity: row.continuity,
                  isQuarterly: row.is_quarterly,
                  isLatestYtd: row.is_latest_ytd,
                  isYearEnd: row.is_year_end,
                  amounts: row.amounts.map((amount) => ({
                    metric: amount.metric,
                    interval: row.financially_admitted ? amount.interval : null,
                    ytd: row.financially_admitted ? amount.ytd : null,
                  })),
                },
              ]
        ),
      });
    } catch (error) {
      return err(databaseError('Commitment period read failed', error));
    }
  },
});
