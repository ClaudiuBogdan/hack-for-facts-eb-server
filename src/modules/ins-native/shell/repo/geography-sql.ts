/** Shared geographic identity/eligibility predicates for lists, defaults and presence. */
import { sql, type RawBuilder } from 'kysely';

import { InsPublicationUnavailable } from './publication-error.js';
import { INS_GEO_FLAG_KINDS } from './publication.js';

import type { InsGeographicDimension, InsGeoScope } from '../../core/types.js';

const COVERAGE_FLAGS = Object.entries(INS_GEO_FLAG_KINDS)
  .filter(([, kind]) => kind === 'coverage')
  .map(([flag]) => flag);

/** Publication admission checks pair arity and dimension order before positional use. */
export const wholeGeographicTupleSql = (
  dimensions: readonly InsGeographicDimension[]
): RawBuilder<unknown> => {
  if (dimensions.length === 0) throw new InsPublicationUnavailable();
  return sql.join(
    dimensions.map(
      (dimension, index) =>
        sql`${sql.ref(`o.dim${String(dimension.slotIndex)}_member_id`)} = (g.geo_pairs->${sql.lit(index)}->>1)::int`
    ),
    sql` and `
  );
};

/** Candidate-level filtering. Period eligibility is deliberately a separate fact predicate. */
export const geographicCatalogScopeSql = (
  scope: Extract<InsGeoScope, { kind: 'modern' }>
): RawBuilder<unknown> => {
  if (scope.territoryIds === undefined && scope.levels === undefined) {
    throw new InsPublicationUnavailable();
  }
  const parts: RawBuilder<unknown>[] = [
    sql`g.resolution = 'EXACT' and not (g.flags && ${COVERAGE_FLAGS}::text[])`,
  ];
  if (scope.territoryIds !== undefined)
    parts.push(sql`g.territory_id = any(${scope.territoryIds}::bigint[])`);
  if (scope.levels !== undefined)
    parts.push(sql`exists (select 1 from ins.territory_nodes tn
    where tn.territory_id=g.territory_id and tn.level=any(${scope.levels}::text[]))`);
  return sql.join(parts, sql` and `);
};

/** Qualification follows native date comparisons and inclusive interval overlap. */
export const geographicPeriodEligibilitySql = (scope: InsGeoScope): RawBuilder<unknown> =>
  scope.kind !== 'modern'
    ? sql`true`
    : sql`not exists (
    select 1 from ins.geo_tuple_rules qr
    where qr.dataset_code=g.dataset_code and qr.geo_pairs=g.geo_pairs
      and o.period_start <= qr.applies_to and o.period_end >= qr.applies_from)`;

export const observationGeographySql = (
  datasetCode: string,
  dimensions: readonly InsGeographicDimension[],
  scope: InsGeoScope
): RawBuilder<unknown> => {
  if (scope.kind === 'nonGeographic') {
    if (dimensions.length !== 0) throw new InsPublicationUnavailable();
    return sql`true`;
  }
  if (dimensions.length === 0) throw new InsPublicationUnavailable();
  if (
    scope.kind === 'explicitSource' &&
    scope.pairs.some(
      (pairs) =>
        pairs.length !== dimensions.length ||
        pairs.some((pair, index) => pair[0] !== dimensions[index]?.dimIndex)
    )
  ) {
    throw new InsPublicationUnavailable();
  }
  // Source pins address physical cells directly. Hydration then requires their
  // catalog tuple; a missing observed tuple fails instead of silently hiding facts.
  if (scope.kind === 'explicitSource') {
    if (scope.pairs.length === 0) return sql`false`;
    return sql`(${sql.join(
      scope.pairs.map(
        (pairs) =>
          sql`(${sql.join(
            dimensions.map(
              (dim, index) =>
                sql`${sql.ref(`o.dim${String(dim.slotIndex)}_member_id`)} = ${pairs[index]?.[1]}`
            ),
            sql` and `
          )})`
      ),
      sql` or `
    )})`;
  }
  return sql`exists (select 1 from ins.dataset_geo_tuples g
    where g.dataset_code=${datasetCode} and ${wholeGeographicTupleSql(dimensions)}
      and ${geographicCatalogScopeSql(scope)} and ${geographicPeriodEligibilitySql(scope)})`;
};
