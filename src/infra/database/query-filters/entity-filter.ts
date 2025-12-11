/**
 * Entity Filter
 *
 * Builds parameterized SQL conditions for entity and geographic filters.
 * Also provides utilities for determining when joins are needed.
 *
 * SECURITY: All values are automatically parameterized via Kysely's sql`` template.
 */

import { sql } from 'kysely';

import { col, hasValues, toNumericIds, escapeLikeWildcards } from './composer.js';

import type { FilterContext, SqlCondition, GeographicFilter } from './types.js';

// ============================================================================
// Join Detection
// ============================================================================

/**
 * Filter interface for entity join detection.
 */
interface EntityJoinFilter {
  entity_types?: readonly string[];
  is_uat?: boolean;
  uat_ids?: readonly string[];
  county_codes?: readonly string[];
  search?: string;
  min_population?: number | null;
  max_population?: number | null;
  exclude?: {
    entity_types?: readonly string[];
    uat_ids?: readonly string[];
    county_codes?: readonly string[];
  };
}

/**
 * Filter interface for UAT join detection.
 */
interface UatJoinFilter {
  county_codes?: readonly string[];
  regions?: readonly string[];
  min_population?: number | null;
  max_population?: number | null;
  exclude?: {
    county_codes?: readonly string[];
    regions?: readonly string[];
  };
}

/**
 * Checks if a filter needs entity table join.
 *
 * Entity join is needed for:
 * - entity_types filter
 * - is_uat filter (explicit true/false)
 * - uat_ids filter
 * - county_codes filter (requires UAT which requires entity)
 * - search filter
 * - population filters (requires UAT which requires entity)
 * - exclude.entity_types, exclude.uat_ids, exclude.county_codes
 */
export function needsEntityJoin(filter: EntityJoinFilter): boolean {
  const hasUatFilter = filter.is_uat !== undefined;
  const hasEntityTypes = hasValues(filter.entity_types);
  const hasUatIds = hasValues(filter.uat_ids);
  const hasCountyCodes = hasValues(filter.county_codes);
  const hasSearch = filter.search !== undefined && filter.search.trim() !== '';
  const hasMinPopulation = filter.min_population !== undefined && filter.min_population !== null;
  const hasMaxPopulation = filter.max_population !== undefined && filter.max_population !== null;
  const hasExcludeEntityTypes = hasValues(filter.exclude?.entity_types);
  const hasExcludeUatIds = hasValues(filter.exclude?.uat_ids);
  const hasExcludeCountyCodes = hasValues(filter.exclude?.county_codes);

  return (
    hasEntityTypes ||
    hasUatFilter ||
    hasUatIds ||
    hasCountyCodes ||
    hasSearch ||
    hasMinPopulation ||
    hasMaxPopulation ||
    hasExcludeEntityTypes ||
    hasExcludeUatIds ||
    hasExcludeCountyCodes
  );
}

/**
 * Checks if a filter needs UAT table join.
 *
 * UAT join is needed for:
 * - county_codes filter
 * - regions filter
 * - population filters
 * - exclude.county_codes, exclude.regions
 */
export function needsUatJoin(filter: UatJoinFilter): boolean {
  const hasCountyCodes = hasValues(filter.county_codes);
  const hasRegions = hasValues(filter.regions);
  const hasMinPopulation = filter.min_population !== undefined && filter.min_population !== null;
  const hasMaxPopulation = filter.max_population !== undefined && filter.max_population !== null;
  const hasExcludeCountyCodes = hasValues(filter.exclude?.county_codes);
  const hasExcludeRegions = hasValues(filter.exclude?.regions);

  return (
    hasCountyCodes ||
    hasRegions ||
    hasMinPopulation ||
    hasMaxPopulation ||
    hasExcludeCountyCodes ||
    hasExcludeRegions
  );
}

// ============================================================================
// SQL Condition Builders (Parameterized)
// ============================================================================

/**
 * Builds parameterized SQL conditions for entity table filters.
 *
 * Should only be called when entity table is joined (ctx.hasEntityJoin = true).
 *
 * @param filter - Filter with entity constraints
 * @param ctx - Filter context with table aliases
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildEntityConditions(
  filter: GeographicFilter,
  ctx: FilterContext
): SqlCondition[] {
  const a = ctx.entityAlias;
  const conditions: SqlCondition[] = [];

  if (hasValues(filter.entity_types)) {
    conditions.push(sql`${col(a, 'entity_type')} IN (${sql.join(filter.entity_types)})`);
  }

  if (filter.is_uat !== undefined) {
    const boolValue = filter.is_uat ? sql`TRUE` : sql`FALSE`;
    conditions.push(sql`${col(a, 'is_uat')} = ${boolValue}`);
  }

  if (hasValues(filter.uat_ids)) {
    const ids = toNumericIds(filter.uat_ids);
    if (ids.length > 0) {
      conditions.push(sql`${col(a, 'uat_id')} IN (${sql.join(ids)})`);
    }
  }

  // Search filter: case-insensitive substring match on entity name
  // escapeLikeWildcards prevents user wildcards from acting as SQL wildcards
  if (filter.search !== undefined && filter.search.trim() !== '') {
    const searchPattern = '%' + escapeLikeWildcards(filter.search.trim()) + '%';
    conditions.push(sql`${col(a, 'name')} ILIKE ${searchPattern}`);
  }

  return conditions;
}

/**
 * Builds parameterized SQL conditions for UAT table filters.
 *
 * Should only be called when UAT table is joined (ctx.hasUatJoin = true).
 *
 * @param filter - Filter with UAT constraints
 * @param ctx - Filter context with table aliases
 * @returns Array of parameterized SqlCondition RawBuilders
 */
export function buildUatConditions(filter: GeographicFilter, ctx: FilterContext): SqlCondition[] {
  const a = ctx.uatAlias;
  const conditions: SqlCondition[] = [];

  if (hasValues(filter.county_codes)) {
    conditions.push(sql`${col(a, 'county_code')} IN (${sql.join(filter.county_codes)})`);
  }

  if (hasValues(filter.regions)) {
    conditions.push(sql`${col(a, 'region')} IN (${sql.join(filter.regions)})`);
  }

  if (filter.min_population !== undefined && filter.min_population !== null) {
    conditions.push(sql`${col(a, 'population')} >= ${filter.min_population}`);
  }

  if (filter.max_population !== undefined && filter.max_population !== null) {
    conditions.push(sql`${col(a, 'population')} <= ${filter.max_population}`);
  }

  return conditions;
}
