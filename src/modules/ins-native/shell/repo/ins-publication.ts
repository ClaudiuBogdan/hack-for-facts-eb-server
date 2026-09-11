/**
 * Native INS repository — the PUBLICATION reads (codebase plan §WP5): the
 * dataset catalog over the publication relation, its dimensions, members,
 * units, periods and default pins, and the context tree. Every read runs
 * through the repository's runner (one repeatable-read snapshot per read, or
 * the enclosing one). Moved out of `ins-repo.ts` unchanged, together with the
 * row → view mappers the series reads share.
 */
import { sql, type RawBuilder } from 'kysely';
import { ok } from 'neverthrow';

import { datasetPeriodicities, datasetPublicationFrom } from './publication.js';
import { type Runner, type Trx } from './snapshot.js';
import { toNode } from './territory.js';
import { escapeLike, foldSearch } from '../../core/fold.js';
import {
  type InsContext,
  type InsDataStatus,
  type InsDatasetFilter,
  type InsDatasetView,
  type InsDimensionRole,
  type InsDimensionView,
  type InsMemberRole,
  type InsMemberView,
  type InsPage,
  type InsPeriodView,
  type InsPeriodicity,
  type InsUnitKind,
  type InsUnitView,
} from '../../core/types.js';

import type { InsDefaultPin, InsRepo } from '../../core/ports.js';

/**
 * A date column as `YYYY-MM-DD`. The kernel pool returns dates as wire strings
 * (pool.ts); a plain pg pool returns JS Dates (local-midnight), which would
 * shift a day under toISOString — so a Date is formatted by its LOCAL fields.
 */
export const isoDate = (v: unknown): string | null => {
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
export const isoTimestamp = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  return v instanceof Date ? v.toISOString() : null;
};

export interface DatasetRow {
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

export const toDataset = (r: DatasetRow): InsDatasetView => {
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

export const datasetSelect = sql`
  d.dataset_code, d.matrix_name_ro, d.matrix_name_en, d.periodicities, d.dimension_count,
  d.classification_dim_count, d.time_dim_index, d.unit_dim_index, d.ultima_actualizare_date,
  d.context_code, d.context_path, d.pivot_custody_sha256, d.source_url,
  publication.facts_ready, publication.not_loaded, r.revision_id, r.transform_contract_sha256, r.applied_at,
  c.observation_count, c.first_period_start, c.last_period_end, c.periodicities_observed,
  c.has_lau, c.has_county, c.has_region, c.has_national, c.definition_ro, c.definition_en,
  c.methodology_ro, c.data_sources_ro, c.source_year_start, c.source_year_end,
  c.source_last_update, c.computed_at, ctx.name_ro as context_name_ro, ctx.name_en as context_name_en`;

export const datasetFrom = datasetPublicationFrom();

export interface MemberRow {
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

export const toMember = (r: MemberRow): InsMemberView => ({
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

export const memberSelect = sql`
  m.dataset_code, m.dim_index, dd.label_ro as dim_label_ro, dd.label_en as dim_label_en,
  m.nom_item_id, m.ordinal, m.member_role, m.label_override,
  m.parent_nom_item_id, n.label_ro, n.label_en, mt.resolution as territory_resolution,
  t.territory_id, t.code, t.siruta_code, t.level, t.name_ro, t.parent_id, t.core_territory_id,
  p.code as parent_code, p.name_ro as parent_name_ro`;

export const memberFrom = sql`
  from ins.dataset_dimension_members m
  join ins.dataset_dimensions dd on dd.dataset_code = m.dataset_code and dd.dim_index = m.dim_index
  join ins.nomenclature_items n on n.nom_item_id = m.nom_item_id
  left join ins.member_territory mt
    on mt.dataset_code = m.dataset_code and mt.dim_index = m.dim_index and mt.nom_item_id = m.nom_item_id
  left join ins.territory_nodes t on t.territory_id = mt.territory_id
  left join ins.territory_nodes p on p.territory_id = t.parent_id`;

export interface UnitRow {
  dataset_code: string;
  unit_nom_item_id: number;
  unit_label_ro: string;
  label_en: string | null;
  base_unit: string | null;
  scale_factor: string;
  unit_kind: string;
  regime: string | null;
}

export const toUnit = (r: UnitRow): InsUnitView => ({
  nomItemId: r.unit_nom_item_id,
  labelRo: r.unit_label_ro,
  labelEn: r.label_en,
  baseUnit: r.base_unit,
  scaleFactor: r.scale_factor,
  unitKind: r.unit_kind as InsUnitKind,
  currencyRegime:
    r.regime === null || r.regime === 'UNKNOWN' || r.regime === 'MIXED_EVIDENCE' ? null : r.regime,
});

export const unitsSql = (datasetCodes: readonly string[]): RawBuilder<UnitRow> => sql<UnitRow>`
  select ms.dataset_code, ms.unit_nom_item_id, ms.unit_label_ro, n.label_en, ms.base_unit, ms.scale_factor,
         ms.unit_kind, cr.regime
  from ins.measures ms
  join ins.nomenclature_items n on n.nom_item_id = ms.unit_nom_item_id
  left join ins.currency_regimes cr
    on cr.dataset_code = ms.dataset_code and cr.unit_nom_item_id = ms.unit_nom_item_id
  where ms.dataset_code = any(${datasetCodes}::text[])
  order by ms.dataset_code, ms.unit_nom_item_id`;

export const likeNeedle = (needle: string): string => `%${escapeLike(foldSearch(needle))}%`;

export const page = <T>(
  rows: readonly T[],
  total: number,
  limit: number,
  offset: number
): InsPage<T> => ({
  nodes: rows.slice(0, limit),
  totalCount: total,
  hasNextPage: offset + limit < total,
  hasPreviousPage: offset > 0,
});

export const makePublicationReads = (readTx: Runner) => {
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

  async function countDatasets(trx: Trx, filter: InsDatasetFilter): Promise<number> {
    const res = await sql<{
      n: string;
    }>`select count(*)::text as n ${datasetFrom} where ${datasetWhere(filter)}`.execute(trx);
    return Number(res.rows[0]?.n ?? 0);
  }

  const repository: Pick<
    InsRepo,
    | 'listDatasets'
    | 'getDataset'
    | 'getDatasets'
    | 'listDimensions'
    | 'dimensionsForDatasets'
    | 'listMembers'
    | 'membersByIds'
    | 'membersForDatasets'
    | 'listUnits'
    | 'periodsByLabels'
    | 'listContexts'
    | 'totalMember'
    | 'defaultPins'
  > = {
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
  };

  return repository;
};
