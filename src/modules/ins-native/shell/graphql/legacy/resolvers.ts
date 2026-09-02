/**
 * The legacy INS roots on the kernel — thin resolvers (13 §3 rule 2): legacy
 * args → the module's typed inputs → the usecase → the legacy result shape.
 * No SQL here; every identifier resolution lives in `core/usecases.ts`.
 *
 * Wire mapping decisions (declared golden-master deltas, plan §3.4):
 *  - `InsClassificationValue.type_code` = `D<dimIndex>`, `code` = nomItemId;
 *  - `InsObservation.id` = the observation ref (design §5), `InsTerritory.id` =
 *    the INS spine id, `InsDataset.id` = the dataset code;
 *  - `pageInfo.totalCount` = -1 when a fact page was read with limit+1 and is
 *    full (decision D7); exact on catalogs;
 *  - `matchStrategy` never emits `REPRESENTATIVE_FALLBACK` (decision D2);
 *  - `sync_status` is derived: SYNCED when facts are served, PENDING otherwise;
 *  - dates are the kernel scalars' wire strings (`YYYY-MM-DD`, ISO timestamps).
 */

import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, type ApiError } from '@/modules/shared/index.js';

import {
  dimensionCode,
  isoPeriodToken,
  memberCode,
  observationRef,
  periodParts,
} from '../../../core/identity.js';
import {
  getDataset,
  listContexts,
  listDatasets,
  listDimensionValues,
  listDimensions,
  listLatestValues,
  listObservations,
  listTerritories,
  uatDashboard,
} from '../../../core/usecases.js';

import type { InsRepo } from '../../../core/ports.js';
import type {
  InsContext,
  InsContextFilter,
  InsDashboardGroup,
  InsDataStatus,
  InsDatasetFilter,
  InsDatasetView,
  InsDimensionView,
  InsEntitySelector,
  InsLatestValue,
  InsMemberView,
  InsObservationFilter,
  InsObservationView,
  InsPage,
  InsPeriodFilter,
  InsPeriodView,
  InsPeriodicity,
  InsTerritoryFilter,
  InsTerritoryLevel,
  InsTerritoryNode,
  InsUnitView,
} from '../../../core/types.js';

export interface InsLegacyResolverDeps {
  readonly repo: InsRepo;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: {
      code: GRAPHQL_ERROR_CODE[error.type],
      type: error.type,
      ...(error.type === 'InvalidInput' && error.field !== undefined && { field: error.field }),
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL input shapes (as the frozen SDL declares them)
// ─────────────────────────────────────────────────────────────────────────────

interface GqlDatasetFilter {
  search?: string | null;
  codes?: string[] | null;
  contextCode?: string | null;
  rootContextCode?: string | null;
  periodicity?: InsPeriodicity[] | null;
  syncStatus?: string[] | null;
  dataStatus?: InsDataStatus[] | null;
  hasUatData?: boolean | null;
  hasCountyData?: boolean | null;
}

interface GqlContextFilter {
  search?: string | null;
  level?: number | null;
  parentCode?: string | null;
  rootContextCode?: string | null;
}

interface GqlTerritoryFilter {
  search?: string | null;
  levels?: InsTerritoryLevel[] | null;
  parentCode?: string | null;
  sirutaCodes?: string[] | null;
}

interface GqlPeriodSelection {
  interval?: { start: string; end: string } | null;
  dates?: string[] | null;
}

interface GqlReportPeriodInput {
  type: 'YEAR' | 'QUARTER' | 'MONTH';
  selection: GqlPeriodSelection;
}

interface GqlObservationFilter {
  territoryCodes?: string[] | null;
  sirutaCodes?: string[] | null;
  territoryLevels?: InsTerritoryLevel[] | null;
  unitCodes?: string[] | null;
  classificationValueCodes?: string[] | null;
  classificationTypeCodes?: string[] | null;
  period?: GqlReportPeriodInput | null;
  hasValue?: boolean | null;
}

interface GqlEntitySelector {
  sirutaCode?: string | null;
  territoryCode?: string | null;
  territoryLevel?: InsTerritoryLevel | null;
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

/** Copy the non-null GraphQL inputs onto a mutable partial of the module filter (exactOptionalPropertyTypes-safe). */
const put = <O extends object, K extends keyof O>(
  target: O,
  key: K,
  value: O[K] | null | undefined
): void => {
  if (value !== null && value !== undefined) target[key] = value;
};

type Mutable<T> = { -readonly [K in keyof T]?: T[K] };

const mapDatasetFilter = (input: GqlDatasetFilter | null | undefined): InsDatasetFilter => {
  const f: Mutable<InsDatasetFilter> = {};
  put(f, 'search', input?.search);
  put(f, 'codes', input?.codes);
  put(f, 'contextCode', input?.contextCode);
  put(f, 'rootContextCode', input?.rootContextCode);
  put(f, 'periodicities', input?.periodicity);
  put(f, 'dataStatus', input?.dataStatus);
  put(f, 'hasUatData', input?.hasUatData);
  put(f, 'hasCountyData', input?.hasCountyData);
  return f;
};

const mapContextFilter = (input: GqlContextFilter | null | undefined): InsContextFilter => {
  const f: Mutable<InsContextFilter> = {};
  put(f, 'search', input?.search);
  put(f, 'level', input?.level);
  put(f, 'parentCode', input?.parentCode);
  put(f, 'rootContextCode', input?.rootContextCode);
  return f;
};

const mapTerritoryFilter = (input: GqlTerritoryFilter | null | undefined): InsTerritoryFilter => {
  const f: Mutable<InsTerritoryFilter> = {};
  put(f, 'search', input?.search);
  put(f, 'levels', input?.levels);
  put(f, 'parentCode', input?.parentCode);
  put(f, 'sirutaCodes', input?.sirutaCodes);
  return f;
};

const PERIOD_TYPE: Record<GqlReportPeriodInput['type'], 'ANNUAL' | 'QUARTERLY' | 'MONTHLY'> = {
  YEAR: 'ANNUAL',
  QUARTER: 'QUARTERLY',
  MONTH: 'MONTHLY',
};

/** `ReportPeriodInput` (object form) → the module's period filter. */
export const mapReportPeriod = (
  input: GqlReportPeriodInput | null | undefined
): InsPeriodFilter | undefined => {
  if (input === null || input === undefined) return undefined;
  const periodicity = PERIOD_TYPE[input.type];
  const dates = opt(input.selection.dates);
  if (dates !== undefined && dates.length > 0) return { periodicity, tokens: dates };
  const interval = opt(input.selection.interval);
  if (interval !== undefined) return { periodicity, start: interval.start, end: interval.end };
  return { periodicity };
};

const mapObservationFilter = (
  input: GqlObservationFilter | null | undefined
): InsObservationFilter => {
  const f: Mutable<InsObservationFilter> = {};
  put(f, 'territoryCodes', input?.territoryCodes);
  put(f, 'sirutaCodes', input?.sirutaCodes);
  put(f, 'territoryLevels', input?.territoryLevels);
  put(f, 'unitCodes', input?.unitCodes);
  put(f, 'classificationValueCodes', input?.classificationValueCodes);
  put(f, 'classificationTypeCodes', input?.classificationTypeCodes);
  put(f, 'period', mapReportPeriod(input?.period));
  put(f, 'hasValue', input?.hasValue);
  return f;
};

const mapEntity = (input: GqlEntitySelector): InsEntitySelector => {
  const f: Mutable<InsEntitySelector> = {};
  put(f, 'sirutaCode', input.sirutaCode);
  put(f, 'territoryCode', input.territoryCode);
  put(f, 'territoryLevel', input.territoryLevel);
  return f;
};

// ─────────────────────────────────────────────────────────────────────────────
// View → legacy wire shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface GqlPageInfo {
  readonly totalCount: number;
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly startCursor: null;
}

const toPageInfo = (p: InsPage<unknown>): GqlPageInfo => ({
  totalCount: p.totalCount ?? -1,
  hasNextPage: p.hasNextPage,
  hasPreviousPage: p.hasPreviousPage,
  startCursor: null,
});

export interface GqlTerritory {
  readonly id: string;
  readonly code: string;
  readonly siruta_code: string | null;
  readonly level: InsTerritoryLevel;
  readonly name_ro: string;
  readonly path: null;
  readonly parent_id: number | null;
  readonly parent_code: string | null;
  readonly parent_name_ro: string | null;
}

export const toGqlTerritory = (n: InsTerritoryNode): GqlTerritory => ({
  id: String(n.territoryId),
  code: n.code,
  siruta_code: n.sirutaCode,
  level: n.level,
  name_ro: n.nameRo,
  path: null,
  parent_id: n.parentId,
  parent_code: n.parentCode,
  parent_name_ro: n.parentNameRo,
});

export interface GqlTimePeriod {
  readonly id: string;
  readonly year: number;
  readonly quarter: number | null;
  readonly month: number | null;
  readonly periodicity: InsPeriodicity;
  readonly period_start: string;
  readonly period_end: string;
  readonly label_ro: string;
  readonly label_en: null;
  readonly iso_period: string;
}

export const toGqlTimePeriod = (p: InsPeriodView): GqlTimePeriod => ({
  id: String(p.periodId),
  ...periodParts(p.periodicity, p.periodStart),
  periodicity: p.periodicity,
  period_start: p.periodStart,
  period_end: p.periodEnd,
  label_ro: p.labelRo,
  label_en: null,
  iso_period: isoPeriodToken(p.periodicity, p.periodStart),
});

export interface GqlUnit {
  readonly id: string;
  readonly code: string;
  readonly symbol: string | null;
  readonly name_ro: string;
  readonly name_en: string | null;
}

export const toGqlUnit = (u: InsUnitView): GqlUnit => ({
  id: String(u.nomItemId),
  code: memberCode(u.nomItemId),
  symbol: u.baseUnit ?? u.labelRo,
  name_ro: u.labelRo,
  name_en: u.labelEn,
});

export interface GqlClassificationValue {
  readonly id: string;
  readonly type_id: number;
  readonly type_code: string;
  readonly type_name_ro: string | null;
  readonly type_name_en: string | null;
  readonly code: string;
  readonly name_ro: string;
  readonly name_en: string | null;
  readonly level: null;
  readonly parent_id: number | null;
  readonly sort_order: number | null;
}

const toGqlClassificationValue = (
  m: InsMemberView,
  dim: { labelRo: string; labelEn: string | null } | undefined
): GqlClassificationValue => ({
  id: `${m.datasetCode}:${dimensionCode(m.dimIndex)}:${memberCode(m.nomItemId)}`,
  type_id: m.dimIndex,
  type_code: dimensionCode(m.dimIndex),
  type_name_ro: dim?.labelRo ?? null,
  type_name_en: dim?.labelEn ?? null,
  code: memberCode(m.nomItemId),
  name_ro: m.labelRo,
  name_en: m.labelEn,
  level: null,
  parent_id: m.parentNomItemId,
  sort_order: m.ordinal,
});

export interface GqlDataset {
  readonly id: string;
  readonly code: string;
  readonly name_ro: string;
  readonly name_en: string | null;
  readonly definition_ro: string | null;
  readonly definition_en: string | null;
  readonly periodicity: readonly InsPeriodicity[];
  readonly year_range: readonly [number, number] | null;
  readonly dimension_count: number;
  readonly has_uat_data: boolean;
  readonly has_county_data: boolean;
  readonly has_siruta: boolean;
  readonly sync_status: 'SYNCED' | 'PENDING';
  readonly data_status: InsDataStatus;
  readonly last_sync_at: string | null;
  readonly context_code: string | null;
  readonly context_name_ro: string | null;
  readonly context_name_en: string | null;
  readonly context_path: string | null;
  readonly metadata: Record<string, unknown>;
}

export const toGqlDataset = (d: InsDatasetView): GqlDataset => ({
  id: d.code,
  code: d.code,
  name_ro: d.nameRo,
  name_en: d.nameEn,
  definition_ro: d.definitionRo,
  definition_en: d.definitionEn,
  periodicity: d.periodicities,
  year_range: d.yearRange,
  dimension_count: d.dimensionCount,
  has_uat_data: d.hasLau,
  has_county_data: d.hasCounty,
  has_siruta: d.hasLau,
  sync_status: d.dataStatus === 'AVAILABLE' ? 'SYNCED' : 'PENDING',
  data_status: d.dataStatus,
  last_sync_at: toIsoTimestamp(d.computedAt),
  context_code: d.contextCode,
  context_name_ro: d.contextNameRo,
  context_name_en: d.contextNameEn,
  context_path: d.contextPath,
  metadata: {
    methodology_ro: d.methodologyRo,
    data_sources_ro: d.dataSourcesRo,
    source_year_range: d.sourceYearRange,
    source_last_update: d.sourceLastUpdate,
    observation_count: d.observationCount,
    has_region_data: d.hasRegion,
    has_national_data: d.hasNational,
    custody_sha256: d.custodySha256,
    source_url: d.sourceUrl,
  },
});

export interface GqlObservation {
  readonly id: string;
  readonly dataset_code: string;
  readonly territory: GqlTerritory | null;
  readonly time_period: GqlTimePeriod;
  readonly unit: GqlUnit;
  readonly value: string | null;
  readonly value_status: string | null;
  readonly classifications: readonly GqlClassificationValue[];
  readonly dimensions: Record<string, unknown>;
}

const toGqlObservation = (
  o: InsObservationView,
  k: number,
  dims: ReadonlyMap<number, InsDimensionView>
): GqlObservation => ({
  id: observationRef(o.coordinate, k),
  dataset_code: o.coordinate.datasetCode,
  territory: o.territory === null ? null : toGqlTerritory(o.territory),
  time_period: toGqlTimePeriod(o.period),
  unit: toGqlUnit(o.unit),
  value: o.value,
  value_status: o.valueStatus,
  classifications: o.members.map((m) => toGqlClassificationValue(m, dims.get(m.dimIndex))),
  // The legacy `dimensions` JSON shape, kept: territory/period/unit keys plus
  // the classification map (now keyed by D<n> with member codes).
  dimensions: {
    ...(o.territory !== null && { territory_code: o.territory.code }),
    ...(o.territory?.sirutaCode !== null &&
      o.territory?.sirutaCode !== undefined && {
        siruta_code: o.territory.sirutaCode,
      }),
    period: isoPeriodToken(o.period.periodicity, o.period.periodStart),
    unit_code: memberCode(o.unit.nomItemId),
    ...(o.members.length > 0 && {
      classifications: Object.fromEntries(
        o.members.map((m) => [dimensionCode(m.dimIndex), memberCode(m.nomItemId)])
      ),
    }),
  },
});

export interface GqlContext {
  readonly id: string;
  readonly code: string;
  readonly name_ro: string;
  readonly name_en: string | null;
  readonly name_ro_markdown: null;
  readonly name_en_markdown: null;
  readonly level: number;
  readonly parent_id: null;
  readonly parent_code: string | null;
  readonly path: string;
  readonly matrix_count: number;
}

const toGqlContext = (c: InsContext): GqlContext => ({
  id: c.code,
  code: c.code,
  name_ro: c.nameRo,
  name_en: c.nameEn,
  name_ro_markdown: null,
  name_en_markdown: null,
  level: c.level,
  parent_id: null,
  parent_code: c.parentCode,
  path: c.path,
  matrix_count: c.datasetCount,
});

type GqlDimensionType = 'TEMPORAL' | 'TERRITORIAL' | 'CLASSIFICATION' | 'UNIT_OF_MEASURE';

const dimensionType = (d: InsDimensionView): GqlDimensionType => {
  if (d.role === 'time') return 'TEMPORAL';
  if (d.role === 'unit') return 'UNIT_OF_MEASURE';
  return d.isTerritorial ? 'TERRITORIAL' : 'CLASSIFICATION';
};

interface GqlDimension {
  readonly index: number;
  readonly type: GqlDimensionType;
  readonly label_ro: string;
  readonly label_en: string | null;
  readonly classification_type: {
    readonly id: string;
    readonly code: string;
    readonly name_ro: string;
    readonly name_en: string | null;
    readonly is_hierarchical: boolean;
    readonly value_count: number;
  } | null;
  readonly is_hierarchical: boolean;
  readonly option_count: number;
  /** Carried for the nested `values` resolver, not a wire field. */
  readonly dimensionView: InsDimensionView;
}

const toGqlDimension = (d: InsDimensionView): GqlDimension => ({
  index: d.dimIndex,
  type: dimensionType(d),
  label_ro: d.labelRo,
  label_en: d.labelEn,
  classification_type:
    d.role === 'classification'
      ? {
          id: `${d.datasetCode}:${dimensionCode(d.dimIndex)}`,
          code: dimensionCode(d.dimIndex),
          name_ro: d.labelRo,
          name_en: d.labelEn,
          is_hierarchical: d.parentDimIndex !== null,
          value_count: d.optionCount,
        }
      : null,
  is_hierarchical: d.parentDimIndex !== null,
  option_count: d.optionCount,
  dimensionView: d,
});

/** The pool returns timestamptz as `YYYY-MM-DD HH:MM:SS[.ffffff]+00`; the legacy wire was ISO. */
const toIsoTimestamp = (v: string | null): string | null => {
  if (v === null) return null;
  const d = new Date(v.includes('T') ? v : v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

const latestPeriodOf = (o: InsObservationView | null): string | null =>
  o === null ? null : isoPeriodToken(o.period.periodicity, o.period.periodStart);

// ─────────────────────────────────────────────────────────────────────────────
// Resolver map
// ─────────────────────────────────────────────────────────────────────────────

export const makeInsLegacyResolvers = (deps: InsLegacyResolverDeps): Record<string, unknown> => {
  const { repo } = deps;

  const dimensionsFor = async (datasetCode: string): Promise<GqlDimension[]> => {
    const dims = await listDimensions(repo, datasetCode);
    if (dims.isErr()) throw toGraphqlError(dims.error);
    return dims.value.map(toGqlDimension);
  };

  const observationsPage = async (
    datasetCode: string,
    page: InsPage<InsObservationView>
  ): Promise<{ nodes: GqlObservation[]; pageInfo: GqlPageInfo }> => {
    const dims = await listDimensions(repo, datasetCode);
    if (dims.isErr()) throw toGraphqlError(dims.error);
    const byIndex = new Map(dims.value.map((d) => [d.dimIndex, d]));
    const k = dims.value.filter((d) => d.role === 'classification').length;
    return {
      nodes: page.nodes.map((o) => toGqlObservation(o, k, byIndex)),
      pageInfo: toPageInfo(page),
    };
  };

  const dimensionValues = async (
    view: InsDimensionView,
    args: {
      filter?: { search?: string | null } | null;
      limit?: number | null;
      offset?: number | null;
    }
  ) => {
    const page = await listDimensionValues(
      repo,
      view.datasetCode,
      view.dimIndex,
      opt(args.filter?.search),
      opt(args.limit),
      opt(args.offset)
    );
    if (page.isErr()) throw toGraphqlError(page.error);
    const type = dimensionType(view);
    let periodByLabel = new Map<string, InsPeriodView>();
    if (view.role === 'time') {
      const periods = await repo.periodsByLabels(page.value.nodes.map((m) => m.labelRo));
      if (periods.isErr()) throw toGraphqlError(periods.error);
      periodByLabel = new Map(periods.value.map((p) => [p.labelRo, p]));
    }
    let unitById = new Map<number, InsUnitView>();
    if (view.role === 'unit') {
      const units = await repo.listUnits(view.datasetCode);
      if (units.isErr()) throw toGraphqlError(units.error);
      unitById = new Map(units.value.map((u) => [u.nomItemId, u]));
    }
    return {
      nodes: page.value.nodes.map((m) => {
        const period = periodByLabel.get(m.labelRo);
        const unit = unitById.get(m.nomItemId);
        return {
          nom_item_id: m.nomItemId,
          dimension_type: type,
          label_ro: m.labelRo,
          label_en: m.labelEn,
          parent_nom_item_id: m.parentNomItemId,
          offset_order: m.ordinal ?? 0,
          territory: m.territory === null ? null : toGqlTerritory(m.territory),
          time_period: period === undefined ? null : toGqlTimePeriod(period),
          classification_value:
            view.role === 'classification' ? toGqlClassificationValue(m, view) : null,
          unit: unit === undefined ? null : toGqlUnit(unit),
        };
      }),
      pageInfo: toPageInfo(page.value),
    };
  };

  const latestValue = async (v: InsLatestValue) => ({
    dataset: toGqlDataset(v.dataset),
    observation:
      v.observation === null
        ? null
        : ((
            await observationsPage(v.dataset.code, {
              nodes: [v.observation],
              totalCount: 1,
              hasNextPage: false,
              hasPreviousPage: false,
            })
          ).nodes[0] ?? null),
    latestPeriod: latestPeriodOf(v.observation),
    matchStrategy: v.matchStrategy,
    hasData: v.observation !== null,
  });

  const dashboardGroup = async (g: InsDashboardGroup) => {
    const page = await observationsPage(g.dataset.code, {
      nodes: g.observations,
      totalCount: g.observations.length,
      hasNextPage: g.truncated,
      hasPreviousPage: false,
    });
    return {
      dataset: toGqlDataset(g.dataset),
      observations: page.nodes,
      latestPeriod: latestPeriodOf(g.observations[0] ?? null),
    };
  };

  return {
    InsDataset: {
      dimensions: (parent: GqlDataset) => dimensionsFor(parent.code),
    },
    InsDimension: {
      values: (parent: GqlDimension, args: Parameters<typeof dimensionValues>[1]) =>
        dimensionValues(parent.dimensionView, args),
    },
    Query: {
      insDatasets: async (
        _p: unknown,
        args: { filter?: GqlDatasetFilter | null; limit?: number | null; offset?: number | null }
      ) => {
        const page = await listDatasets(
          repo,
          mapDatasetFilter(args.filter),
          opt(args.limit),
          opt(args.offset)
        );
        if (page.isErr()) throw toGraphqlError(page.error);
        return { nodes: page.value.nodes.map(toGqlDataset), pageInfo: toPageInfo(page.value) };
      },
      insDataset: async (_p: unknown, args: { code: string }) => {
        const d = await getDataset(repo, args.code);
        if (d.isErr()) throw toGraphqlError(d.error);
        return d.value === null ? null : toGqlDataset(d.value);
      },
      insDatasetDimensionValues: async (
        _p: unknown,
        args: {
          datasetCode: string;
          dimensionIndex: number;
          filter?: { search?: string | null } | null;
          limit?: number | null;
          offset?: number | null;
        }
      ) => {
        const dims = await listDimensions(repo, args.datasetCode.trim().toUpperCase());
        if (dims.isErr()) throw toGraphqlError(dims.error);
        const view = dims.value.find((d) => d.dimIndex === args.dimensionIndex);
        if (view === undefined) {
          throw toGraphqlError({
            type: 'NotFound',
            message: `dimension ${String(args.dimensionIndex)} of ${args.datasetCode} not found`,
            resource: 'insDatasetDimensionValues',
          });
        }
        return dimensionValues(view, args);
      },
      insTerritories: async (
        _p: unknown,
        args: { filter?: GqlTerritoryFilter | null; limit?: number | null; offset?: number | null }
      ) => {
        const page = await listTerritories(
          repo,
          mapTerritoryFilter(args.filter),
          opt(args.limit),
          opt(args.offset)
        );
        if (page.isErr()) throw toGraphqlError(page.error);
        return { nodes: page.value.nodes.map(toGqlTerritory), pageInfo: toPageInfo(page.value) };
      },
      insContexts: async (
        _p: unknown,
        args: { filter?: GqlContextFilter | null; limit?: number | null; offset?: number | null }
      ) => {
        const page = await listContexts(
          repo,
          mapContextFilter(args.filter),
          opt(args.limit),
          opt(args.offset)
        );
        if (page.isErr()) throw toGraphqlError(page.error);
        return { nodes: page.value.nodes.map(toGqlContext), pageInfo: toPageInfo(page.value) };
      },
      insObservations: async (
        _p: unknown,
        args: {
          datasetCode: string;
          filter?: GqlObservationFilter | null;
          limit?: number | null;
          offset?: number | null;
        }
      ) => {
        const page = await listObservations(
          repo,
          args.datasetCode,
          mapObservationFilter(args.filter),
          opt(args.limit),
          opt(args.offset)
        );
        if (page.isErr()) throw toGraphqlError(page.error);
        return observationsPage(args.datasetCode.trim().toUpperCase(), page.value);
      },
      insUatDashboard: async (
        _p: unknown,
        args: { sirutaCode: string; period?: string | null; contextCode?: string | null }
      ) => {
        const period = opt(args.period);
        const groups = await uatDashboard(
          repo,
          args.sirutaCode,
          opt(args.contextCode),
          period === undefined ? undefined : { tokens: [period] }
        );
        if (groups.isErr()) throw toGraphqlError(groups.error);
        return Promise.all(groups.value.map(dashboardGroup));
      },
      insLatestDatasetValues: async (
        _p: unknown,
        args: {
          entity: GqlEntitySelector;
          datasetCodes: string[];
          preferredClassificationCodes?: string[] | null;
        }
      ) => {
        const values = await listLatestValues(
          repo,
          mapEntity(args.entity),
          args.datasetCodes,
          opt(args.preferredClassificationCodes) ?? []
        );
        if (values.isErr()) throw toGraphqlError(values.error);
        return Promise.all(values.value.map(latestValue));
      },
    },
  };
};
