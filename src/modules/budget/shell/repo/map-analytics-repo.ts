/** Native execution map aggregation; no pagination, implicit executive filter or floats. */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  andConditions,
  databaseError,
  isCountyTerritory,
  isUatPresentationTerritory,
  timeoutError,
  serviceUnavailable,
  type ProdDatabase,
  type ApiError,
} from '@/modules/shared/index.js';

import { makeFundingSourceMap, type FundingSourceMapLoader } from './funding-source-map.js';
import { legacyAggregateConditions } from './legacy-analytics-repo.js';
import { EXECUTION_AMOUNT_COLUMN } from '../../core/constants.js';

import type {
  BudgetMapGranularity,
  BudgetMapRepo,
  BudgetMapYear,
} from '../../core/legacy-analytics/map-types.js';
import type { LegacyAggregateQuery } from '../../core/legacy-analytics/types.js';

interface MapRow {
  territory_code: string | null;
  year: number;
  amount: string | null;
  invalid_amount: boolean;
  observation_count: string;
  territory_ids: number[];
  coverage: BudgetMapYear['coverage'];
}

/** Exported so actual-DDL tests execute the generated statement, not a SQL imitation. */
export const mapAnalyticsSql = (
  q: LegacyAggregateQuery,
  granularity: BudgetMapGranularity,
  toStoredFundingId: (publicId: number) => number | undefined
): RawBuilder<MapRow> => {
  const amount = sql.ref(`eli.${EXECUTION_AMOUNT_COLUMN[q.frequency]}`);
  // County grouping deliberately includes county institutions and PMB. The UAT
  // presentation exclusion must never be reused to build county numerators.
  const county = granularity === 'County';
  const presentUat = sql`(t.privacy_class = 'public' and ${isUatPresentationTerritory('t')}
    and not (t.county_code = 'B' and t.territorial_siruta_code = '179132'))`;
  const key = county
    ? sql`case when c.matches = 1 and c.public_matches = 1 and t.privacy_class = 'public' then c.county_code end`
    : sql`case when ${presentUat} then t.territorial_siruta_code end`;
  const coverage = county
    ? sql`case when c.matches = 1 and c.public_matches = 1 and t.privacy_class = 'public' then 'mapped' else 'unresolved' end`
    : sql`case when t.id is null then 'unresolved'
        when ${presentUat} then 'mapped'
        when t.privacy_class = 'public' and (t.level in ('country','region','county')
          or (t.level='uat' and t.county_code='B' and t.territorial_siruta_code='179132'))
          then 'outside_view' else 'unresolved' end`;
  return sql<MapRow>`
    with matched as (
      select eli.reporting_year, case when t.privacy_class = 'public' then e.territory_id end as territory_id,
        ${key} as territory_code, ${coverage} as coverage,
        ${amount} as amount
      from budget.execution_line_items eli
      left join core.public_entities e on e.cui = eli.entity_cui
      left join core.territories t on t.id = e.territory_id
      ${q.search === undefined ? sql`` : sql`left join core.organizations o on o.cui = eli.entity_cui`}
      ${county ? sql`left join (select county_code, count(*) as matches, count(*) filter (where privacy_class='public') as public_matches from core.territories county_node where ${isCountyTerritory('county_node')} group by county_code) c on c.county_code = t.county_code` : sql``}
      where ${andConditions(legacyAggregateConditions(q, toStoredFundingId))}
    )
    select territory_code, reporting_year as year, coverage,
      sum(amount)::text as amount,
      bool_or(amount is null or amount::text in ('NaN','Infinity','-Infinity')) as invalid_amount,
      count(*)::text as observation_count,
      coalesce(array_agg(distinct territory_id) filter (where territory_id is not null), '{}'::int[]) as territory_ids
    from matched
    group by territory_code, reporting_year, coverage
    order by territory_code nulls last, reporting_year, coverage
  `;
};

/** Guard the complete selected result before exposing any territory values. */
export const decodeBudgetMapRows = (
  rows: readonly MapRow[]
): Result<readonly BudgetMapYear[], ApiError> => {
  const values: BudgetMapYear[] = [];
  for (const row of rows) {
    if (row.invalid_amount || row.amount === null)
      return err(serviceUnavailable('Selected map amounts are incomplete or invalid'));
    values.push({
      territoryCode: row.territory_code,
      year: row.year,
      nominalAmount: row.amount,
      observationCount: row.observation_count,
      territoryIds: row.territory_ids,
      coverage: row.coverage,
    });
  }
  return ok(values);
};

export const makeBudgetMapRepo = (
  db: Kysely<ProdDatabase>,
  options?: { readonly fundingSourceMap?: FundingSourceMapLoader }
): BudgetMapRepo => {
  const fundingSourceMap = options?.fundingSourceMap ?? makeFundingSourceMap(db);
  return {
    async yearlyAmounts(filter, granularity) {
      try {
        const needsFundingMap =
          filter.fundingSourceIds !== undefined || filter.exclude?.fundingSourceIds !== undefined;
        const mapping = needsFundingMap
          ? (await fundingSourceMap.load()).toStoredId
          : (): undefined => undefined;
        const rows = await db
          .transaction()
          .setAccessMode('read only')
          .execute(async (trx) => {
            await sql`set local statement_timeout = 30000`.execute(trx);
            return (await mapAnalyticsSql(filter, granularity, mapping).execute(trx)).rows;
          });
        return decodeBudgetMapRows(rows);
      } catch (cause) {
        if ((cause as { code?: unknown } | null)?.code === '57014')
          return err(timeoutError('Map query timed out'));
        return err(databaseError('Map query failed', cause));
      }
    },
  };
};
