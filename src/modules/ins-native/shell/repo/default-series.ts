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

// Measured on 3,228 anchors × 4 years (2026-09-07): 71 vs 191 SQL reads,
// 22.5s vs 27.0s from the Mac. Revalidate at full scale after topology changes.
const REQUESTS_PER_STATEMENT = 160;
// PostgreSQL wire protocol ceiling. Allow <=32 non-range parameters per request,
// including its VALUES row and an unshared group predicate (the worst case).
// A range contributes two parameters; shrink batches, never truncate selection.
const MAX_BIND_PARAMETERS = 65_535;
const MAX_BRANCH_FIXED_PARAMETERS = 32;
// Preserve the previous maximum hydration batch; this batches, never truncates.
const MAX_HYDRATION_ROWS = 40 * (MAX_OBSERVATION_LIMIT + 1);

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
  period?: InsSeriesPeriod,
  territoryId?: RawBuilder<unknown>
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
      geographicCatalogScopeSql(request.geoScope, territoryId),
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

/** Only request identity and territory vary within a compact query group. */
const groupRequests = (
  requests: readonly InsDefaultSeriesRequest[]
): InsDefaultSeriesRequest[][] => {
  const groups = new Map<string, InsDefaultSeriesRequest[]>();
  for (const request of requests) {
    const key = JSON.stringify([
      request.datasetCode,
      request.unitNomItemId,
      [...request.nonGeographicPins].sort(([left], [right]) => left - right),
      request.geoScope.kind,
    ]);
    const group = groups.get(key) ?? [];
    group.push(request);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const requestRows = (requests: readonly InsDefaultSeriesRequest[]): RawBuilder<unknown> =>
  sql`(values ${sql.join(
    requests.map(
      (request) => sql`(${request.key}::text,
    ${request.geoScope.kind === 'modern' ? request.geoScope.territoryIds[0] : null}::bigint)`
    )
  )})
    as requested(series_key, territory_id)`;

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
  const requestsPerStatement = Math.min(
    REQUESTS_PER_STATEMENT,
    Math.floor(MAX_HYDRATION_ROWS / perSeries),
    Math.floor(
      MAX_BIND_PARAMETERS / (MAX_BRANCH_FIXED_PARAMETERS + 2 * (period?.periodRanges?.length ?? 0))
    )
  );
  if (requestsPerStatement < 1) throw new InsPublicationUnavailable();
  for (let index = 0; index < requests.length; index += requestsPerStatement) {
    const chunk = requests.slice(index, index + requestsPerStatement);
    const groups = groupRequests(chunk);
    const branches = groups
      .filter((group) => group[0]?.geoScope.kind === 'modern')
      .map((group) => {
        const request = group[0];
        const layout = request === undefined ? undefined : layouts.get(request.key);
        if (request === undefined || layout === undefined) throw new InsPublicationUnavailable();
        const predicate = factsPredicate(request, layout, period, sql`requested.territory_id`);
        return sql`(select requested.series_key, candidate.geo_pairs
          from ${requestRows(group)} cross join lateral (
            select g.geo_pairs from ins.dataset_geo_tuples g
            where g.dataset_code=${request.datasetCode}
              and exists (select 1 from ins.observations o
                ${
                  period?.periodicities !== undefined && period.periodicities.length > 0
                    ? sql`join ins.periods pe on pe.period_id=o.period_id`
                    : sql``
                }
                where ${predicate})
            order by g.geo_pairs limit 2
          ) candidate)`;
      });
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
    for (const group of groups) {
      const request = group[0];
      const layout = request === undefined ? undefined : layouts.get(request.key);
      if (request === undefined || layout === undefined) throw new InsPublicationUnavailable();
      const winners: RawBuilder<unknown>[] = [];
      for (const member of group) {
        const witnesses = byKey.get(member.key) ?? [];
        const first = witnesses[0];
        const second = witnesses[1];
        if (second !== undefined && first !== undefined) {
          outcomes.set(member.key, {
            seriesKey: member.key,
            status: 'AMBIGUOUS_GEOGRAPHY',
            observations: [],
            witnesses: [first, second],
          });
          continue;
        }
        if (member.geoScope.kind === 'modern' && first === undefined) {
          outcomes.set(member.key, {
            seriesKey: member.key,
            status: 'NO_DATA',
            observations: [],
            witnesses: [],
          });
          continue;
        }
        if (
          layout.geography.some(
            (dimension, position) => first?.[position]?.[0] !== dimension.dimIndex
          )
        ) {
          throw new InsPublicationUnavailable();
        }
        winners.push(sql`(${member.key}::text,
          ${member.geoScope.kind === 'modern' ? member.geoScope.territoryIds[0] : null}::bigint,
          ${first === undefined ? null : JSON.stringify(first)}::jsonb)`);
      }
      if (winners.length === 0) continue;
      const predicate = factsPredicate(request, layout, period, sql`requested.territory_id`);
      winnerBranches.push(sql`(select requested.series_key, winner.*
        from (values ${sql.join(winners)}) as requested(series_key, territory_id, geo_pairs)
        cross join lateral (select ${factSelect}
          from ins.observations o join ins.periods pe on pe.period_id=o.period_id
          ${
            request.geoScope.kind === 'modern'
              ? sql`join ins.dataset_geo_tuples g
            on g.dataset_code=${request.datasetCode} and g.geo_pairs=requested.geo_pairs`
              : sql``
          }
          where ${predicate}
          ${factOrder} limit ${perSeries}
        ) winner)`);
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
