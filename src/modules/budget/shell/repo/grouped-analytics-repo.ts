/** Native grouped fact aggregation. Money, coverage, ordering and paging stay in SQL. */
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  andConditions,
  databaseError,
  serviceUnavailable,
  timeoutError,
  organizationIdentifierIsServable,
  organizationRowIsPublic,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { makeFundingSourceMap, type FundingSourceMapLoader } from './funding-source-map.js';
import { legacyAggregateConditions, legacyJoinNeeds } from './legacy-analytics-repo.js';
import { budgetEntityNameSql } from './legacy-entity-predicates.js';
import { EXECUTION_AMOUNT_COLUMN } from '../../core/constants.js';
import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';

import type {
  GroupedAnalyticsRepo,
  GroupedQuery,
  GroupedPage,
  GroupedEntity,
  GroupedClassification,
} from '../../core/legacy-analytics/grouped-types.js';

type Db = Kysely<ProdDatabase>;
type Grouping = 'entity' | 'classification';

/** A resolved population basis must produce at most one row per territory/year.
 * Only the explicit S1b snapshot adapter ships now. Annual custody/vintage is a later gate.
 */
export type TerritoryPopulationRelation = (years: readonly number[]) => RawBuilder<unknown>;
export const snapshotTerritoryPopulationSql: TerritoryPopulationRelation = (years) => sql`
  select t.id as territory_id, y.year, t.population
  from core.territories t
  cross join (values ${sql.join(years.map((year) => sql`(${year}::int)`))}) y(year)
`;

interface DbRow {
  entity_cui: string | null;
  entity_name: string | null;
  entity_type: string | null;
  uat_id: string | null;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  total_amount: string | null;
  per_capita_amount: string | null;
  amount: string | null;
  functional_code: string | null;
  functional_name: string | null;
  economic_code: string | null;
  economic_name: string | null;
  count: string | null;
  total_count: string;
  missing_coverage: boolean;
}

const requiredText = (value: string | null): string => {
  if (value === null) throw new Error('Incomplete grouped analytics row');
  return value;
};

const SORT_COLUMNS = {
  AMOUNT: 'amount',
  TOTAL_AMOUNT: 'total_amount',
  PER_CAPITA_AMOUNT: 'per_capita_amount',
  ENTITY_NAME: 'entity_name',
  ENTITY_TYPE: 'entity_type',
  POPULATION: 'population',
  COUNTY_NAME: 'county_name',
  COUNTY_CODE: 'county_code',
} as const;

/** Exported for real-PostgreSQL EXPLAIN and independent numeric parity tests. */
export const groupedAnalyticsSql = (
  grouping: Grouping,
  query: GroupedQuery,
  toStoredFundingId: (id: number) => number | undefined,
  populationRelation: TerritoryPopulationRelation = snapshotTerritoryPopulationSql
): RawBuilder<DbRow> => {
  const q = query.filter;
  const entity = grouping === 'entity';
  const conditions = legacyAggregateConditions(q, toStoredFundingId);
  if (entity)
    conditions.push(
      organizationIdentifierIsServable('eli.entity_cui'),
      sql`(o.org_id is null or ${organizationRowIsPublic('o.privacy_class')})`
    );
  const joins = legacyJoinNeeds(q);
  const joinEntity = entity || joins.entity || query.requirePopulation;
  const joinTerritory = entity || joins.territory;
  const joinOrganization = entity || q.search !== undefined;
  const years = [...query.moneyMultipliers.keys()];
  const factorValues = [...query.moneyMultipliers].map(
    ([year, multiplier]) => sql`(
    ${year}::int, ${multiplier.toFixed()}::numeric,
    ${query.scopePopulations?.get(year)?.toString() ?? null}::numeric
  )`
  );
  const functional = entity ? sql`null::text` : sql`eli.functional_code`;
  const economic = entity ? sql`null::text` : sql`eli.economic_code`;
  const bounds: RawBuilder<unknown>[] = [];
  if (q.aggregateMinAmount !== undefined)
    bounds.push(sql`amount >= ${q.aggregateMinAmount}::numeric`);
  if (q.aggregateMaxAmount !== undefined)
    bounds.push(sql`amount <= ${q.aggregateMaxAmount}::numeric`);
  if (entity && query.mode === 'per_capita') bounds.push(sql`executive = true`);
  const primary = query.mode === 'per_capita' ? sql`per_capita_amount` : sql`total_amount`;
  const sortColumn = entity ? SORT_COLUMNS[query.sort.by] : 'amount';
  const direction = entity && query.sort.order === 'ASC' ? sql`asc` : sql`desc`;
  const order = (alias: string) => sql`${sql.ref(`${alias}.${sortColumn}`)} ${direction} nulls last,
    ${entity ? sql`${sql.ref(`${alias}.entity_cui`)} asc` : sql`${sql.ref(`${alias}.functional_code`)} asc, ${sql.ref(`${alias}.economic_code`)} asc nulls last`}`;
  const entityFields = sql`
    entity_cui, max(entity_name) as entity_name, max(entity_type) as entity_type,
    max(uat_id)::text as uat_id, max(county_code) as county_code, max(county_name) as county_name,
    case when bool_and(population > 0) and count(population) = count(*)
      and min(population) = max(population) then max(population) else null end as population,
    bool_or(executive) as executive,
    null::text as functional_code, null::text as functional_name,
    null::text as economic_code, null::text as economic_name`;
  const classificationFields = sql`
    null::text as entity_cui, null::text as entity_name, null::text as entity_type,
    null::text as uat_id, null::text as county_code, null::text as county_name,
    null::int as population, null::boolean as executive,
    functional_code, max(functional_name) as functional_name,
    economic_code, max(economic_name) as economic_name`;
  const divisor = entity ? sql`population` : sql`scope_population`;
  return sql<DbRow>`
    with factors(year, multiplier, scope_population) as (values ${sql.join(factorValues)}),
    populations as (${populationRelation(years)}),
    year_groups as materialized (
      select ${entity ? sql`eli.entity_cui` : sql`null::text`} as entity_cui, eli.reporting_year, ${functional} as functional_code,
        ${economic} as economic_code,
        max(eli.functional_name) as functional_name, max(eli.economic_name) as economic_name,
        ${
          entity
            ? sql`
          max(${budgetEntityNameSql(sql`eli.entity_cui`)}) as entity_name,
          max(e.entity_type) as entity_type, max(t.id) as uat_id,
          max(t.county_code) as county_code, max(t.county_name) as county_name,
          case when bool_or(e.is_territorial_executive) then max(p.population) else null end as population,
        `
            : sql`null::text as entity_name, null::text as entity_type, null::int as uat_id,
          null::text as county_code, null::text as county_name, null::int as population,`
        }
        ${joinEntity ? sql`bool_and(e.cui is not null and e.is_territorial_executive is not null)` : sql`true`} as registry_known,
        ${joinEntity ? sql`bool_or(e.is_territorial_executive)` : sql`false`} as executive,
        sum(${sql.ref(`eli.${EXECUTION_AMOUNT_COLUMN[q.frequency]}`)}) as nominal_amount,
        count(*) as count
      from budget.execution_line_items eli
      ${joinEntity ? sql`left join core.public_entities e on e.cui = eli.entity_cui` : sql``}
      ${joinOrganization ? sql`left join core.organizations o on o.cui = eli.entity_cui` : sql``}
      ${joinTerritory ? sql`left join core.territories t on t.id = e.territory_id` : sql``}
      ${entity ? sql`left join populations p on p.territory_id = e.territory_id and p.year = eli.reporting_year` : sql``}
      where ${andConditions(conditions)}
      group by eli.reporting_year${entity ? sql`, eli.entity_cui` : sql`, eli.functional_code, eli.economic_code`}
    ), valued as (
      select g.*, f.multiplier, f.scope_population
      from year_groups g left join factors f on f.year = g.reporting_year
    ), coverage as (
      select coalesce(bool_or(multiplier is null), false)
        or (${query.requirePopulation} and coalesce(bool_or(
          not registry_known or executive is null
          ${entity ? sql`or (executive and (population is null or population <= 0))` : sql`or scope_population is null or scope_population <= 0`}
        ), false)) as missing_coverage
      from valued
    ), grouped as (
      select ${entity ? entityFields : classificationFields},
        sum(nominal_amount * multiplier) as total_amount,
        case when ${query.mode !== 'percent_gdp'} and count(${divisor}) = count(*) and min(${divisor}) > 0
          then sum(nominal_amount * multiplier / nullif(${divisor}, 0)) else null end as per_capita_amount,
        sum(count) as count
      from valued
      group by ${entity ? sql`entity_cui` : sql`functional_code, economic_code`}
    ), selected as (
      select *, ${primary} as amount from grouped
    ), final as (
      select * from selected where ${andConditions(bounds)}
    ), totals as (
      select count(*)::text as total_count from final
    ), page as (
      select * from final f order by ${order('f')} limit ${query.limit} offset ${query.offset}
    )
    select p.*, totals.total_count, coverage.missing_coverage
    from totals cross join coverage left join page p on true
    order by ${order('p')}
  `;
};

export const makeGroupedAnalyticsRepo = (
  db: Db,
  options: {
    readonly fundingSourceMap?: FundingSourceMapLoader;
    readonly populationRelation?: TerritoryPopulationRelation;
  } = {}
): GroupedAnalyticsRepo => {
  const fundingMap = options.fundingSourceMap ?? makeFundingSourceMap(db);
  const run = async <T>(
    grouping: Grouping,
    query: GroupedQuery,
    map: (row: DbRow) => T
  ): Promise<Result<GroupedPage<T>, ApiError>> => {
    if (query.moneyMultipliers.size === 0)
      return ok({
        nodes: [],
        pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: query.offset > 0 },
      });
    try {
      const needsMap =
        query.filter.fundingSourceIds !== undefined ||
        query.filter.exclude?.fundingSourceIds !== undefined;
      const funding = needsMap
        ? (await fundingMap.load()).toStoredId
        : (): number | undefined => undefined;
      const rows = await db.transaction().execute(async (trx) => {
        await sql`set local statement_timeout = 30000`.execute(trx);
        return (
          await groupedAnalyticsSql(grouping, query, funding, options.populationRelation).execute(
            trx
          )
        ).rows;
      });
      if (rows[0]?.missing_coverage === true)
        return err(
          serviceUnavailable(
            'Per-capita or normalization coverage is unavailable for the selected scope. For entity rankings, select known territorial executives.'
          )
        );
      const totalCount = Number(rows[0]?.total_count ?? 0);
      const nodes = rows
        .filter((row) =>
          grouping === 'entity' ? row.entity_cui !== null : row.functional_code !== null
        )
        .map(map);
      return ok({
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: query.offset + nodes.length < totalCount,
          hasPreviousPage: query.offset > 0,
        },
      });
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === '57014')
        return err(timeoutError('Grouped analytics query timed out'));
      return err(databaseError('Grouped analytics query failed', error));
    }
  };
  return {
    entities: (query) =>
      run<GroupedEntity>('entity', query, (row) => ({
        entity_cui: requiredText(row.entity_cui),
        entity_name: requiredText(row.entity_name),
        entity_type: row.entity_type,
        uat_id: row.uat_id,
        county_code: row.county_code,
        county_name: row.county_name,
        population: row.population,
        total_amount: legacyDecimal(requiredText(row.total_amount)),
        amount: legacyDecimal(requiredText(row.amount)),
        per_capita_amount:
          row.per_capita_amount === null ? null : legacyDecimal(row.per_capita_amount),
      })),
    classifications: (query) =>
      run<GroupedClassification>('classification', query, (row) => ({
        functional_code: requiredText(row.functional_code),
        functional_name: row.functional_name ?? requiredText(row.functional_code),
        economic_code: row.economic_code,
        economic_name: row.economic_name,
        amount: legacyDecimal(requiredText(row.amount)),
        count: Number(row.count),
      })),
  };
};
