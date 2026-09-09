/** Native commitment facts, with report priority chosen per selected entity/year. */
import { sql, type Kysely } from 'kysely';
import { err } from 'neverthrow';

import {
  metricToFactColumn,
  isMetricAvailableForPeriod,
  type CommitmentsMetric,
} from '@/common/types/commitments.js';
import { Frequency } from '@/common/types/temporal.js';
import {
  andConditions,
  databaseError,
  timeoutError,
  invalidInput,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { makeFundingSourceMap } from './funding-source-map.js';
import { legacyAggregateConditions } from './legacy-analytics-repo.js';
import { mapTerritorySql, decodeBudgetMapRows } from './map-analytics-repo.js';
import { COMMITMENT_REPORT_TYPES, COMMITMENT_REPORT_TYPE_LABELS } from '../../core/constants.js';

import type { CommitmentsMapRepo } from '../../core/legacy-analytics/commitments-map.js';
import type { BudgetMapGranularity } from '../../core/legacy-analytics/map-types.js';
import type { LegacyAggregateQuery } from '../../core/legacy-analytics/types.js';

const REPORT_TYPES = COMMITMENT_REPORT_TYPES.map((type) => COMMITMENT_REPORT_TYPE_LABELS[type]);

/** Exported for real-migration DDL tests; all request values remain bound parameters. */
export const commitmentsMapSql = (
  q: LegacyAggregateQuery,
  granularity: BudgetMapGranularity,
  metric: CommitmentsMetric,
  excludeTransfers: boolean,
  toStoredFundingId: (id: number) => number | undefined
) => {
  const column =
    metric === 'RECEPTII_NEPLATITE_CHANGE'
      ? 'monthly_receptii_neplatite'
      : metricToFactColumn(metric, Frequency[q.frequency]);
  const amount = sql.ref(`eli.${column}`);
  const { key, coverage, countyJoin } = mapTerritorySql(granularity);
  const conditions = legacyAggregateConditions(q, toStoredFundingId, {
    amount,
    reportTypes: REPORT_TYPES,
    hasAccountCategory: false,
  });
  if (excludeTransfers)
    conditions.push(
      sql`(eli.economic_code is null or (eli.economic_code not like '51.01%' and eli.economic_code not like '51.02%')) and eli.functional_code not like '36.02.05%' and eli.functional_code not like '37.02.03%' and eli.functional_code not like '37.02.04%' and eli.functional_code not like '47.02.04%'`
    );
  const priority = sql`case eli.report_type when ${REPORT_TYPES[0]} then 1 when ${REPORT_TYPES[1]} then 2 when ${REPORT_TYPES[2]} then 3 else 4 end`;
  return sql<Parameters<typeof decodeBudgetMapRows>[0][number]>`
    with matched as (
      select eli.reporting_year, ${key} as territory_code, ${coverage} as coverage,
        case when t.privacy_class='public' then e.territory_id end as territory_id,
        ${amount} as amount, ${priority} as priority,
        min(${priority}) over (partition by eli.entity_cui, eli.reporting_year) as selected_priority
      from budget.commitment_line_items eli
      left join core.public_entities e on e.cui=eli.entity_cui
      left join core.territories t on t.id=e.territory_id
      ${q.search === undefined ? sql`` : sql`left join core.organizations o on o.cui=eli.entity_cui`}
      ${countyJoin}
      where ${andConditions(conditions)}
    )
    select territory_code, reporting_year as year, coverage, sum(amount)::text as amount,
      bool_or(amount is null or amount::text in ('NaN','Infinity','-Infinity')) as invalid_amount,
      count(*)::text as observation_count,
      coalesce(array_agg(distinct territory_id) filter (where territory_id is not null), '{}'::int[]) as territory_ids
    from matched where priority=selected_priority
    group by territory_code, reporting_year, coverage
    order by territory_code nulls last, reporting_year, coverage
  `;
};

export const makeCommitmentsMapRepo = (db: Kysely<ProdDatabase>): CommitmentsMapRepo => {
  const funding = makeFundingSourceMap(db);
  return {
    async yearlyAmounts(query, granularity, metric, excludeTransfers) {
      if (!isMetricAvailableForPeriod(metric, Frequency[query.frequency]))
        return err(invalidInput('Invalid commitments metric frequency', 'metric'));
      try {
        const needsFunding =
          query.fundingSourceIds !== undefined || query.exclude?.fundingSourceIds !== undefined;
        const mapping = needsFunding
          ? (await funding.load()).toStoredId
          : (): undefined => undefined;
        const rows = await db
          .transaction()
          .setAccessMode('read only')
          .execute(async (trx) => {
            await sql`set local statement_timeout=30000`.execute(trx);
            return (
              await commitmentsMapSql(
                query,
                granularity,
                metric,
                excludeTransfers,
                mapping
              ).execute(trx)
            ).rows;
          });
        return decodeBudgetMapRows(rows);
      } catch (cause) {
        if ((cause as { code?: unknown } | null)?.code === '57014')
          return err(timeoutError('Commitments map query timed out'));
        return err(databaseError('Commitments map query failed', cause));
      }
    },
  };
};
