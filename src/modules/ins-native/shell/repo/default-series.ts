/** Two bounded phases: observed source candidates, then fully pinned winner cells. */
import { sql, type RawBuilder } from 'kysely';

import { factOrder, factOrderColumns, factSelect, slotColumn, type FactRow } from './facts.js';
import {
  geographicCatalogScopeSql,
  geographicPeriodEligibilitySql,
  wholeGeographicTupleSql,
} from './geography-sql.js';
import { InsPublicationUnavailable } from './publication-error.js';
import { assertDatasetsPublished } from './publication.js';
import { isSourceMemberId } from '../../core/identity.js';
import {
  MAX_OBSERVATION_LIMIT,
  type InsDefaultSeriesRequest,
  type InsGeographicDimension,
  type InsGeoPairs,
  type InsObservationView,
  type InsSeriesResult,
} from '../../core/types.js';

import type { Trx } from './snapshot.js';
import type { InsSeriesPeriod } from '../../core/ports.js';

const REQUESTS_PER_STATEMENT = 40;
// Preserve the previous maximum hydration batch; this batches, never truncates.
const MAX_HYDRATION_ROWS = REQUESTS_PER_STATEMENT * (MAX_OBSERVATION_LIMIT + 1);

interface Layout {
  readonly geography: readonly InsGeographicDimension[];
  readonly unusedSlots: readonly number[];
}

const periodPredicate = (period?: InsSeriesPeriod): RawBuilder<unknown> => {
  const parts: RawBuilder<unknown>[] = [];
  if (period?.periodStart !== undefined)
    parts.push(sql`o.period_end >= ${period.periodStart}::date`);
  if (period?.periodEnd !== undefined) parts.push(sql`o.period_start <= ${period.periodEnd}::date`);
  if (period?.periodicities !== undefined && period.periodicities.length > 0) {
    parts.push(sql`pe.periodicity = any(${period.periodicities}::text[])`);
  }
  if (period?.periodRanges !== undefined && period.periodRanges.length > 0) {
    parts.push(
      sql`(${sql.join(
        period.periodRanges.map(
          (range) =>
            sql`(o.period_end >= ${range.start}::date and o.period_start <= ${range.end}::date)`
        ),
        sql` or `
      )})`
    );
  }
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` and `);
};

/** The entire eligibility predicate is shared by candidate existence and winner reads. */
const factsPredicate = (
  request: InsDefaultSeriesRequest,
  layout: Layout,
  period?: InsSeriesPeriod
): RawBuilder<unknown> => {
  const parts = [
    sql`o.dataset_code=${request.datasetCode}`,
    sql`o.unit_nom_item_id=${request.unitNomItemId}`,
    ...[...request.nonGeographicPins].map(([slot, id]) => sql`${slotColumn(slot)}=${id}`),
    ...layout.unusedSlots.map((slot) => sql`${slotColumn(slot)} is null`),
    periodPredicate(period),
  ];
  if (request.geoScope.kind === 'modern') {
    parts.push(
      wholeGeographicTupleSql(layout.geography),
      geographicCatalogScopeSql(request.geoScope),
      geographicPeriodEligibilitySql(request.geoScope)
    );
  }
  return sql.join(parts, sql` and `);
};

const readLayouts = async (
  trx: Trx,
  requests: readonly InsDefaultSeriesRequest[]
): Promise<ReadonlyMap<string, Layout>> => {
  const codes = [...new Set(requests.map((request) => request.datasetCode))];
  const dimensions = await sql<{
    dataset_code: string;
    dim_index: number;
    slot_index: number;
    geographic: boolean;
  }>`select dd.dataset_code, dd.dim_index, dd.slot_index, gd.dim_index is not null as geographic
    from ins.dataset_dimensions dd
    left join ins.dataset_geo_dimensions gd on gd.dataset_code=dd.dataset_code and gd.dim_index=dd.dim_index
    where dd.dataset_code=any(${codes}::text[]) and dd.semantic_role='classification'
    order by dd.dataset_code, dd.dim_index`.execute(trx);
  const units = await sql<{ dataset_code: string; unit_nom_item_id: number }>`
    select dataset_code, unit_nom_item_id from ins.measures
    where dataset_code=any(${codes}::text[])`.execute(trx);
  const knownUnits = new Set(
    units.rows.map((unit) => JSON.stringify([unit.dataset_code, unit.unit_nom_item_id]))
  );
  const output = new Map<string, Layout>();
  for (const request of requests) {
    const dims = dimensions.rows.filter(
      (dimension) => dimension.dataset_code === request.datasetCode
    );
    const slots = new Set(dims.map((dimension) => dimension.slot_index));
    const geography = dims
      .filter((dimension) => dimension.geographic)
      .map((dimension) => ({ dimIndex: dimension.dim_index, slotIndex: dimension.slot_index }));
    const nonGeo = dims
      .filter((dimension) => !dimension.geographic)
      .map((dimension) => dimension.slot_index);
    const territoryIds: readonly number[] =
      request.geoScope.kind === 'modern' ? request.geoScope.territoryIds : [];
    if (
      slots.size !== dims.length ||
      dims.some(
        (dimension) =>
          !Number.isInteger(dimension.slot_index) ||
          dimension.slot_index < 1 ||
          dimension.slot_index > 7
      ) ||
      request.nonGeographicPins.size !== nonGeo.length ||
      nonGeo.some((slot) => !request.nonGeographicPins.has(slot)) ||
      [...request.nonGeographicPins.values()].some((id) => !isSourceMemberId(id)) ||
      !knownUnits.has(JSON.stringify([request.datasetCode, request.unitNomItemId])) ||
      (request.geoScope.kind === 'nonGeographic'
        ? geography.length !== 0
        : geography.length === 0 ||
          territoryIds.length !== 1 ||
          territoryIds.some((id) => !Number.isSafeInteger(id) || id < 1))
    ) {
      throw new InsPublicationUnavailable();
    }
    output.set(request.key, {
      geography,
      unusedSlots: Array.from({ length: 7 }, (_, index) => index + 1).filter(
        (slot) => !slots.has(slot)
      ),
    });
  }
  return output;
};

/** Caller wraps this complete operation, including hydration, in one Runner savepoint. */
export const readDefaultSeries = async (
  trx: Trx,
  requests: readonly InsDefaultSeriesRequest[],
  perSeries: number,
  period: InsSeriesPeriod | undefined,
  hydrate: (rows: readonly FactRow[]) => Promise<readonly InsObservationView[]>
): Promise<readonly InsSeriesResult[]> => {
  if (requests.length === 0) return [];
  if (
    new Set(requests.map((request) => request.key)).size !== requests.length ||
    !Number.isInteger(perSeries) ||
    perSeries < 1 ||
    perSeries > MAX_OBSERVATION_LIMIT + 1
  ) {
    throw new InsPublicationUnavailable();
  }
  await assertDatasetsPublished(trx, [...new Set(requests.map((request) => request.datasetCode))]);
  const layouts = await readLayouts(trx, requests);
  const results: InsSeriesResult[] = [];
  const outcomes = new Map<string, InsSeriesResult>();
  const bySeries = new Map<string, InsObservationView[]>();
  let pending: FactRow[] = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    const observations = await hydrate(pending);
    if (observations.length !== pending.length) throw new InsPublicationUnavailable();
    for (const [position, observation] of observations.entries()) {
      const key = pending[position]?.series_key;
      if (key === undefined) throw new InsPublicationUnavailable();
      const values = bySeries.get(key) ?? [];
      values.push(observation);
      bySeries.set(key, values);
    }
    pending = [];
  };
  for (let index = 0; index < requests.length; index += REQUESTS_PER_STATEMENT) {
    const chunk = requests.slice(index, index + REQUESTS_PER_STATEMENT);
    const prepared = chunk.map((request) => {
      const layout = layouts.get(request.key);
      if (layout === undefined) throw new InsPublicationUnavailable();
      return { request, layout, predicate: factsPredicate(request, layout, period) };
    });
    const branches = prepared
      .filter(({ request }) => request.geoScope.kind === 'modern')
      .map(
        ({ request, predicate }) => sql`(select ${request.key}::text as series_key, g.geo_pairs
        from ins.dataset_geo_tuples g
        where g.dataset_code=${request.datasetCode}
          and exists (select 1 from ins.observations o
            ${
              period?.periodicities !== undefined && period.periodicities.length > 0
                ? sql`join ins.periods pe on pe.period_id=o.period_id`
                : sql``
            }
            where ${predicate})
        order by g.geo_pairs limit 2)`
      );
    const candidates =
      branches.length === 0
        ? []
        : (
            await sql<{ series_key: string; geo_pairs: InsGeoPairs }>`
      select * from (${sql.join(branches, sql` union all `)}) candidates order by series_key, geo_pairs`.execute(
              trx
            )
          ).rows;
    const byKey = new Map<string, InsGeoPairs[]>();
    for (const candidate of candidates) {
      const pairs = byKey.get(candidate.series_key) ?? [];
      pairs.push(candidate.geo_pairs);
      byKey.set(candidate.series_key, pairs);
    }
    const winnerBranches: RawBuilder<unknown>[] = [];
    for (const { request, layout, predicate } of prepared) {
      const witnesses = byKey.get(request.key) ?? [];
      const first = witnesses[0];
      const second = witnesses[1];
      if (second !== undefined && first !== undefined) {
        outcomes.set(request.key, {
          seriesKey: request.key,
          status: 'AMBIGUOUS_GEOGRAPHY',
          observations: [],
          witnesses: [first, second],
        });
        continue;
      }
      if (request.geoScope.kind === 'modern' && first === undefined) {
        outcomes.set(request.key, {
          seriesKey: request.key,
          status: 'NO_DATA',
          observations: [],
          witnesses: [],
        });
        continue;
      }
      const pins = layout.geography.map((dimension, position) => {
        const pair = first?.[position];
        if (pair?.[0] !== dimension.dimIndex) throw new InsPublicationUnavailable();
        return sql`${slotColumn(dimension.slotIndex)}=${pair[1]}`;
      });
      winnerBranches.push(sql`(select ${request.key}::text as series_key, ${factSelect}
        from ins.observations o join ins.periods pe on pe.period_id=o.period_id
        ${
          request.geoScope.kind === 'modern'
            ? sql`join ins.dataset_geo_tuples g
          on g.dataset_code=${request.datasetCode} and g.geo_pairs=${JSON.stringify(first)}::jsonb`
            : sql``
        }
        where ${predicate} ${pins.length === 0 ? sql`` : sql`and ${sql.join(pins, sql` and `)}`}
        ${factOrder} limit ${perSeries})`);
    }
    const rows =
      winnerBranches.length === 0
        ? []
        : (
            await sql<FactRow>`
      select * from (${sql.join(winnerBranches, sql` union all `)}) o order by o.series_key, ${factOrderColumns}`.execute(
              trx
            )
          ).rows;
    if (pending.length + rows.length > MAX_HYDRATION_ROWS) await flush();
    pending.push(...rows);
  }
  await flush();
  for (const request of requests) {
    const outcome = outcomes.get(request.key);
    if (outcome !== undefined) {
      results.push(outcome);
      continue;
    }
    const values = bySeries.get(request.key) ?? [];
    if (request.geoScope.kind === 'modern' && values.length === 0) {
      // A candidate proved a fact exists in this snapshot with this predicate.
      throw new InsPublicationUnavailable();
    }
    results.push(
      values.length === 0
        ? { seriesKey: request.key, status: 'NO_DATA', observations: [], witnesses: [] }
        : { seriesKey: request.key, status: 'SERIES', observations: values, witnesses: [] }
    );
  }
  return results;
};
