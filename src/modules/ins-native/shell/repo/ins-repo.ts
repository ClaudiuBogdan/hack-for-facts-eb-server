/**
 * Native Chronos INS reads. Observation lists intersect physical classification
 * pins with complete published geographic tuples and actual-period eligibility.
 * Rows retain their source identity; paging reads limit+1 and never counts facts.
 * Default probes require one eligible source tuple before reading fully pinned cells.
 * All reads and hydration share a repeatable-read, read-only snapshot.
 */

import { sql, type RawBuilder } from 'kysely';
import { err, ok } from 'neverthrow';

import { readDefaultSeries as readDefaultSeriesInSnapshot } from './default-series.js';
import { factOrder, factSelect, slotColumn, type FactRow } from './facts.js';
import { geographicCatalogScopeSql, observationGeographySql } from './geography-sql.js';
import {
  geographicView,
  readGeographicDimensions,
  readGeographicDimensionsForDatasets,
  readGeographicTuplesForDatasets,
} from './geography.js';
import { InsPublicationUnavailable } from './publication-error.js';
import {
  assertDatasetsPublished,
  datasetPeriodicities,
  datasetPublicationFrom,
} from './publication.js';
import {
  dbError,
  inTrxRunner,
  openSnapshot,
  perReadRunner,
  type Db,
  type Runner,
  type Trx,
} from './snapshot.js';
import { nodeSelect, territoryQuerySql, toNode, type NodeRow } from './territory.js';
import { escapeLike, foldSearch } from '../../core/fold.js';
import {
  MAX_SLOTS,
  type InsContext,
  type InsDataStatus,
  type InsDatasetFilter,
  type InsDatasetView,
  type InsDimensionRole,
  type InsDimensionView,
  type InsMemberRole,
  type InsMemberView,
  type InsObservationView,
  type InsPage,
  type InsPeriodView,
  type InsPeriodicity,
  type SlotPins,
  type InsUnitKind,
  type InsUnitView,
} from '../../core/types.js';

import type { InsDefaultPin, InsRepo } from '../../core/ports.js';

/**
 * A date column as `YYYY-MM-DD`. The kernel pool returns dates as wire strings
 * (pool.ts); a plain pg pool returns JS Dates (local-midnight), which would
 * shift a day under toISOString — so a Date is formatted by its LOCAL fields.
 */
const isoDate = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 10 ? v.slice(0, 10) : v;
  if (v instanceof Date) {
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${String(v.getFullYear())}-${m}-${d}`;
  }
  return null;
};

/** A timestamptz column as an ISO string, whatever parser the pool used. */
const isoTimestamp = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return v instanceof Date ? v.toISOString() : null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Row → view mapping
// ─────────────────────────────────────────────────────────────────────────────

interface DatasetRow {
  dataset_code: string;
  matrix_name_ro: string;
  matrix_name_en: string | null;
  periodicities: string[];
  dimension_count: number;
  classification_dim_count: number;
  time_dim_index: number;
  unit_dim_index: number;
  ultima_actualizare_date: string | null;
  context_code: string | null;
  context_path: string | null;
  pivot_custody_sha256: string | null;
  source_url: string;
  facts_ready: boolean;
  not_loaded: boolean;
  revision_id: string | null;
  transform_contract_sha256: string | null;
  applied_at: string | null;
  observation_count: string | null;
  first_period_start: string | null;
  last_period_end: string | null;
  periodicities_observed: string[] | null;
  has_lau: boolean | null;
  has_county: boolean | null;
  has_region: boolean | null;
  has_national: boolean | null;
  definition_ro: string | null;
  definition_en: string | null;
  methodology_ro: string | null;
  data_sources_ro: string | null;
  source_year_start: number | null;
  source_year_end: number | null;
  source_last_update: string | null;
  computed_at: string | null;
  context_name_ro: string | null;
  context_name_en: string | null;
}

const toDataset = (r: DatasetRow): InsDatasetView => {
  const count = r.facts_ready && r.observation_count !== null ? Number(r.observation_count) : null;
  const observed = r.facts_ready ? (r.periodicities_observed ?? []) : [];
  const firstStart = isoDate(r.first_period_start);
  const lastEnd = isoDate(r.last_period_end);
  return {
    code: r.dataset_code,
    nameRo: r.matrix_name_ro,
    nameEn: r.matrix_name_en,
    definitionRo: r.definition_ro,
    definitionEn: r.definition_en,
    methodologyRo: r.methodology_ro,
    dataSourcesRo: r.data_sources_ro,
    periodicities: (observed.length > 0 ? observed : r.periodicities) as InsPeriodicity[],
    yearRange:
      r.facts_ready && firstStart !== null && lastEnd !== null
        ? [Number(firstStart.slice(0, 4)), Number(lastEnd.slice(0, 4))]
        : null,
    sourceYearRange:
      r.source_year_start !== null && r.source_year_end !== null
        ? [r.source_year_start, r.source_year_end]
        : null,
    dimensionCount: r.dimension_count,
    classificationDimCount: r.classification_dim_count,
    timeDimIndex: r.time_dim_index,
    unitDimIndex: r.unit_dim_index,
    hasLau: r.facts_ready && (r.has_lau ?? false),
    hasCounty: r.facts_ready && (r.has_county ?? false),
    hasRegion: r.facts_ready && (r.has_region ?? false),
    hasNational: r.facts_ready && (r.has_national ?? false),
    dataStatus: r.facts_ready ? 'AVAILABLE' : 'CATALOG_ONLY',
    publicationStatus: r.facts_ready ? 'READY' : r.not_loaded ? 'NOT_LOADED' : 'UNCERTIFIED',
    observationCount: count,
    computedAt: r.facts_ready ? isoTimestamp(r.computed_at) : null,
    sourceLastUpdate: isoDate(r.source_last_update) ?? isoDate(r.ultima_actualizare_date),
    contextCode: r.context_code,
    contextNameRo: r.context_name_ro,
    contextNameEn: r.context_name_en,
    contextPath: r.context_path,
    custodySha256: r.facts_ready ? r.pivot_custody_sha256 : null,
    revisionId: r.facts_ready ? r.revision_id : null,
    transformContractSha256: r.facts_ready ? r.transform_contract_sha256 : null,
    publishedAt: r.facts_ready ? isoTimestamp(r.applied_at) : null,
    sourceUrl: r.source_url,
  };
};

const datasetSelect = sql`
  d.dataset_code, d.matrix_name_ro, d.matrix_name_en, d.periodicities, d.dimension_count,
  d.classification_dim_count, d.time_dim_index, d.unit_dim_index, d.ultima_actualizare_date,
  d.context_code, d.context_path, d.pivot_custody_sha256, d.source_url,
  publication.facts_ready, publication.not_loaded, r.revision_id, r.transform_contract_sha256, r.applied_at,
  c.observation_count, c.first_period_start, c.last_period_end, c.periodicities_observed,
  c.has_lau, c.has_county, c.has_region, c.has_national, c.definition_ro, c.definition_en,
  c.methodology_ro, c.data_sources_ro, c.source_year_start, c.source_year_end,
  c.source_last_update, c.computed_at, ctx.name_ro as context_name_ro, ctx.name_en as context_name_en`;

const datasetFrom = datasetPublicationFrom();

interface MemberRow {
  dataset_code: string;
  dim_index: number;
  dim_label_ro: string;
  dim_label_en: string | null;
  nom_item_id: number;
  ordinal: number | null;
  member_role: string;
  label_override: string | null;
  parent_nom_item_id: number | null;
  label_ro: string;
  label_en: string | null;
  territory_resolution: string | null;
  territory_id: string | null;
  code: string | null;
  siruta_code: string | null;
  level: string | null;
  name_ro: string | null;
  parent_id: string | null;
  core_territory_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
}

const toMember = (r: MemberRow): InsMemberView => ({
  datasetCode: r.dataset_code,
  dimIndex: r.dim_index,
  dimLabelRo: r.dim_label_ro,
  dimLabelEn: r.dim_label_en,
  nomItemId: r.nom_item_id,
  ordinal: r.ordinal,
  labelRo: r.label_override ?? r.label_ro,
  labelEn: r.label_en,
  memberRole: r.member_role as InsMemberRole,
  parentNomItemId: r.parent_nom_item_id,
  territory:
    r.territory_id !== null && r.code !== null && r.level !== null && r.name_ro !== null
      ? toNode({
          territory_id: r.territory_id,
          code: r.code,
          siruta_code: r.siruta_code,
          level: r.level,
          name_ro: r.name_ro,
          parent_id: r.parent_id,
          core_territory_id: r.core_territory_id,
          parent_code: r.parent_code,
          parent_name_ro: r.parent_name_ro,
        })
      : null,
  territoryResolution: r.territory_resolution,
});

const memberSelect = sql`
  m.dataset_code, m.dim_index, dd.label_ro as dim_label_ro, dd.label_en as dim_label_en,
  m.nom_item_id, m.ordinal, m.member_role, m.label_override,
  m.parent_nom_item_id, n.label_ro, n.label_en, mt.resolution as territory_resolution,
  t.territory_id, t.code, t.siruta_code, t.level, t.name_ro, t.parent_id, t.core_territory_id,
  p.code as parent_code, p.name_ro as parent_name_ro`;

const memberFrom = sql`
  from ins.dataset_dimension_members m
  join ins.dataset_dimensions dd on dd.dataset_code = m.dataset_code and dd.dim_index = m.dim_index
  join ins.nomenclature_items n on n.nom_item_id = m.nom_item_id
  left join ins.member_territory mt
    on mt.dataset_code = m.dataset_code and mt.dim_index = m.dim_index and mt.nom_item_id = m.nom_item_id
  left join ins.territory_nodes t on t.territory_id = mt.territory_id
  left join ins.territory_nodes p on p.territory_id = t.parent_id`;

interface UnitRow {
  dataset_code: string;
  unit_nom_item_id: number;
  unit_label_ro: string;
  label_en: string | null;
  base_unit: string | null;
  scale_factor: string;
  unit_kind: string;
  regime: string | null;
}

const toUnit = (r: UnitRow): InsUnitView => ({
  nomItemId: r.unit_nom_item_id,
  labelRo: r.unit_label_ro,
  labelEn: r.label_en,
  baseUnit: r.base_unit,
  scaleFactor: r.scale_factor,
  unitKind: r.unit_kind as InsUnitKind,
  currencyRegime:
    r.regime === null || r.regime === 'UNKNOWN' || r.regime === 'MIXED_EVIDENCE' ? null : r.regime,
});

const unitsSql = (datasetCodes: readonly string[]): RawBuilder<UnitRow> => sql<UnitRow>`
  select ms.dataset_code, ms.unit_nom_item_id, ms.unit_label_ro, n.label_en, ms.base_unit, ms.scale_factor,
         ms.unit_kind, cr.regime
  from ins.measures ms
  join ins.nomenclature_items n on n.nom_item_id = ms.unit_nom_item_id
  left join ins.currency_regimes cr
    on cr.dataset_code = ms.dataset_code and cr.unit_nom_item_id = ms.unit_nom_item_id
  where ms.dataset_code = any(${datasetCodes}::text[])
  order by ms.dataset_code, ms.unit_nom_item_id`;

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

const likeNeedle = (needle: string): string => `%${escapeLike(foldSearch(needle))}%`;

const page = <T>(rows: readonly T[], total: number, limit: number, offset: number): InsPage<T> => ({
  nodes: rows.slice(0, limit),
  totalCount: total,
  hasNextPage: offset + limit < total,
  hasPreviousPage: offset > 0,
});

export const makeInsRepo = (db: Db): InsRepo => makeRepoOn(db, perReadRunner(db));

/** Module-private assembly seam: every nested usecase retains this snapshot. */
export const makeInsSnapshotRepo = (db: Db, runner: Runner): InsRepo =>
  makeRepoOn(db, runner, true);

const makeRepoOn = (db: Db, readTx: Runner, snapshotBound = false): InsRepo => {
  const datasetWhere = (filter: InsDatasetFilter): RawBuilder<unknown> => {
    const parts: RawBuilder<unknown>[] = [sql`true`];
    if (filter.codes !== undefined && filter.codes.length > 0) {
      parts.push(
        sql`d.dataset_code in (${sql.join(filter.codes.map((c) => sql`${c.trim().toUpperCase()}`))})`
      );
    }
    if (filter.search !== undefined && filter.search.trim() !== '') {
      parts.push(
        sql`coalesce(c.name_search, lower(d.matrix_name_ro) || ' ' || lower(d.dataset_code)) like ${likeNeedle(filter.search)}`
      );
    }
    if (filter.contextCode !== undefined && filter.contextCode !== '') {
      parts.push(sql`d.context_code = ${filter.contextCode}`);
    }
    if (filter.rootContextCode !== undefined && filter.rootContextCode !== '') {
      parts.push(
        sql`d.context_path like (select r.path from ins.contexts r where r.context_code = ${filter.rootContextCode}) || '%'`
      );
    }
    if (filter.periodicities !== undefined && filter.periodicities.length > 0) {
      const arr = sql`array[${sql.join(filter.periodicities.map((p) => sql`${p}`))}]::text[]`;
      parts.push(sql`${datasetPeriodicities} && ${arr}`);
    }
    const loaded = sql`publication.facts_ready`;
    if (filter.dataStatus === undefined) {
      parts.push(loaded);
    } else if (filter.dataStatus.length > 0) {
      const wants = new Set<InsDataStatus>(filter.dataStatus);
      if (!wants.has('AVAILABLE')) parts.push(sql`not (${loaded})`);
      if (!wants.has('CATALOG_ONLY')) parts.push(loaded);
    }
    if (filter.hasUatData !== undefined)
      parts.push(
        sql`(publication.facts_ready and coalesce(c.has_lau, false)) = ${filter.hasUatData}`
      );
    if (filter.hasCountyData !== undefined)
      parts.push(
        sql`(publication.facts_ready and coalesce(c.has_county, false)) = ${filter.hasCountyData}`
      );
    return sql.join(parts, sql` and `);
  };

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
    withSnapshot(fn) {
      if (snapshotBound) return fn(repository);
      return openSnapshot(db, (trx) => fn(makeRepoOn(db, inTrxRunner(trx), true))).catch(
        (cause: unknown) => err(dbError(cause, 'withSnapshot'))
      );
    },

    async listDatasets(filter, limit, offset) {
      return readTx('listDatasets', async (trx) => {
        const res = await sql<DatasetRow & { total: string }>`
          select ${datasetSelect}, count(*) over() as total ${datasetFrom}
          where ${datasetWhere(filter)}
          order by d.dataset_code
          limit ${limit} offset ${offset}`.execute(trx);
        const total =
          res.rows.length > 0 ? Number(res.rows[0]?.total) : await countDatasets(trx, filter);
        return page(res.rows.map(toDataset), total, limit, offset);
      });
    },

    async getDataset(code) {
      return readTx('getDataset', async (trx) => {
        const res =
          await sql<DatasetRow>`select ${datasetSelect} ${datasetFrom} where d.dataset_code = ${code}`.execute(
            trx
          );
        const row = res.rows[0];
        return row === undefined ? null : toDataset(row);
      });
    },

    async getDatasets(codes) {
      if (codes.length === 0) return ok([]);
      return readTx('getDatasets', async (trx) => {
        const res = await sql<DatasetRow>`select ${datasetSelect} ${datasetFrom}
          where d.dataset_code in (${sql.join(codes.map((c) => sql`${c}`))})`.execute(trx);
        const byCode = new Map(res.rows.map((r) => [r.dataset_code, toDataset(r)]));
        return codes.flatMap((c) => {
          const d = byCode.get(c);
          return d === undefined ? [] : [d];
        });
      });
    },

    async listDimensions(datasetCode) {
      return repository.dimensionsForDatasets([datasetCode]);
    },

    async dimensionsForDatasets(datasetCodes) {
      if (datasetCodes.length === 0) return ok([]);
      return readTx('dimensionsForDatasets', async (trx) => {
        const res = await sql<{
          dataset_code: string;
          dim_index: number;
          slot_index: number | null;
          semantic_role: string;
          label_ro: string;
          label_en: string | null;
          option_count: number;
          parent_dim_index: number | null;
          is_territorial: boolean;
        }>`
          select dd.dataset_code, dd.dim_index, dd.slot_index, dd.semantic_role, dd.label_ro, dd.label_en,
                 dd.option_count, dd.parent_dim_index,
                 exists (select 1 from ins.dataset_geo_dimensions gd
                         where gd.dataset_code = dd.dataset_code and gd.dim_index = dd.dim_index) as is_territorial
          from ins.dataset_dimensions dd
          where dd.dataset_code = any(${datasetCodes}::text[])
          order by dd.dataset_code, dd.dim_index`.execute(trx);
        return res.rows.map((r): InsDimensionView => ({
          datasetCode: r.dataset_code,
          dimIndex: r.dim_index,
          slotIndex: r.slot_index,
          role: r.semantic_role as InsDimensionRole,
          labelRo: r.label_ro,
          labelEn: r.label_en,
          optionCount: r.option_count,
          parentDimIndex: r.parent_dim_index,
          isTerritorial: r.is_territorial,
        }));
      });
    },

    async listMembers(datasetCode, dimIndex, search, limit, offset) {
      return readTx('listMembers', async (trx) => {
        const needle =
          search === undefined
            ? sql`true`
            : sql`(lower(unaccent(n.label_ro)) like ${likeNeedle(search)} or lower(unaccent(coalesce(n.label_en, ''))) like ${likeNeedle(search)})`;
        const res = await sql<MemberRow & { total: string }>`
          select ${memberSelect}, count(*) over() as total ${memberFrom}
          where m.dataset_code = ${datasetCode} and m.dim_index = ${dimIndex} and ${needle}
          order by m.ordinal nulls last, m.nom_item_id
          limit ${limit} offset ${offset}`.execute(trx);
        const total = Number(res.rows[0]?.total ?? 0);
        return page(res.rows.map(toMember), total, limit, offset);
      });
    },

    async membersByIds(datasetCode, nomItemIds) {
      return repository.membersForDatasets([{ datasetCode, nomItemIds }]);
    },

    async membersForDatasets(requests) {
      const wanted = new Map(
        requests.flatMap(({ datasetCode, nomItemIds }) =>
          nomItemIds.map(
            (id) =>
              [
                JSON.stringify([datasetCode, id]),
                { dataset_code: datasetCode, nom_item_id: id },
              ] as const
          )
        )
      );
      if (wanted.size === 0) return ok([]);
      return readTx('membersForDatasets', async (trx) => {
        const res = await sql<MemberRow>`select ${memberSelect} ${memberFrom}
          join jsonb_to_recordset(${JSON.stringify([...wanted.values()])}::jsonb)
            as wanted(dataset_code text, nom_item_id int)
            on wanted.dataset_code=m.dataset_code and wanted.nom_item_id=m.nom_item_id
          order by m.dataset_code, m.dim_index, m.ordinal nulls last`.execute(trx);
        return res.rows.map(toMember);
      });
    },

    async listUnits(datasetCode) {
      return readTx('listUnits', async (trx) =>
        (await unitsSql([datasetCode]).execute(trx)).rows.map(toUnit)
      );
    },

    async periodsByLabels(labels) {
      if (labels.length === 0) return ok([]);
      return readTx('periodsByLabels', async (trx) => {
        const res = await sql<{
          period_id: number;
          periodicity: string;
          period_start: string;
          period_end: string;
          label_ro: string;
        }>`select period_id, periodicity, period_start, period_end, label_ro from ins.periods
           where label_ro in (${sql.join(labels.map((l) => sql`${l}`))})`.execute(trx);
        return res.rows.map((r): InsPeriodView => ({
          periodId: r.period_id,
          periodicity: r.periodicity as InsPeriodicity,
          periodStart: isoDate(r.period_start) ?? '',
          periodEnd: isoDate(r.period_end) ?? '',
          labelRo: r.label_ro,
        }));
      });
    },

    async listContexts(filter, limit, offset) {
      return readTx('listContexts', async (trx) => {
        const parts: RawBuilder<unknown>[] = [sql`true`];
        if (filter.search !== undefined && filter.search.trim() !== '') {
          parts.push(sql`c.name_search like ${likeNeedle(filter.search)}`);
        }
        if (filter.level !== undefined) parts.push(sql`c.level = ${filter.level}`);
        if (filter.parentCode !== undefined && filter.parentCode !== '')
          parts.push(sql`c.parent_code = ${filter.parentCode}`);
        if (filter.rootContextCode !== undefined && filter.rootContextCode !== '') {
          parts.push(
            sql`c.path like (select r.path from ins.contexts r where r.context_code = ${filter.rootContextCode}) || '%'`
          );
        }
        const res = await sql<{
          context_code: string;
          parent_code: string | null;
          level: number;
          name_ro: string;
          name_en: string | null;
          path: string;
          ordinal: number | null;
          dataset_count: string;
          total: string;
        }>`
          select c.context_code, c.parent_code, c.level, c.name_ro, c.name_en, c.path, c.ordinal,
                 (select count(*) from ins.datasets d where d.context_path like c.path || '%') as dataset_count,
                 count(*) over() as total
          from ins.contexts c
          where ${sql.join(parts, sql` and `)}
          order by c.level, c.ordinal nulls last, c.context_code
          limit ${limit} offset ${offset}`.execute(trx);
        const total = Number(res.rows[0]?.total ?? 0);
        return page(
          res.rows.map((r): InsContext => ({
            code: r.context_code,
            parentCode: r.parent_code,
            level: r.level,
            nameRo: r.name_ro,
            nameEn: r.name_en,
            path: r.path,
            ordinal: r.ordinal,
            datasetCount: Number(r.dataset_count),
          })),
          total,
          limit,
          offset
        );
      });
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

    async totalMember(datasetCode, dimIndex) {
      return readTx('totalMember', async (trx) => {
        const res = await sql<{ nom_item_id: number }>`
          select nom_item_id from ins.dataset_dimension_members
          where dataset_code = ${datasetCode} and dim_index = ${dimIndex} and member_role = 'TOTAL'`.execute(
          trx
        );
        return res.rows.length === 1 ? (res.rows[0]?.nom_item_id ?? null) : null;
      });
    },

    async defaultPins(datasetCodes) {
      if (datasetCodes.length === 0) return ok([]);
      return readTx('defaultPins', async (trx) => {
        const res = await sql<{
          dataset_code: string;
          dim_index: number;
          nom_item_id: number;
          policy: string;
        }>`
          select dataset_code, dim_index, nom_item_id, policy from ins.default_series
          where dataset_code in (${sql.join(datasetCodes.map((c) => sql`${c}`))})
          order by dataset_code, dim_index`.execute(trx);
        return res.rows.map((r): InsDefaultPin => ({
          datasetCode: r.dataset_code,
          dimIndex: r.dim_index,
          nomItemId: r.nom_item_id,
          policy: r.policy,
        }));
      });
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

  async function countDatasets(trx: Trx, filter: InsDatasetFilter): Promise<number> {
    const res = await sql<{
      n: string;
    }>`select count(*)::text as n ${datasetFrom} where ${datasetWhere(filter)}`.execute(trx);
    return Number(res.rows[0]?.n ?? 0);
  }
};
