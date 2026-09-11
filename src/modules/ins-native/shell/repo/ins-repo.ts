/**
 * Native Chronos INS reads. Observation lists intersect physical classification
 * pins with complete published geographic tuples and actual-period eligibility.
 * Rows retain their source identity; paging reads limit+1 and never counts facts.
 * Default probes require one eligible source tuple before reading fully pinned cells.
 * All reads and hydration share a repeatable-read, read-only snapshot.
 */
import { sql, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import { readCountyAliases } from './county-aliases.js';
import { readDefaultSeries as readDefaultSeriesInSnapshot } from './default-series.js';
import { factOrder, factSelect, slotColumn, type FactRow } from './facts.js';
import { geographicCatalogScopeSql, observationGeographySql } from './geography-sql.js';
import {
  geographicView,
  readGeographicDimensions,
  readGeographicDimensionsForDatasets,
  readGeographicTuplesForDatasets,
} from './geography.js';
import {
  MemberRow,
  datasetFrom,
  isoDate,
  likeNeedle,
  makePublicationReads,
  memberFrom,
  memberSelect,
  page,
  toMember,
  toUnit,
  unitsSql,
} from './ins-publication.js';
import { InsPublicationUnavailable } from './publication-error.js';
import { assertDatasetsPublished } from './publication.js';
import {
  dbError,
  INS_TRANSACTION_TIMEOUT_MS,
  inTrxRunner,
  openSnapshot,
  perReadRunner,
  type Db,
  type Runner,
  type Trx,
} from './snapshot.js';
import { nodeSelect, territoryQuerySql, toNode, type NodeRow } from './territory.js';
import {
  MAX_SLOTS,
  type InsMemberView,
  type InsObservationView,
  type InsPeriodicity,
  type SlotPins,
} from '../../core/types.js';

import type { InsRepo } from '../../core/ports.js';
import type { ApiError } from '@/modules/shared/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Classification pins
// ─────────────────────────────────────────────────────────────────────────────

/** Explicit classification pins, independent of geographic interpretation. */
const pinGroupSql = (pins: SlotPins): RawBuilder<unknown> => {
  const parts = [...pins].map(([slot, ids]) =>
    ids.length === 0
      ? sql`false`
      : sql`${slotColumn(slot)} in (${sql.join(ids.map((id) => sql`${id}`))})`
  );
  return parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Hydration of fact rows into observation views
// ─────────────────────────────────────────────────────────────────────────────

const hydrate = async (trx: Trx, rows: readonly FactRow[]): Promise<InsObservationView[]> => {
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

// ─────────────────────────────────────────────────────────────────────────────
// The repository
// ─────────────────────────────────────────────────────────────────────────────

export const makeInsRepo = (db: Db): InsRepo => makeRepoOn(db, perReadRunner(db));

/** Module-private assembly seam: every nested usecase retains this snapshot. */
export const makeInsSnapshotRepo = (db: Db, runner: Runner): InsRepo =>
  makeRepoOn(db, runner, true);

/** Compose canonical identity and native INS reads within one read-only snapshot. */
export const withInsReadSnapshot = <T>(
  db: Db,
  fn: (context: { trx: Trx; repo: InsRepo }) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> =>
  openSnapshot(db, async (trx) => {
    await sql`set local transaction_timeout = ${sql.lit(INS_TRANSACTION_TIMEOUT_MS)}`.execute(trx);
    return fn({ trx, repo: makeInsSnapshotRepo(db, inTrxRunner(trx)) });
  }).catch((cause: unknown) => err(dbError(cause, 'composed snapshot')));

const makeRepoOn = (db: Db, readTx: Runner, snapshotBound = false): InsRepo => {
  const territoryQuery = (
    where: RawBuilder<unknown>,
    order: RawBuilder<unknown>,
    limit?: number,
    offset?: number
  ) =>
    sql<NodeRow & { total: string }>`
      select ${nodeSelect}, count(*) over() as total
      from ins.territory_nodes t
      left join ins.territory_nodes p on p.territory_id = t.parent_id
      where ${where}
      ${order}
      ${limit === undefined ? sql`` : sql`limit ${limit} offset ${offset ?? 0}`}`;

  const levelOrder = sql`order by array_position(array['NATIONAL','NUTS1','NUTS2','NUTS3','LAU']::text[], t.level), t.name_search, t.territory_id`;

  const repository: InsRepo = {
    ...makePublicationReads(readTx),
    withSnapshot(fn) {
      if (snapshotBound) return fn(repository);
      return openSnapshot(db, (trx) => fn(makeRepoOn(db, inTrxRunner(trx), true))).catch(
        (cause: unknown) => err(dbError(cause, 'withSnapshot'))
      );
    },

    async listTerritories(filter, limit, offset) {
      return readTx('listTerritories', async (trx) => {
        const parts: RawBuilder<unknown>[] = [sql`true`];
        if (filter.search !== undefined && filter.search.trim() !== '') {
          parts.push(sql`t.name_search like ${likeNeedle(filter.search)}`);
        }
        if (filter.levels !== undefined && filter.levels.length > 0) {
          parts.push(sql`t.level in (${sql.join(filter.levels.map((l) => sql`${l}`))})`);
        }
        if (filter.territoryIds !== undefined)
          parts.push(sql`t.territory_id = any(${filter.territoryIds}::bigint[])`);
        if (filter.parentCode !== undefined && filter.parentCode !== '')
          parts.push(sql`p.code = ${filter.parentCode}`);
        if (filter.sirutaCodes !== undefined && filter.sirutaCodes.length > 0) {
          parts.push(
            sql`t.siruta_code in (${sql.join(filter.sirutaCodes.map((s) => sql`${s.trim()}`))})`
          );
        }
        const res = await territoryQuery(
          sql.join(parts, sql` and `),
          levelOrder,
          limit,
          offset
        ).execute(trx);
        const total = Number(res.rows[0]?.total ?? 0);
        return page(res.rows.map(toNode), total, limit, offset);
      });
    },

    async territoriesByCodes(codes, levels) {
      if (codes.length === 0) return ok([]);
      return readTx('territoriesByCodes', async (trx) => {
        const levelPart =
          levels === undefined || levels.length === 0
            ? sql`true`
            : sql`t.level in (${sql.join(levels.map((l) => sql`${l}`))})`;
        const res = await territoryQuery(
          sql`t.code in (${sql.join(codes.map((c) => sql`${c.trim().toUpperCase()}`))}) and ${levelPart}`,
          levelOrder
        ).execute(trx);
        return res.rows.map(toNode);
      });
    },

    async territoriesBySiruta(sirutaCodes) {
      if (sirutaCodes.length === 0) return ok([]);
      return readTx('territoriesBySiruta', async (trx) => {
        const res = await territoryQuery(
          sql`t.siruta_code in (${sql.join(sirutaCodes.map((s) => sql`${s.trim()}`))})`,
          levelOrder
        ).execute(trx);
        return res.rows.map(toNode);
      });
    },

    async territoriesByCoreId(coreTerritoryId) {
      return readTx('territoriesByCoreId', async (trx) => {
        const result =
          await sql<NodeRow>`${territoryQuerySql(sql`t.core_territory_id=${coreTerritoryId}`)} order by t.territory_id`.execute(
            trx
          );
        return result.rows.map(toNode);
      });
    },

    async territoriesByCoreIds(coreTerritoryIds) {
      if (coreTerritoryIds.length === 0) return ok([]);
      return readTx('territoriesByCoreIds', async (trx) => {
        const result =
          await sql<NodeRow>`${territoryQuerySql(sql`t.core_territory_id = any(${coreTerritoryIds}::integer[])`)} order by t.territory_id`.execute(
            trx
          );
        return result.rows.map(toNode);
      });
    },

    async countyAliases() {
      return readTx('countyAliases', readCountyAliases);
    },

    async datasetsForTerritory(territoryId, contextCode) {
      return readTx('datasetsForTerritory', async (trx) => {
        const context =
          contextCode === undefined
            ? sql``
            : sql`with recursive selected_contexts as (
          select context_code from ins.contexts where context_code=${contextCode}
          union select child.context_code from ins.contexts child join selected_contexts parent on child.parent_code=parent.context_code
        )`;
        const res = await sql<{ dataset_code: string }>`
          ${context} select d.dataset_code ${datasetFrom}
          where publication.facts_ready and (
            exists (select 1 from ins.dataset_geo_tuples g where g.dataset_code=d.dataset_code
              and g.has_modern_facts and ${geographicCatalogScopeSql({ kind: 'modern', territoryIds: [territoryId] })})
            or (c.geo_dimension_count=0 and exists(select 1 from ins.territory_nodes node where node.territory_id=${territoryId} and node.level='NATIONAL'))
          ) and ${contextCode === undefined ? sql`true` : sql`d.context_code in (select context_code from selected_contexts)`}
          order by d.dataset_code`.execute(trx);
        return res.rows.map((row) => row.dataset_code);
      });
    },

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
