/**
 * Native INS repository — the SERIES reads (codebase plan §WP5): observation
 * lists that intersect physical classification pins with complete published
 * geographic tuples and actual-period eligibility, the default-series read,
 * and the hydration of fact rows into observation views (members, units,
 * geography) inside the same snapshot. Rows retain their source identity;
 * paging reads limit+1 and never counts facts. Moved out of `ins-repo.ts`
 * unchanged.
 */
import { sql, type RawBuilder } from 'kysely';

import { readDefaultSeries as readDefaultSeriesInSnapshot } from './default-series.js';
import { factOrder, factSelect, slotColumn, type FactRow } from './facts.js';
import { observationGeographySql } from './geography-sql.js';
import {
  geographicView,
  readGeographicDimensions,
  readGeographicDimensionsForDatasets,
  readGeographicTuplesForDatasets,
} from './geography.js';
import {
  type MemberRow,
  isoDate,
  memberFrom,
  memberSelect,
  toMember,
  toUnit,
  unitsSql,
} from './ins-publication.js';
import { InsPublicationUnavailable } from './publication-error.js';
import { assertDatasetsPublished } from './publication.js';
import { type Runner, type Trx } from './snapshot.js';
import {
  MAX_SLOTS,
  type InsMemberView,
  type InsObservationView,
  type InsPeriodicity,
  type SlotPins,
} from '../../core/types.js';

import type { InsRepo } from '../../core/ports.js';

/** Explicit classification pins, independent of geographic interpretation. */
export const pinGroupSql = (pins: SlotPins): RawBuilder<unknown> => {
  const parts = [...pins].map(([slot, ids]) =>
    ids.length === 0
      ? sql`false`
      : sql`${slotColumn(slot)} in (${sql.join(ids.map((id) => sql`${id}`))})`
  );
  return parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;
};

export const hydrate = async (
  trx: Trx,
  rows: readonly FactRow[]
): Promise<InsObservationView[]> => {
  if (rows.length === 0) return [];
  const codes = [...new Set(rows.map((row) => row.dataset_code))];
  const dims = await sql<{ dataset_code: string; dim_index: number; slot_index: number }>`
    select dataset_code, dim_index, slot_index from ins.dataset_dimensions
    where dataset_code = any(${codes}::text[]) and semantic_role = 'classification'
    order by dataset_code, dim_index`.execute(trx);
  const slotsByDataset = new Map<string, Map<number, number>>();
  for (const dimension of dims.rows) {
    const slots = slotsByDataset.get(dimension.dataset_code) ?? new Map<number, number>();
    slots.set(dimension.slot_index, dimension.dim_index);
    slotsByDataset.set(dimension.dataset_code, slots);
  }
  const requestedMembers = new Map<
    string,
    { dataset_code: string; dim_index: number; nom_item_id: number }
  >();
  for (const row of rows) {
    const slots = slotsByDataset.get(row.dataset_code) ?? new Map<number, number>();
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      const id = row[`dim${String(slot)}_member_id` as keyof FactRow] as number | null;
      const dim = slots.get(slot);
      if (dim === undefined) {
        if (id !== null) throw new InsPublicationUnavailable();
      } else {
        if (id === null) throw new InsPublicationUnavailable();
        requestedMembers.set(JSON.stringify([row.dataset_code, dim, id]), {
          dataset_code: row.dataset_code,
          dim_index: dim,
          nom_item_id: id,
        });
      }
    }
  }
  const members =
    requestedMembers.size === 0
      ? []
      : (
          await sql<MemberRow>`select ${memberSelect} ${memberFrom}
      join jsonb_to_recordset(${JSON.stringify([...requestedMembers.values()])}::jsonb)
        as wanted(dataset_code text, dim_index int, nom_item_id int)
        on wanted.dataset_code=m.dataset_code and wanted.dim_index=m.dim_index and wanted.nom_item_id=m.nom_item_id`.execute(
            trx
          )
        ).rows.map(toMember);
  const memberByKey = new Map(
    members.map((member) => [
      JSON.stringify([member.datasetCode, member.dimIndex, member.nomItemId]),
      member,
    ])
  );
  if (memberByKey.size !== requestedMembers.size) throw new InsPublicationUnavailable();
  const units = new Map(
    (await unitsSql(codes).execute(trx)).rows.map((unit) => [
      JSON.stringify([unit.dataset_code, unit.unit_nom_item_id]),
      toUnit(unit),
    ])
  );
  const geoDimensions = await readGeographicDimensionsForDatasets(trx, codes);
  for (const [code, dimensions] of geoDimensions) {
    for (const dimension of dimensions) {
      if (slotsByDataset.get(code)?.get(dimension.slotIndex) !== dimension.dimIndex) {
        throw new InsPublicationUnavailable();
      }
    }
  }
  const rowPairs = rows.map((row) =>
    (geoDimensions.get(row.dataset_code) ?? []).map((dimension) => {
      const member = row[`dim${String(dimension.slotIndex)}_member_id` as keyof FactRow];
      if (typeof member !== 'number') throw new InsPublicationUnavailable();
      return [dimension.dimIndex, member] as const;
    })
  );
  const geoTuples = await readGeographicTuplesForDatasets(
    trx,
    rows.map((row, index) => ({
      datasetCode: row.dataset_code,
      pairs: [rowPairs[index] ?? []],
    }))
  );

  const views: InsObservationView[] = [];
  for (const [rowIndex, r] of rows.entries()) {
    const slots: (number | null)[] = [];
    const rowMembers: InsMemberView[] = [];
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      const id = r[`dim${String(slot)}_member_id` as keyof FactRow] as number | null;
      slots.push(id);
      const dimIndex = slotsByDataset.get(r.dataset_code)?.get(slot);
      if (dimIndex === undefined) {
        if (id !== null) throw new InsPublicationUnavailable();
        continue;
      }
      if (id === null) throw new InsPublicationUnavailable();
      const m = memberByKey.get(JSON.stringify([r.dataset_code, dimIndex, id]));
      if (m === undefined) throw new InsPublicationUnavailable();
      rowMembers.push(m);
    }
    const unit = units.get(JSON.stringify([r.dataset_code, r.unit_nom_item_id]));
    const periodStart = isoDate(r.period_start);
    const periodEnd = isoDate(r.period_end);
    if (
      unit === undefined ||
      periodStart === null ||
      periodEnd === null ||
      periodEnd < periodStart ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(periodStart) ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(periodEnd)
    ) {
      throw new InsPublicationUnavailable();
    }
    const pairs = rowPairs[rowIndex];
    if (pairs === undefined) throw new InsPublicationUnavailable();
    const geography = geographicView(
      pairs,
      geoTuples.get(r.dataset_code) ?? new Map(),
      periodStart,
      periodEnd
    );
    const territory = geography?.qualified === false ? geography.resolvedTerritory : null;
    views.push({
      coordinate: {
        datasetCode: r.dataset_code,
        slots,
        timeNomItemId: r.time_nom_item_id,
        unitNomItemId: r.unit_nom_item_id,
      },
      period: {
        periodId: r.period_id,
        periodicity: r.periodicity as InsPeriodicity,
        periodStart,
        periodEnd,
        labelRo: r.period_label_ro,
      },
      value: r.value,
      valueStatus: r.value_status,
      currencyCode: r.currency_code,
      members: rowMembers.sort((a, b) => a.dimIndex - b.dimIndex),
      geography,
      territory,
      unit,
    });
  }
  return views;
};

export const makeSeriesReads = (readTx: Runner) => {
  const repository: Pick<InsRepo, 'listObservations' | 'readDefaultSeries'> = {
    async listObservations(query) {
      return readTx('listObservations', async (trx) => {
        await assertDatasetsPublished(trx, [query.datasetCode]);
        const dimensions = await readGeographicDimensions(trx, query.datasetCode);
        const parts: RawBuilder<unknown>[] = [
          sql`o.dataset_code = ${query.datasetCode}`,
          observationGeographySql(query.datasetCode, dimensions, query.geoScope),
        ];
        if (query.pinGroups.length > 0) {
          parts.push(
            sql`(${sql.join(
              query.pinGroups.map((g) => pinGroupSql(g)),
              sql` or `
            )})`
          );
        }
        if (query.unitNomItemIds !== undefined && query.unitNomItemIds.length > 0) {
          parts.push(
            sql`o.unit_nom_item_id in (${sql.join(query.unitNomItemIds.map((id) => sql`${id}`))})`
          );
        }
        if (query.periodStart !== undefined)
          parts.push(sql`o.period_end >= ${query.periodStart}::date`);
        if (query.periodEnd !== undefined)
          parts.push(sql`o.period_start <= ${query.periodEnd}::date`);
        if (query.periodRanges !== undefined && query.periodRanges.length > 0) {
          parts.push(
            sql`(${sql.join(
              query.periodRanges.map(
                (r) => sql`(o.period_end >= ${r.start}::date and o.period_start <= ${r.end}::date)`
              ),
              sql` or `
            )})`
          );
        }
        if (query.periodicities !== undefined && query.periodicities.length > 0) {
          parts.push(
            sql`pe.periodicity in (${sql.join(query.periodicities.map((p) => sql`${p}`))})`
          );
        }
        if (query.periodIds !== undefined && query.periodIds.length > 0) {
          parts.push(sql`o.period_id in (${sql.join(query.periodIds.map((id) => sql`${id}`))})`);
        }
        if (query.hasValue === true) parts.push(sql`o.value is not null`);
        if (query.hasValue === false) parts.push(sql`o.value is null`);
        const res = await sql<FactRow>`
          select ${factSelect}
          from ins.observations o
          join ins.periods pe on pe.period_id = o.period_id
          where ${sql.join(parts, sql` and `)}
          ${factOrder}
          limit ${query.limit + 1} offset ${query.offset}`.execute(trx);
        const hasNextPage = res.rows.length > query.limit;
        const rows = res.rows.slice(0, query.limit);
        const views = await hydrate(trx, rows);
        return {
          nodes: views,
          // Exact only when the whole population ends inside this page (D7);
          // unknown when more rows exist or when the offset overshot the end.
          totalCount:
            hasNextPage || (rows.length === 0 && query.offset > 0)
              ? null
              : query.offset + rows.length,
          hasNextPage,
          hasPreviousPage: query.offset > 0,
        };
      });
    },

    async readDefaultSeries(requests, perSeries, period) {
      return readTx('readDefaultSeries', (trx) =>
        readDefaultSeriesInSnapshot(trx, requests, perSeries, period, (rows) => hydrate(trx, rows))
      );
    },
  };

  return repository;
};
