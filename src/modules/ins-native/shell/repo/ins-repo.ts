/**
 * INS native module — the repository over Chronos `ins.*` (plan §3.3).
 *
 * Catalog reads are plain Kysely over the small catalog tables. Fact reads are
 * raw SQL built from FULLY RESOLVED physical predicates: `dataset_code = $1`
 * (partition pruning) + one OR-ed AND-group of `dimN_member_id` pins per
 * requested territory + unit / period predicates, ordered by the total
 * contract `period_end desc, period_start desc, identity tuple`, read with
 * `limit + 1` and NEVER counted. Batched series reads (`latestForSeries`) are
 * one `UNION ALL` of per-series identity-index probes.
 *
 * Every multi-statement read runs in one REPEATABLE READ, READ ONLY
 * transaction with `set local statement_timeout` INSIDE it (the legacy
 * `SET LOCAL` outside a transaction was a no-op), so a page and its catalog
 * hydration see one publication moment.
 */

import { sql, type RawBuilder } from 'kysely';
import { err, ok } from 'neverthrow';

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
import { escapeLike, foldSearch } from '../../core/fold.js';
import {
  INS_TERRITORY_LEVELS,
  MAX_SLOTS,
  isMemberList,
  type InsContext,
  type InsDataStatus,
  type InsDatasetFilter,
  type InsDatasetView,
  type InsDimensionRole,
  type InsDimensionView,
  type InsFactQuery,
  type InsMemberRole,
  type InsMemberView,
  type InsObservationView,
  type InsPage,
  type InsPeriodView,
  type InsPeriodicity,
  type InsSeriesSpec,
  type InsTerritoryLevel,
  type SlotPins,
  type InsTerritoryNode,
  type InsUnitKind,
  type InsUnitView,
} from '../../core/types.js';

import type {
  InsDefaultPin,
  InsRepo,
  InsSeriesRow,
  InsTerritoryBinding,
  InsTerritoryDimension,
} from '../../core/ports.js';

/** Series per batched statement; above this the UNION ALL is split. */
const SERIES_PER_STATEMENT = 40;

const toInt = (v: string | number | null): number | null => (v === null ? null : Number(v));

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

interface NodeRow {
  territory_id: string;
  code: string;
  siruta_code: string | null;
  level: string;
  name_ro: string;
  parent_id: string | null;
  core_territory_id: number | null;
  parent_code: string | null;
  parent_name_ro: string | null;
}

const toNode = (r: NodeRow): InsTerritoryNode => ({
  territoryId: Number(r.territory_id),
  code: r.code,
  sirutaCode: r.siruta_code,
  level: r.level as InsTerritoryLevel,
  nameRo: r.name_ro,
  parentId: toInt(r.parent_id),
  parentCode: r.parent_code,
  parentNameRo: r.parent_name_ro,
  coreTerritoryId: r.core_territory_id,
});

/** The node select with its parent joined — the one shape every territory read returns. */
const nodeSelect = sql`
  t.territory_id, t.code, t.siruta_code, t.level, t.name_ro, t.parent_id, t.core_territory_id,
  p.code as parent_code, p.name_ro as parent_name_ro`;

const territoryQuerySql = (where: RawBuilder<unknown>): RawBuilder<NodeRow> => sql<NodeRow>`
  select ${nodeSelect}
  from ins.territory_nodes t
  left join ins.territory_nodes p on p.territory_id = t.parent_id
  where ${where}`;

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

const unitSql = (datasetCode: string): RawBuilder<UnitRow> => sql<UnitRow>`
  select ms.unit_nom_item_id, ms.unit_label_ro, n.label_en, ms.base_unit, ms.scale_factor,
         ms.unit_kind, cr.regime
  from ins.measures ms
  join ins.nomenclature_items n on n.nom_item_id = ms.unit_nom_item_id
  left join ins.currency_regimes cr
    on cr.dataset_code = ms.dataset_code and cr.unit_nom_item_id = ms.unit_nom_item_id
  where ms.dataset_code = ${datasetCode}
  order by ms.unit_nom_item_id`;

interface FactRow {
  dataset_code: string;
  dim1_member_id: number | null;
  dim2_member_id: number | null;
  dim3_member_id: number | null;
  dim4_member_id: number | null;
  dim5_member_id: number | null;
  dim6_member_id: number | null;
  dim7_member_id: number | null;
  time_nom_item_id: number;
  unit_nom_item_id: number;
  period_id: number;
  period_start: string;
  period_end: string;
  currency_code: string | null;
  value: string | null;
  value_status: string | null;
  periodicity: string;
  period_label_ro: string;
  series_key?: string;
}

const factSelect = sql`
  o.dataset_code, o.dim1_member_id, o.dim2_member_id, o.dim3_member_id, o.dim4_member_id,
  o.dim5_member_id, o.dim6_member_id, o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id,
  o.period_id, o.period_start, o.period_end, o.currency_code, o.value, o.value_status,
  pe.periodicity, pe.label_ro as period_label_ro`;

const factOrder = sql`
  order by o.period_end desc, o.period_start desc, o.dim1_member_id, o.dim2_member_id,
           o.dim3_member_id, o.dim4_member_id, o.dim5_member_id, o.dim6_member_id,
           o.dim7_member_id, o.time_nom_item_id, o.unit_nom_item_id`;

const slotColumn = (slot: number): RawBuilder<unknown> => sql.ref(`o.dim${String(slot)}_member_id`);

/**
 * One AND-group: `(o.dimA in (...) and o.dimB in (...))`. A level predicate
 * becomes a semi-join on member_territory (every member bound at that level),
 * never an id list a limit could truncate.
 */
const pinGroupSql = (datasetCode: string, pins: SlotPins): RawBuilder<unknown> => {
  const parts: RawBuilder<unknown>[] = [];
  for (const [slot, pred] of pins) {
    if (isMemberList(pred)) {
      if (pred.length === 0) {
        parts.push(sql`false`);
        continue;
      }
      parts.push(sql`${slotColumn(slot)} in (${sql.join(pred.map((id) => sql`${id}`))})`);
      continue;
    }
    parts.push(sql`${slotColumn(slot)} in (
      select mt.nom_item_id from ins.member_territory mt
      where mt.dataset_code = ${datasetCode} and mt.dim_index = ${pred.dimIndex}
        and mt.resolution = 'RESOLVED' and mt.territory_level = ${pred.memberLevel})`);
    if (pred.ids !== undefined) {
      parts.push(
        pred.ids.length === 0
          ? sql`false`
          : sql`${slotColumn(slot)} in (${sql.join(pred.ids.map((id) => sql`${id}`))})`
      );
    }
  }
  return parts.length === 0 ? sql`true` : sql`(${sql.join(parts, sql` and `)})`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Hydration of fact rows into observation views
// ─────────────────────────────────────────────────────────────────────────────

const hydrate = async (
  trx: Trx,
  datasetCode: string,
  rows: readonly FactRow[]
): Promise<{ views: InsObservationView[]; keys: string[] }> => {
  if (rows.length === 0) return { views: [], keys: [] };
  const dims = await sql<{ dim_index: number; slot_index: number }>`
    select dim_index, slot_index from ins.dataset_dimensions
    where dataset_code = ${datasetCode} and semantic_role = 'classification'
    order by dim_index`.execute(trx);
  const slotToDim = new Map(dims.rows.map((d) => [d.slot_index, d.dim_index]));

  const memberIds = new Set<number>();
  for (const r of rows) {
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      const id = r[`dim${String(slot)}_member_id` as keyof FactRow] as number | null;
      if (id !== null) memberIds.add(id);
    }
  }
  const members =
    memberIds.size === 0
      ? []
      : (
          await sql<MemberRow>`select ${memberSelect} ${memberFrom}
            where m.dataset_code = ${datasetCode}
              and m.nom_item_id in (${sql.join([...memberIds].map((id) => sql`${id}`))})`.execute(
            trx
          )
        ).rows.map(toMember);
  const memberByKey = new Map(
    members.map((m) => [`${String(m.dimIndex)}:${String(m.nomItemId)}`, m])
  );
  const units = new Map(
    (await unitSql(datasetCode).execute(trx)).rows.map((u) => [u.unit_nom_item_id, toUnit(u)])
  );
  // A row whose territorial members are all TOTAL members is the national row:
  // it carries the NATIONAL node (the legacy surface answered code 'RO' for it).
  const needsNational = members.some((m) => m.territoryResolution === 'TOTAL_MEMBER');
  const national = needsNational
    ? ((await territoryQuerySql(sql`t.level = 'NATIONAL'`).execute(trx)).rows.map(toNode)[0] ??
      null)
    : null;

  const views: InsObservationView[] = [];
  const keys: string[] = [];
  for (const r of rows) {
    const slots: (number | null)[] = [];
    const rowMembers: InsMemberView[] = [];
    let territory: InsTerritoryNode | null = null;
    let territoryDepth = -1;
    let sawTotalMember = false;
    for (let slot = 1; slot <= MAX_SLOTS; slot++) {
      const id = r[`dim${String(slot)}_member_id` as keyof FactRow] as number | null;
      slots.push(id);
      const dimIndex = slotToDim.get(slot);
      if (id === null || dimIndex === undefined) continue;
      const m = memberByKey.get(`${String(dimIndex)}:${String(id)}`);
      if (m === undefined) continue;
      rowMembers.push(m);
      if (m.territoryResolution === 'TOTAL_MEMBER') sawTotalMember = true;
      if (m.territory !== null) {
        const depth = INS_TERRITORY_LEVELS.indexOf(m.territory.level);
        if (depth > territoryDepth) {
          territoryDepth = depth;
          territory = m.territory;
        }
      }
    }
    if (territory === null && sawTotalMember) territory = national;
    const unit = units.get(r.unit_nom_item_id);
    if (unit === undefined) continue; // a fact without a measure row is a load defect, not a served row
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
        periodStart: isoDate(r.period_start) ?? '',
        periodEnd: isoDate(r.period_end) ?? '',
        labelRo: r.period_label_ro,
      },
      value: r.value,
      valueStatus: r.value_status,
      currencyCode: r.currency_code,
      members: rowMembers,
      territory,
      unit,
    });
    keys.push(r.series_key ?? '');
  }
  return { views, keys };
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
      return readTx('listDimensions', async (trx) => {
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
                 exists (select 1 from ins.member_territory mt
                         where mt.dataset_code = dd.dataset_code and mt.dim_index = dd.dim_index) as is_territorial
          from ins.dataset_dimensions dd
          where dd.dataset_code = ${datasetCode}
          order by dd.dim_index`.execute(trx);
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
      if (nomItemIds.length === 0) return ok([]);
      return readTx('membersByIds', async (trx) => {
        const res = await sql<MemberRow>`select ${memberSelect} ${memberFrom}
          where m.dataset_code = ${datasetCode}
            and m.nom_item_id in (${sql.join(nomItemIds.map((id) => sql`${id}`))})
          order by m.dim_index, m.ordinal nulls last`.execute(trx);
        return res.rows.map(toMember);
      });
    },

    async listUnits(datasetCode) {
      return readTx('listUnits', async (trx) =>
        (await unitSql(datasetCode).execute(trx)).rows.map(toUnit)
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

    async ancestorsOf(territoryId) {
      return readTx('ancestorsOf', async (trx) => {
        const res = await sql<NodeRow & { depth: number }>`
          with recursive up as (
            select t.parent_id, 1 as depth from ins.territory_nodes t where t.territory_id = ${territoryId}
            union all
            select t.parent_id, up.depth + 1 from up join ins.territory_nodes t on t.territory_id = up.parent_id
            where up.parent_id is not null
          )
          select ${nodeSelect}, up.depth
          from up
          join ins.territory_nodes t on t.territory_id = up.parent_id
          left join ins.territory_nodes p on p.territory_id = t.parent_id
          order by up.depth`.execute(trx);
        return res.rows.map(toNode);
      });
    },

    withSnapshot(fn) {
      // Nested usecases must retain the request publication snapshot.
      if (snapshotBound) return fn(repository);
      return openSnapshot(db, (trx) => fn(makeRepoOn(db, inTrxRunner(trx), true))).catch(
        (cause: unknown) => err(dbError(cause, 'withSnapshot'))
      );
    },

    async territoryDimensions(datasetCode) {
      return readTx('territoryDimensions', async (trx) => {
        // Levels come from the RESOLVED members of the whole dimension (a TOTAL
        // row's territory_level is nullable and NULL on the live locality rows);
        // the TOTAL member is the dimension's member_role = 'TOTAL' member.
        const res = await sql<{
          dim_index: number;
          slot_index: number;
          levels: string[] | null;
          total_nom_item_id: number | null;
        }>`
          select dd.dim_index, dd.slot_index,
                 (select array_agg(distinct mt.territory_level order by mt.territory_level)
                    from ins.member_territory mt
                   where mt.dataset_code = dd.dataset_code and mt.dim_index = dd.dim_index
                     and mt.resolution = 'RESOLVED' and mt.territory_level is not null) as levels,
                 (select m.nom_item_id from ins.dataset_dimension_members m
                   where m.dataset_code = dd.dataset_code and m.dim_index = dd.dim_index
                     and m.member_role = 'TOTAL') as total_nom_item_id
          from ins.dataset_dimensions dd
          where dd.dataset_code = ${datasetCode} and dd.slot_index is not null
            and exists (select 1 from ins.member_territory mt
                         where mt.dataset_code = dd.dataset_code and mt.dim_index = dd.dim_index
                           and mt.resolution = 'RESOLVED')
          order by dd.dim_index`.execute(trx);
        return res.rows.map((r): InsTerritoryDimension => ({
          datasetCode,
          dimIndex: r.dim_index,
          slotIndex: r.slot_index,
          levels: (r.levels ?? []) as InsTerritoryLevel[],
          totalNomItemId: r.total_nom_item_id,
        }));
      });
    },

    async territoryBindings(datasetCode, territoryIds) {
      if (territoryIds.length === 0) return ok([]);
      return readTx('territoryBindings', async (trx) => {
        const res = await sql<{
          dim_index: number;
          slot_index: number;
          nom_item_id: number;
          territory_id: string;
          territory_level: string;
        }>`
          select mt.dim_index, dd.slot_index, mt.nom_item_id, mt.territory_id, mt.territory_level
          from ins.member_territory mt
          join ins.dataset_dimensions dd on dd.dataset_code = mt.dataset_code and dd.dim_index = mt.dim_index
          where mt.dataset_code = ${datasetCode} and dd.slot_index is not null
            and mt.resolution = 'RESOLVED'
            and mt.territory_id in (${sql.join(territoryIds.map((id) => sql`${id}`))})
          order by mt.dim_index, mt.nom_item_id`.execute(trx);
        return res.rows.map((r): InsTerritoryBinding => ({
          datasetCode,
          dimIndex: r.dim_index,
          slotIndex: r.slot_index,
          nomItemId: r.nom_item_id,
          territoryId: Number(r.territory_id),
          territoryLevel: r.territory_level as InsTerritoryLevel,
        }));
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

    async datasetsWithLevel(level) {
      return readTx('datasetsWithLevel', async (trx) => {
        const column =
          level === 'LAU'
            ? sql`c.has_lau`
            : level === 'NUTS3'
              ? sql`c.has_county`
              : level === 'NATIONAL'
                ? sql`c.has_national`
                : sql`c.has_region`;
        const res = await sql<{ dataset_code: string }>`
          select d.dataset_code ${datasetFrom}
          where publication.facts_ready and ${column} order by d.dataset_code`.execute(trx);
        return res.rows.map((r) => r.dataset_code);
      });
    },

    async listObservations(query) {
      return readTx('listObservations', async (trx) => {
        await assertDatasetsPublished(trx, [query.datasetCode]);
        const parts: RawBuilder<unknown>[] = [sql`o.dataset_code = ${query.datasetCode}`];
        if (query.pinGroups.length > 0) {
          parts.push(
            sql`(${sql.join(
              query.pinGroups.map((g) => pinGroupSql(query.datasetCode, g)),
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
        const { views } = await hydrate(trx, query.datasetCode, rows);
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

    async latestForSeries(series, perSeries, period) {
      if (series.length === 0) return ok([]);
      const periodParts: RawBuilder<unknown>[] = [];
      if (period?.periodStart !== undefined)
        periodParts.push(sql`o.period_end >= ${period.periodStart}::date`);
      if (period?.periodEnd !== undefined)
        periodParts.push(sql`o.period_start <= ${period.periodEnd}::date`);
      if (period?.periodicities !== undefined && period.periodicities.length > 0) {
        periodParts.push(
          sql`pe.periodicity in (${sql.join(period.periodicities.map((p) => sql`${p}`))})`
        );
      }
      if (period?.periodRanges !== undefined && period.periodRanges.length > 0) {
        periodParts.push(
          sql`(${sql.join(
            period.periodRanges.map(
              (r) => sql`(o.period_end >= ${r.start}::date and o.period_start <= ${r.end}::date)`
            ),
            sql` or `
          )})`
        );
      }
      const periodSql = periodParts.length === 0 ? sql`true` : sql.join(periodParts, sql` and `);
      return readTx('latestForSeries', async (trx) => {
        await assertDatasetsPublished(
          trx,
          series.map((s) => s.datasetCode)
        );
        const out: InsSeriesRow[] = [];
        for (let i = 0; i < series.length; i += SERIES_PER_STATEMENT) {
          const chunk = series.slice(i, i + SERIES_PER_STATEMENT);
          const branches = chunk.map((s) => {
            const slotParts = Array.from({ length: MAX_SLOTS }, (_, idx) => {
              const id = s.slots[idx] ?? null;
              return id === null
                ? sql`${slotColumn(idx + 1)} is null`
                : sql`${slotColumn(idx + 1)} = ${id}`;
            });
            return sql`(select ${sql`${s.key}`}::text as series_key, ${factSelect}
              from ins.observations o
              join ins.periods pe on pe.period_id = o.period_id
              where o.dataset_code = ${s.datasetCode}
                and ${sql.join(slotParts, sql` and `)}
                and o.unit_nom_item_id = ${s.unitNomItemId}
                and ${periodSql}
              ${factOrder}
              limit ${perSeries})`;
          });
          const res = await sql<FactRow>`${sql.join(branches, sql` union all `)}`.execute(trx);
          const byDataset = new Map<string, FactRow[]>();
          for (const r of res.rows) {
            const list = byDataset.get(r.dataset_code) ?? [];
            list.push(r);
            byDataset.set(r.dataset_code, list);
          }
          for (const [datasetCode, rows] of byDataset) {
            const { views, keys } = await hydrate(trx, datasetCode, rows);
            views.forEach((observation, idx) =>
              out.push({ seriesKey: keys[idx] ?? '', observation })
            );
          }
        }
        return out;
      });
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

/** Exported for the plan/EXPLAIN tests: the fact predicate a query compiles to. */
export const factPredicateSql = (query: InsFactQuery): RawBuilder<unknown> =>
  sql`o.dataset_code = ${query.datasetCode} and (${sql.join(
    query.pinGroups.map((g) => pinGroupSql(query.datasetCode, g)),
    sql` or `
  )})`;

export type { InsSeriesSpec };
