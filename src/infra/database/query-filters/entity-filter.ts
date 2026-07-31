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
  tags?: readonly string[];
  exclude?: {
    entity_types?: readonly string[];
    uat_ids?: readonly string[];
    county_codes?: readonly string[];
    tags?: readonly string[];
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
 * - tags filter
 * - exclude.entity_types, exclude.uat_ids, exclude.county_codes, exclude.tags
 *
 * TRAP: every repo that calls this MUST also apply the corresponding predicate.
 * A filter key that turns the join on without a predicate is a silent no-op
 * filter, which WIDENS the result set.
 */
export function needsEntityJoin(filter: EntityJoinFilter): boolean {
  const hasUatFilter = filter.is_uat !== undefined;
  const hasEntityTypes = hasValues(filter.entity_types);
  const hasUatIds = hasValues(filter.uat_ids);
  const hasCountyCodes = hasValues(filter.county_codes);
  const hasSearch = filter.search !== undefined && filter.search.trim() !== '';
  const hasMinPopulation = filter.min_population !== undefined && filter.min_population !== null;
  const hasMaxPopulation = filter.max_population !== undefined && filter.max_population !== null;
  const hasTags = hasValues(filter.tags);
  const hasExcludeEntityTypes = hasValues(filter.exclude?.entity_types);
  const hasExcludeUatIds = hasValues(filter.exclude?.uat_ids);
  const hasExcludeCountyCodes = hasValues(filter.exclude?.county_codes);
  const hasExcludeTags = hasValues(filter.exclude?.tags);

  return (
    hasEntityTypes ||
    hasUatFilter ||
    hasUatIds ||
    hasCountyCodes ||
    hasSearch ||
    hasMinPopulation ||
    hasMaxPopulation ||
    hasTags ||
    hasExcludeEntityTypes ||
    hasExcludeUatIds ||
    hasExcludeCountyCodes ||
    hasExcludeTags
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
// Faceted Tag Filters
// ============================================================================

/**
 * Shape of a valid faceted tag filter value: `namespace::value` with an
 * optional third segment (`kind::school::gymnasium`).
 *
 * Deliberately NOT a closed-vocabulary check: a well-formed unknown tag simply
 * matches nothing, and a new tag from the classification engine must never be
 * rejected by the API.
 */
export const TAG_FILTER_PATTERN = /^[a-z_]+(::[a-z_]+){1,2}$/;

/**
 * Rejects malformed tags LOUDLY instead of dropping them.
 *
 * This must not follow the `toNumericIds` precedent of silently discarding bad
 * values: a filter that quietly becomes a no-op WIDENS the result set, which is
 * the worst possible failure for a transparency tool.
 */
export function assertValidTagFilter(tags: readonly string[]): void {
  for (const tag of tags) {
    if (!TAG_FILTER_PATTERN.test(tag)) {
      throw new Error(
        `Invalid tags filter value '${tag}': expected lowercase namespace::value ` +
          `(e.g. 'kind::hospital' or 'kind::school::gymnasium').`
      );
    }
  }
}

/** `kind::school::gymnasium` -> `kind`. Validation has already run. */
function tagFacet(tag: string): string {
  return tag.slice(0, tag.indexOf('::'));
}

/**
 * jsonb containment document for one tag. `entities.tags` is an array of
 * `{tag, ruleId, confidence}` OBJECTS, so the right-hand side must be an array
 * of partial objects — `tags @> to_jsonb(ARRAY['kind::x'])` is type-correct
 * jsonb that silently matches nothing.
 */
function tagContainmentDoc(tag: string): string {
  return JSON.stringify([{ tag }]);
}

/**
 * Builds the faceted tag predicate: OR within a facet, AND across facets
 * (each returned condition is one facet's OR-group; callers AND the array).
 *
 * `(e.tags @> $1::jsonb OR e.tags @> $2::jsonb)` — an OR of `@>` rather than
 * `EXISTS(jsonb_array_elements ...)` because only `@>` is served by the
 * `jsonb_path_ops` GIN index on entities.tags.
 *
 * Ancestor roll-up is materialized in the data (an entity tagged
 * `kind::school::gymnasium` physically also carries `kind::school`), so exact
 * containment is the complete predicate — no LIKE, no prefix expansion.
 *
 * Requires the entities join (alias 'e'); on a LEFT-joined row with no entity,
 * `NULL @> x` is NULL -> not matched, which is correct for inclusion.
 *
 * The 'e' alias is HARDCODED here (as it is in buildTagExclusionCondition).
 * That is safe only because FilterContext.entityAlias is the literal type 'e'
 * — if entities ever gets a second alias, these two must take it as a
 * parameter.
 */
export function buildTagConditions(tags: readonly string[] | undefined): SqlCondition[] {
  if (tags === undefined || !hasValues(tags)) {
    return [];
  }
  assertValidTagFilter(tags);

  const byFacet = new Map<string, string[]>();
  for (const tag of new Set(tags)) {
    const facet = tagFacet(tag);
    const group = byFacet.get(facet);
    if (group === undefined) {
      byFacet.set(facet, [tag]);
    } else {
      group.push(tag);
    }
  }

  return [...byFacet.values()].map((facetTags) => {
    const ors = facetTags.map(
      (tag) => sql`${col('e', 'tags')} @> ${tagContainmentDoc(tag)}::jsonb`
    );
    return ors.length === 1 && ors[0] !== undefined ? ors[0] : sql`(${sql.join(ors, sql` OR `)})`;
  });
}

/**
 * Exclusion twin: excludes entities carrying ANY of the given tags (flat
 * any-match, no facet grouping — consistent with `entity_types NOT IN`).
 * NULL-safe: a LEFT-joined row with no entity row must be PRESERVED by an
 * exclusion, mirroring the other nullable-column exclusions.
 */
export function buildTagExclusionCondition(
  tags: readonly string[] | undefined
): SqlCondition | undefined {
  if (tags === undefined || !hasValues(tags)) {
    return undefined;
  }
  assertValidTagFilter(tags);

  const ors = [...new Set(tags)].map(
    (tag) => sql`${col('e', 'tags')} @> ${tagContainmentDoc(tag)}::jsonb`
  );
  return sql`(${col('e', 'tags')} IS NULL OR NOT (${sql.join(ors, sql` OR `)}))`;
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

  conditions.push(...buildTagConditions(filter.tags));

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
