import type { LegacyAnalyticsFilter, LegacyAggregateQuery, YearlySeries } from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Decimal } from 'decimal.js';
import type { Result } from 'neverthrow';

export const GROUPED_MAX_LIMIT = 100_000;
export const ENTITY_SORT_FIELDS = [
  'AMOUNT',
  'TOTAL_AMOUNT',
  'PER_CAPITA_AMOUNT',
  'ENTITY_NAME',
  'ENTITY_TYPE',
  'POPULATION',
  'COUNTY_NAME',
  'COUNTY_CODE',
] as const;
export type EntitySortField = (typeof ENTITY_SORT_FIELDS)[number];
export interface GroupedInput {
  readonly filter: LegacyAnalyticsFilter;
  readonly limit?: number | null;
  readonly offset?: number | null;
  readonly sort?: { readonly by: string; readonly order: string } | null;
}
export interface GroupedQuery {
  readonly filter: LegacyAggregateQuery;
  readonly moneyMultipliers: YearlySeries;
  readonly mode: 'total' | 'per_capita' | 'percent_gdp';
  readonly requirePopulation: boolean;
  /** Transitional S1b scalar broadcast. Annual provider replaces this map before final acceptance. */
  readonly scopePopulations?: YearlySeries;
  readonly limit: number;
  readonly offset: number;
  readonly sort: { readonly by: EntitySortField; readonly order: 'ASC' | 'DESC' };
}
export interface GroupedPage<T> {
  readonly nodes: readonly T[];
  readonly pageInfo: {
    readonly totalCount: number;
    readonly hasNextPage: boolean;
    readonly hasPreviousPage: boolean;
  };
}
export interface GroupedEntity {
  readonly entity_cui: string;
  readonly entity_name: string;
  readonly entity_type: string | null;
  readonly uat_id: string | null;
  readonly county_code: string | null;
  readonly county_name: string | null;
  readonly population: number | null;
  readonly amount: Decimal;
  readonly total_amount: Decimal;
  readonly per_capita_amount: Decimal | null;
}
export interface GroupedClassification {
  readonly functional_code: string;
  readonly functional_name: string;
  readonly economic_code: string | null;
  readonly economic_name: string | null;
  readonly amount: Decimal;
  readonly count: number;
}
export interface GroupedAnalyticsRepo {
  entities(query: GroupedQuery): Promise<Result<GroupedPage<GroupedEntity>, ApiError>>;
  classifications(
    query: GroupedQuery
  ): Promise<Result<GroupedPage<GroupedClassification>, ApiError>>;
}
