/** One entity, pruned years/report type, complete classification groups. No raw-row export. */
import { sql, type Kysely } from 'kysely';
import { err, ok } from 'neverthrow';

import {
  databaseError,
  serviceUnavailable,
  type AnnualPopulationPort,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { transferExclusion } from './fact-predicates.js';
import { publicEntityIdentitySql } from './legacy-entity-predicates.js';
import { availableYearMoneyFactors } from './money-factor.js';
import {
  DASHBOARD_AMOUNTS,
  type CommitmentDashboardRow,
  type CommitmentDashboardQuery,
  type CommitmentDashboardRepo,
} from '../../core/commitment-dashboard.js';
import { COMMITMENT_REPORT_TYPE_LABELS } from '../../core/constants.js';
import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';
import { readNativeAnnualScopePopulation } from '../native/annual-scope-population.js';

import type { FactorSource } from '../../core/legacy-analytics/ports.js';

// Explicit response-size guard; an oversized entity fails instead of serving partial totals.
export const COMMITMENT_DASHBOARD_MAX_ROWS = 20_000;
export const commitmentDashboardSql = (q: CommitmentDashboardQuery) => {
  const prefix =
    q.frequency === 'YEAR' ? 'ytd_' : q.frequency === 'QUARTER' ? 'quarterly_' : 'monthly_';
  const columns = {
    budget: 'ytd_credite_bugetare_definitive',
    authority: 'ytd_credite_angajament_definitive',
    committed: `${prefix}credite_angajament`,
    paidTreasury: `${prefix}plati_trezor`,
    paidNonTreasury: `${prefix}plati_non_trezor`,
  };
  const role =
    q.frequency === 'YEAR'
      ? sql`p.is_latest_ytd`
      : q.frequency === 'QUARTER'
        ? sql`p.is_quarterly and (p.reporting_month+2)/3=k.period`
        : sql`p.is_monthly and p.reporting_month=k.period`;
  const periodCount = q.frequency === 'YEAR' ? 1 : q.frequency === 'QUARTER' ? 4 : 12;
  const functional = sql`case when f.reporting_year = ${q.detailYear} then f.functional_code else '' end`;
  const economic = sql`case when f.reporting_year = ${q.detailYear} then f.economic_code else null end`;
  const creditor =
    q.mainCreditorCui === undefined ? sql`true` : sql`p.main_creditor_cui=${q.mainCreditorCui}`;
  // Aggregate observed endpoints. Absent sectors do not block differences from
  // present reports; a period with no admitted observation remains a gap.
  return sql<CommitmentDashboardRow>`with periods as materialized (
    select p.* from budget.scope_periods p left join core.organizations o on o.cui=p.entity_cui
    where p.stream='angajamente' and p.reporting_year between ${q.yearFrom} and ${q.yearTo}
      and p.report_type=${COMMITMENT_REPORT_TYPE_LABELS[q.reportType]} and p.entity_cui=${q.cui}
      and ${creditor} and ${publicEntityIdentitySql('p.entity_cui')}
  ), scopes as (
    select distinct reporting_year,budget_sector_id from periods
  ), selected as materialized (
    select s.reporting_year as year,s.budget_sector_id,k.period,p.report_id,p.reporting_month,p.observation,p.financially_admitted,
      a.fact_count,a.facts_valid
    from scopes s cross join generate_series(1,${periodCount}) k(period)
    left join periods p on p.reporting_year=s.reporting_year and p.budget_sector_id=s.budget_sector_id and ${role}
    left join lateral (
      select count(*) fact_count,coalesce(bool_and(
        row(f.entity_cui,f.main_creditor_cui,f.budget_sector_id,f.reporting_month,f.is_monthly,f.is_quarterly,f.is_latest_ytd)
        is not distinct from row(p.entity_cui,p.main_creditor_cui,p.budget_sector_id,p.reporting_month,p.is_monthly,p.is_quarterly,p.is_latest_ytd)
      ),true) facts_valid from budget.commitment_line_items f
      where f.reporting_year between ${q.yearFrom} and ${q.yearTo}
        and f.report_type=${COMMITMENT_REPORT_TYPE_LABELS[q.reportType]}
        and f.reporting_year=p.reporting_year and f.report_type=p.report_type and f.report_id=p.report_id
    ) a on true
  ), coverage as (
    select year,period,min(reporting_month)::int as "firstReportMonth",max(reporting_month)::int as "lastReportMonth",
      count(*)=count(distinct budget_sector_id) and bool_and(report_id is not null and financially_admitted
        and observation in ('values','declared-zero') and facts_valid and (observation='declared-zero' or fact_count>0)) as complete
    from selected where report_id is not null group by 1,2
  ), amounts as (
    select f.reporting_year as year, s.period,
      ${functional} as "functionalCode", ${economic} as "economicCode",
      ${sql.join(DASHBOARD_AMOUNTS.map((key) => sql`case when count(*)=count(${sql.ref(`f.${columns[key]}`)}) then sum(${sql.ref(`f.${columns[key]}`)})::text end as ${sql.id(key)}`))}
    from selected s join budget.commitment_line_items f on f.reporting_year=s.year and f.report_id=s.report_id
      and f.report_type=${COMMITMENT_REPORT_TYPE_LABELS[q.reportType]}
    where f.reporting_year between ${q.yearFrom} and ${q.yearTo} and f.entity_cui=${q.cui}
      and ${transferExclusion('f')}
    group by 1,2,3,4
  ) select c.year,c.period,coalesce(a."functionalCode",'') as "functionalCode",a."economicCode",
    c."firstReportMonth",c."lastReportMonth",
    ${sql.join(DASHBOARD_AMOUNTS.map((key) => sql`case when c.complete then case when a.year is null then '0' else ${sql.ref(`a.${key}`)} end end as ${sql.id(key)}`))}
    from coverage c left join amounts a on a.year=c.year and a.period=c.period
    order by c.year,c.period,a."functionalCode",a."economicCode" nulls first
    limit ${COMMITMENT_DASHBOARD_MAX_ROWS + 1}`;
};

export const makeCommitmentDashboardRepo = (deps: {
  readonly db: Kysely<ProdDatabase>;
  readonly factors: FactorSource;
  readonly population?: AnnualPopulationPort;
}): CommitmentDashboardRepo => ({
  async read(q) {
    try {
      const years = Array.from({ length: q.yearTo - q.yearFrom + 1 }, (_, i) => q.yearFrom + i);
      // Load immutable monetary factors before reserving a population snapshot connection.
      const money = await availableYearMoneyFactors(deps.factors, q.normalization, years, q);
      if (money.isErr()) return err(money.error);
      const perCapita = q.normalization === 'PER_CAPITA' || q.normalization === 'PER_CAPITA_EURO';
      const read = async (
        db: Kysely<ProdDatabase>,
        population?: ReadonlyMap<number, ReturnType<typeof legacyDecimal>>
      ) => {
        const { rows } = await commitmentDashboardSql(q).execute(db);
        if (rows.length > COMMITMENT_DASHBOARD_MAX_ROWS)
          return err(
            serviceUnavailable(
              'Commitment dashboard exceeds the complete response limit; select fewer years'
            )
          );
        const unavailable = new Set<number>();
        const normalized = rows.map((row) => {
          const factor = money.value.get(row.year);
          const denominator = population?.get(row.year);
          if (
            factor === undefined ||
            (perCapita && (denominator === undefined || denominator.lte(0)))
          ) {
            unavailable.add(row.year);
            return {
              ...row,
              budget: null,
              authority: null,
              committed: null,
              paidTreasury: null,
              paidNonTreasury: null,
            };
          }
          const multiplier = legacyDecimal(factor).div(
            perCapita && denominator !== undefined ? denominator : 1
          );
          const amounts = Object.fromEntries(
            DASHBOARD_AMOUNTS.map((key) => [
              key,
              row[key] === null ? null : legacyDecimal(row[key]).mul(multiplier).toFixed(),
            ])
          );
          return { ...row, ...amounts };
        });
        return ok({ rows: normalized, unavailableYears: [...unavailable].sort((a, b) => a - b) });
      };
      if (!perCapita) return await read(deps.db);
      if (deps.population === undefined)
        return err(serviceUnavailable('Annual population is unavailable'));
      return await deps.population.withSnapshot(async (snapshot) => {
        const values = await readNativeAnnualScopePopulation(
          snapshot,
          { kind: 'entities', cuis: [q.cui] },
          years
        );
        return values.isErr() ? err(values.error) : read(snapshot.trx, values.value);
      });
    } catch (cause) {
      return err(databaseError('Commitment dashboard read failed', cause));
    }
  },
});
