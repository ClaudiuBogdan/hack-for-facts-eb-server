/**
 * Entity Module GraphQL Resolvers
 *
 * Implements Query and Entity type resolvers.
 * UAT and Report Query resolvers are now in separate modules.
 */

import { Decimal } from 'decimal.js';

import { clampLimit, MAX_PAGE_SIZE } from '@/common/constants/pagination.js';
import { Frequency } from '@/common/types/temporal.js';
import {
  resolveNormalizationRequest,
  type DataPoint,
  type GqlNormalization,
  type NormalizationService,
  type ResolvedNormalizationRequest,
} from '@/modules/normalization/index.js';

import {
  DEFAULT_LIMIT,
  type DbReportType,
  type Entity,
  type EntityFilter,
  type GqlReportType,
  type ReportPeriodInput,
} from '../../core/types.js';
import { getEntity } from '../../core/usecases/get-entity.js';
import { listEntities } from '../../core/usecases/list-entities.js';

import type { EntityAnalyticsSummaryRepository, EntityRepository } from '../../core/ports.js';
import type {
  AnalyticsFilter,
  Currency,
  PeriodSelection,
  PeriodType,
} from '@/common/types/analytics.js';
import type {
  ExecutionLineItem,
  ExecutionLineItemRepository as ExecutionLineItemsModuleRepository,
  SortableField,
} from '@/modules/execution-line-items/index.js';
import type { ReportFilter, ReportRepository, ReportSort } from '@/modules/report/index.js';
import type { UATRepository } from '@/modules/uat/index.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ─────────────────────────────────────────────────────────────────────────────
// Constants (imported from respective modules)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_REPORT_LIMIT = 10;
const DEFAULT_ELI_LIMIT = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Normalization Type (matches GraphQL enum Normalization)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Input Types
// ─────────────────────────────────────────────────────────────────────────────

interface GqlReportPeriodInput {
  type: PeriodType;
  selection: {
    interval?: { start: string; end: string };
    dates?: string[];
  };
}

interface GqlSortOrder {
  by: string;
  order: string;
}

interface GqlEntityFilter {
  cui?: string;
  cuis?: string[];
  name?: string;
  entity_type?: string;
  uat_id?: number;
  address?: string;
  search?: string;
  is_uat?: boolean;
  parents?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Type Mapping
// ─────────────────────────────────────────────────────────────────────────────

/** Map GraphQL ReportType to DB value */
const GQL_TO_DB_REPORT_TYPE_MAP: Record<GqlReportType, DbReportType> = {
  PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
  SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
  DETAILED: 'Executie bugetara detaliata',
};

/** Default report type used when entity doesn't have one set */
const DEFAULT_REPORT_TYPE: DbReportType = 'Executie bugetara detaliata';

/** Set of valid DB report type values for validation */
const VALID_DB_REPORT_TYPES = new Set<string>(Object.values(GQL_TO_DB_REPORT_TYPE_MAP));

// ─────────────────────────────────────────────────────────────────────────────
// Normalization Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the Y-axis unit string based on resolved normalization options.
 */
const getUnitForNormalization = (request: ResolvedNormalizationRequest): string => {
  if (request.showPeriodGrowth) {
    return '%';
  }

  if (request.normalization === 'percent_gdp') {
    return '% of GDP';
  }

  const realSuffix = request.inflationAdjusted ? ' (real 2024)' : '';
  const capitaSuffix = request.normalization === 'per_capita' ? '/capita' : '';
  return `${request.currency}${capitaSuffix}${realSuffix}`;
};

const getYAxisNameForNormalization = (request: ResolvedNormalizationRequest): string => {
  if (request.showPeriodGrowth) return 'Growth';
  if (request.normalization === 'percent_gdp') return 'Share of GDP';
  return 'Amount';
};

/**
 * Returns human-readable axis name for the frequency.
 */
const getAxisNameForFrequency = (frequency: Frequency): string => {
  switch (frequency) {
    case Frequency.YEAR:
      return 'Year';
    case Frequency.QUARTER:
      return 'Quarter';
    case Frequency.MONTH:
      return 'Month';
  }
};

/**
 * Extracts year range from ReportPeriodInput.
 */
const getYearRangeFromPeriod = (period: ReportPeriodInput): [number, number] => {
  const selection = period.selection;

  if (selection.interval !== undefined) {
    const startYear = Number.parseInt(selection.interval.start.substring(0, 4), 10);
    const endYear = Number.parseInt(selection.interval.end.substring(0, 4), 10);
    return [startYear, endYear];
  }

  // At this point, selection must have dates (due to discriminated union)
  const dates = selection.dates;
  if (dates.length > 0) {
    const years = dates.map((d) => Number.parseInt(d.substring(0, 4), 10));
    return [Math.min(...years), Math.max(...years)];
  }

  // Fallback to current year (empty dates array)
  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear];
};

/**
 * Picks a representative period label for totals.
 *
 * For single-period selections this is the exact label (YYYY / YYYY-QN / YYYY-MM).
 * For intervals or multiple dates, this picks the latest (end / max label).
 */
const getRepresentativePeriodLabel = (period: ReportPeriodInput): string => {
  const selection = period.selection;

  if (selection.interval !== undefined) {
    return selection.interval.end;
  }

  const dates = selection.dates;
  if (dates.length > 0) {
    return dates.reduce((max, curr) => (curr > max ? curr : max), dates[0] ?? '');
  }

  return String(new Date().getFullYear());
};

/**
 * Applies normalization to a single numeric value.
 */
const applyNormalizationToValue = async (
  value: number | null,
  request: ResolvedNormalizationRequest,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<number | null> => {
  if (value === null) return null;
  const requiresTransform =
    request.transformation.inflationAdjusted ||
    request.transformation.currency !== 'RON' ||
    request.transformation.normalization !== 'total' ||
    request.transformation.showPeriodGrowth === true;

  if (!requiresTransform && !request.requiresExternalPerCapitaDivision) {
    return value;
  }

  const [startYear, endYear] = getYearRangeFromPeriod(period);

  const periodLabel = getRepresentativePeriodLabel(period);
  const dataPoint: DataPoint = {
    x: periodLabel,
    year: Number.parseInt(periodLabel.substring(0, 4), 10),
    y: new Decimal(value),
  };

  const result = await normService.normalize([dataPoint], request.transformation, period.type, [
    startYear,
    endYear,
  ]);

  const normalizedPoint = result.isOk() ? result.value[0] : undefined;
  let normalizedValue = normalizedPoint !== undefined ? normalizedPoint.y : new Decimal(value);

  if (request.requiresExternalPerCapitaDivision && population !== null && population > 0) {
    normalizedValue = normalizedValue.div(new Decimal(population));
  }

  return normalizedValue.toNumber();
};

/**
 * Applies normalization to a data series.
 */
const applyNormalizationToSeries = async (
  data: { date: string; value: Decimal }[],
  request: ResolvedNormalizationRequest,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<{ x: string; y: number }[]> => {
  if (data.length === 0) return [];

  const [startYear, endYear] = getYearRangeFromPeriod(period);

  const requiresTransform =
    request.transformation.inflationAdjusted ||
    request.transformation.currency !== 'RON' ||
    request.transformation.normalization !== 'total' ||
    request.transformation.showPeriodGrowth === true;

  const dataPoints: DataPoint[] = data.map((point) => ({
    x: point.date,
    year: Number.parseInt(point.date.substring(0, 4), 10),
    y: point.value,
  }));

  if (!requiresTransform && !request.requiresExternalPerCapitaDivision) {
    return dataPoints.map((point) => ({
      x: point.x,
      y: point.y.toNumber(),
    }));
  }

  const result = await normService.normalize(dataPoints, request.transformation, period.type, [
    startYear,
    endYear,
  ]);

  let normalizedPoints = result.isOk() ? result.value : dataPoints;

  if (request.requiresExternalPerCapitaDivision && population !== null && population > 0) {
    const pop = new Decimal(population);
    normalizedPoints = normalizedPoints.map((p) => ({
      ...p,
      y: p.y.div(pop),
    }));
  }

  return normalizedPoints.map((point) => ({
    x: point.x,
    y: point.y.toNumber(),
  }));
};

/**
 * Normalized execution line item output type.
 */
interface NormalizedExecutionLineItem {
  line_item_id: string;
  report_id: string;
  entity_cui: string;
  funding_source_id: number;
  budget_sector_id: number;
  functional_code: string;
  economic_code: string | null;
  account_category: string;
  expense_type: string | null;
  program_code: string | null;
  year: number;
  month: number;
  quarter: number | null;
  ytd_amount: number;
  monthly_amount: number;
  quarterly_amount: number | null;
  anomaly: string | null;
}

/**
 * Applies normalization to execution line items.
 */
const applyNormalizationToLineItems = async (
  items: ExecutionLineItem[],
  request: ResolvedNormalizationRequest,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<NormalizedExecutionLineItem[]> => {
  if (items.length === 0) return [];

  const [startYear, endYear] = getYearRangeFromPeriod(period);

  const requiresTransform =
    request.transformation.inflationAdjusted ||
    request.transformation.currency !== 'RON' ||
    request.transformation.normalization !== 'total';

  const ytdPoints: DataPoint[] = items.map((item) => ({
    x: String(item.year),
    year: item.year,
    y: item.ytd_amount,
  }));

  const monthlyPoints: DataPoint[] = items.map((item) => ({
    x: `${String(item.year)}-${String(item.month).padStart(2, '0')}`,
    year: item.year,
    y: item.monthly_amount,
  }));

  const quarterlyEntries: { index: number; point: DataPoint }[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.quarterly_amount === null || item.quarter === null) continue;

    quarterlyEntries.push({
      index,
      point: {
        x: `${String(item.year)}-Q${String(item.quarter)}`,
        year: item.year,
        y: item.quarterly_amount,
      },
    });
  }

  const ytdResult = requiresTransform
    ? await normService.normalize(ytdPoints, request.transformation, Frequency.YEAR, [
        startYear,
        endYear,
      ])
    : null;
  const monthlyResult = requiresTransform
    ? await normService.normalize(monthlyPoints, request.transformation, Frequency.MONTH, [
        startYear,
        endYear,
      ])
    : null;

  const quarterlyPoints = quarterlyEntries.map((e) => e.point);
  const quarterlyResult = requiresTransform
    ? await normService.normalize(quarterlyPoints, request.transformation, Frequency.QUARTER, [
        startYear,
        endYear,
      ])
    : null;

  const pop =
    request.requiresExternalPerCapitaDivision && population !== null && population > 0
      ? new Decimal(population)
      : null;

  const ytdOut = ytdResult?.isOk() === true ? ytdResult.value : ytdPoints;
  const monthlyOut = monthlyResult?.isOk() === true ? monthlyResult.value : monthlyPoints;

  const quarterlyMap = new Map<number, Decimal>();
  if (quarterlyResult !== null) {
    const points = quarterlyResult.isOk() ? quarterlyResult.value : quarterlyPoints;
    for (let i = 0; i < quarterlyEntries.length; i++) {
      const entry = quarterlyEntries[i];
      const point = points[i];
      if (entry !== undefined && point !== undefined) {
        quarterlyMap.set(entry.index, point.y);
      }
    }
  } else {
    for (const entry of quarterlyEntries) {
      quarterlyMap.set(entry.index, entry.point.y);
    }
  }

  return items.map((item, index) => {
    const ytd = ytdOut[index]?.y ?? item.ytd_amount;
    const monthly = monthlyOut[index]?.y ?? item.monthly_amount;
    const quarterly = quarterlyMap.get(index) ?? null;

    const ytdFinal = pop !== null ? ytd.div(pop) : ytd;
    const monthlyFinal = pop !== null ? monthly.div(pop) : monthly;
    const quarterlyFinal = quarterly !== null && pop !== null ? quarterly.div(pop) : quarterly;

    return {
      ...item,
      account_category: item.account_category,
      expense_type: item.expense_type,
      anomaly: item.anomaly,
      ytd_amount: ytdFinal.toNumber(),
      monthly_amount: monthlyFinal.toNumber(),
      quarterly_amount: quarterlyFinal !== null ? quarterlyFinal.toNumber() : null,
    };
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps GraphQL PeriodType to internal Frequency.
 */
const mapPeriodTypeToFrequency = (periodType: PeriodType): Frequency => {
  switch (periodType) {
    case 'MONTH':
      return Frequency.MONTH;
    case 'QUARTER':
      return Frequency.QUARTER;
    case 'YEAR':
      return Frequency.YEAR;
  }
};

/**
 * Maps GraphQL ReportPeriodInput to internal ReportPeriodInput.
 */
const mapReportPeriod = (gqlPeriod: GqlReportPeriodInput): ReportPeriodInput => ({
  type: mapPeriodTypeToFrequency(gqlPeriod.type),
  selection: gqlPeriod.selection as unknown as PeriodSelection,
});

/**
 * Checks if a string is a valid DB report type value (Romanian string).
 */
const isValidDbReportType = (value: string): value is DbReportType => {
  return VALID_DB_REPORT_TYPES.has(value);
};

/**
 * Resolves the database report type from various input sources.
 */
const getDbReportType = (parent: Entity, gqlReportType?: string): string => {
  if (gqlReportType !== undefined) {
    if (isValidDbReportType(gqlReportType)) {
      return gqlReportType;
    }
    const mapped = GQL_TO_DB_REPORT_TYPE_MAP[gqlReportType as GqlReportType] as string | undefined;
    if (mapped !== undefined) {
      return mapped;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive for runtime data
  return parent.default_report_type ?? DEFAULT_REPORT_TYPE;
};

/**
 * Converts GraphQL EntityFilter to internal format.
 */
const mapGqlFilterToEntityFilter = (gqlFilter?: GqlEntityFilter): EntityFilter => {
  if (gqlFilter === undefined) {
    return {};
  }
  const filter: EntityFilter = {};
  if (gqlFilter.cui !== undefined) filter.cui = gqlFilter.cui;
  if (gqlFilter.cuis !== undefined) filter.cuis = gqlFilter.cuis;
  if (gqlFilter.name !== undefined) filter.name = gqlFilter.name;
  if (gqlFilter.entity_type !== undefined) filter.entity_type = gqlFilter.entity_type;
  if (gqlFilter.uat_id !== undefined) filter.uat_id = gqlFilter.uat_id;
  if (gqlFilter.address !== undefined) filter.address = gqlFilter.address;
  if (gqlFilter.search !== undefined) filter.search = gqlFilter.search;
  if (gqlFilter.is_uat !== undefined) filter.is_uat = gqlFilter.is_uat;
  if (gqlFilter.parents !== undefined) filter.parents = gqlFilter.parents;
  return filter;
};

/**
 * Gets the population for an entity based on entity type.
 */
const getEntityPopulation = async (
  entity: Entity,
  uatRepo: UATRepository
): Promise<number | null> => {
  if (entity.is_uat && entity.uat_id !== null) {
    const uatResult = await uatRepo.getById(entity.uat_id);
    if (uatResult.isOk() && uatResult.value !== null) {
      return uatResult.value.population;
    }
    return null;
  }

  if (entity.entity_type === 'admin_county_council' && entity.uat_id !== null) {
    const uatResult = await uatRepo.getById(entity.uat_id);
    if (uatResult.isOk() && uatResult.value !== null) {
      const countyPopResult = await uatRepo.getCountyPopulation(uatResult.value.county_code);
      if (countyPopResult.isOk()) {
        return countyPopResult.value;
      }
    }
    return null;
  }

  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeEntityResolversDeps {
  entityRepo: EntityRepository;
  uatRepo: UATRepository;
  reportRepo: ReportRepository;
  executionLineItemRepo: ExecutionLineItemsModuleRepository;
  entityAnalyticsSummaryRepo: EntityAnalyticsSummaryRepository;
  normalizationService: NormalizationService;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates GraphQL resolvers for the Entity module.
 */
export const makeEntityResolvers = (deps: MakeEntityResolversDeps): IResolvers => {
  const {
    entityRepo,
    uatRepo,
    reportRepo,
    executionLineItemRepo,
    entityAnalyticsSummaryRepo,
    normalizationService,
  } = deps;

  return {
    // ─────────────────────────────────────────────────────────────────────────
    // Query Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    Query: {
      entity: async (
        _parent: unknown,
        args: { cui: string },
        context: MercuriusContext
      ): Promise<Entity | null> => {
        const result = await getEntity({ entityRepo }, { cui: args.cui });

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: args.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      entities: async (
        _parent: unknown,
        args: { filter?: GqlEntityFilter; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapGqlFilterToEntityFilter(args.filter);
        // SECURITY: SEC-006 - Enforce pagination limits
        const limit = clampLimit(args.limit, DEFAULT_LIMIT, MAX_PAGE_SIZE);
        const offset = Math.max(0, args.offset ?? 0);

        const result = await listEntities(
          { entityRepo },
          {
            filter,
            limit,
            offset,
          }
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, filter },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Entity Type Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    Entity: {
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      default_report_type: (parent: Entity): string => {
        return parent.default_report_type;
      },

      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      is_main_creditor: (): null => {
        return null;
      },

      // UAT relation - resolved via Mercurius loader for N+1 prevention
      // Note: The actual loading is done by createEntityLoaders

      // Children relation
      children: async (parent: Entity, _args: unknown, context: MercuriusContext) => {
        const result = await entityRepo.getChildren(parent.cui);
        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return [];
        }
        return result.value;
      },

      // Parents relation
      parents: async (parent: Entity, _args: unknown, context: MercuriusContext) => {
        const result = await entityRepo.getParents(parent.cui);
        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return [];
        }
        return result.value;
      },

      // Reports relation (uses filtering/pagination, so kept as resolver)
      reports: async (
        parent: Entity,
        args: {
          limit?: number;
          offset?: number;
          year?: number;
          period?: string;
          type?: GqlReportType;
          sort?: GqlSortOrder;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ) => {
        const filter: ReportFilter = { entity_cui: parent.cui };
        if (args.year !== undefined) filter.reporting_year = args.year;
        if (args.period !== undefined) filter.reporting_period = args.period;
        if (args.type !== undefined) filter.report_type = args.type;
        if (args.main_creditor_cui !== undefined) filter.main_creditor_cui = args.main_creditor_cui;

        const sort: ReportSort | undefined =
          args.sort !== undefined
            ? { by: args.sort.by, order: args.sort.order as 'ASC' | 'DESC' }
            : undefined;

        const result = await reportRepo.list(
          filter,
          sort,
          args.limit ?? DEFAULT_REPORT_LIMIT,
          args.offset ?? 0
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return {
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          };
        }

        return result.value;
      },

      // ExecutionLineItems relation
      executionLineItems: async (
        parent: Entity,
        args: {
          filter?: Partial<AnalyticsFilter> & {
            normalization?: GqlNormalization;
            currency?: Currency;
            inflation_adjusted?: boolean;
          };
          limit?: number;
          offset?: number;
          sort?: { field?: string; by?: string; order?: string };
          normalization?: GqlNormalization;
        },
        context: MercuriusContext
      ) => {
        const reportType = args.filter?.report_type ?? parent.default_report_type;

        if (args.filter?.report_period === undefined) {
          context.reply.log.error(
            { cui: parent.cui },
            'report_period is required for executionLineItems'
          );
          return {
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          };
        }

        const filter: AnalyticsFilter = {
          ...args.filter,
          report_period: args.filter.report_period,
          account_category: args.filter.account_category ?? 'vn',
          entity_cuis: [parent.cui],
          report_type: reportType,
        };

        const sortField = args.sort?.field ?? args.sort?.by ?? 'year';
        const sortOrder: 'ASC' | 'DESC' =
          args.sort?.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        const sort = { field: sortField as SortableField, order: sortOrder };

        const result = await executionLineItemRepo.list(
          filter,
          sort,
          args.limit ?? DEFAULT_ELI_LIMIT,
          args.offset ?? 0
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return {
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          };
        }

        const normalization = args.normalization ?? args.filter.normalization;
        const request = resolveNormalizationRequest({
          normalization: normalization ?? null,
          currency: args.filter.currency ?? null,
          inflationAdjusted: args.filter.inflation_adjusted ?? null,
          showPeriodGrowth: false,
        });

        let population: number | null = null;
        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedNodes = await applyNormalizationToLineItems(
          result.value.nodes,
          request,
          filter.report_period,
          population,
          normalizationService
        );

        return {
          nodes: normalizedNodes,
          pageInfo: result.value.pageInfo,
        };
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Analytics - Totals
      // ─────────────────────────────────────────────────────────────────────────

      totalIncome: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: GqlNormalization;
          currency?: Currency;
          inflation_adjusted?: boolean;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ): Promise<number | null> => {
        const period = mapReportPeriod(args.period);
        const reportType = getDbReportType(parent, args.reportType);

        const result = await entityAnalyticsSummaryRepo.getTotals(
          parent.cui,
          period,
          reportType,
          args.main_creditor_cui
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return null;
        }

        let population: number | null = null;
        const request = resolveNormalizationRequest({
          normalization: args.normalization ?? null,
          currency: args.currency ?? null,
          inflationAdjusted: args.inflation_adjusted ?? null,
          showPeriodGrowth: false,
        });

        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        return applyNormalizationToValue(
          result.value.totalIncome,
          request,
          period,
          population,
          normalizationService
        );
      },

      totalExpenses: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: GqlNormalization;
          currency?: Currency;
          inflation_adjusted?: boolean;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ): Promise<number | null> => {
        const period = mapReportPeriod(args.period);
        const reportType = getDbReportType(parent, args.reportType);

        const result = await entityAnalyticsSummaryRepo.getTotals(
          parent.cui,
          period,
          reportType,
          args.main_creditor_cui
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return null;
        }

        let population: number | null = null;
        const request = resolveNormalizationRequest({
          normalization: args.normalization ?? null,
          currency: args.currency ?? null,
          inflationAdjusted: args.inflation_adjusted ?? null,
          showPeriodGrowth: false,
        });

        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        return applyNormalizationToValue(
          result.value.totalExpenses,
          request,
          period,
          population,
          normalizationService
        );
      },

      budgetBalance: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: GqlNormalization;
          currency?: Currency;
          inflation_adjusted?: boolean;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ): Promise<number | null> => {
        const period = mapReportPeriod(args.period);
        const reportType = getDbReportType(parent, args.reportType);

        const result = await entityAnalyticsSummaryRepo.getTotals(
          parent.cui,
          period,
          reportType,
          args.main_creditor_cui
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return null;
        }

        let population: number | null = null;
        const request = resolveNormalizationRequest({
          normalization: args.normalization ?? null,
          currency: args.currency ?? null,
          inflationAdjusted: args.inflation_adjusted ?? null,
          showPeriodGrowth: false,
        });

        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        return applyNormalizationToValue(
          result.value.budgetBalance,
          request,
          period,
          population,
          normalizationService
        );
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Analytics - Trends
      // ─────────────────────────────────────────────────────────────────────────

      incomeTrend: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: GqlNormalization;
          currency?: Currency;
          inflation_adjusted?: boolean;
          show_period_growth?: boolean;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ) => {
        const period = mapReportPeriod(args.period);
        const reportType = getDbReportType(parent, args.reportType);

        const result = await entityAnalyticsSummaryRepo.getTrend(
          parent.cui,
          period,
          reportType,
          'income',
          args.main_creditor_cui
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        const request = resolveNormalizationRequest({
          normalization: args.normalization ?? null,
          currency: args.currency ?? null,
          inflationAdjusted: args.inflation_adjusted ?? null,
          showPeriodGrowth: args.show_period_growth ?? null,
        });

        let population: number | null = null;
        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          request,
          period,
          population,
          normalizationService
        );

        return {
          seriesId: `${parent.cui}_income_trend`,
          xAxis: {
            name: getAxisNameForFrequency(period.type),
            type: 'STRING',
            unit: '',
          },
          yAxis: {
            name: getYAxisNameForNormalization(request),
            type: 'FLOAT',
            unit: getUnitForNormalization(request),
          },
          data: normalizedData,
        };
      },

      expensesTrend: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: GqlNormalization;
          currency?: Currency;
          inflation_adjusted?: boolean;
          show_period_growth?: boolean;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ) => {
        const period = mapReportPeriod(args.period);
        const reportType = getDbReportType(parent, args.reportType);

        const result = await entityAnalyticsSummaryRepo.getTrend(
          parent.cui,
          period,
          reportType,
          'expenses',
          args.main_creditor_cui
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        const request = resolveNormalizationRequest({
          normalization: args.normalization ?? null,
          currency: args.currency ?? null,
          inflationAdjusted: args.inflation_adjusted ?? null,
          showPeriodGrowth: args.show_period_growth ?? null,
        });

        let population: number | null = null;
        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          request,
          period,
          population,
          normalizationService
        );

        return {
          seriesId: `${parent.cui}_expenses_trend`,
          xAxis: {
            name: getAxisNameForFrequency(period.type),
            type: 'STRING',
            unit: '',
          },
          yAxis: {
            name: getYAxisNameForNormalization(request),
            type: 'FLOAT',
            unit: getUnitForNormalization(request),
          },
          data: normalizedData,
        };
      },

      balanceTrend: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: GqlNormalization;
          currency?: Currency;
          inflation_adjusted?: boolean;
          show_period_growth?: boolean;
          main_creditor_cui?: string;
        },
        context: MercuriusContext
      ) => {
        const period = mapReportPeriod(args.period);
        const reportType = getDbReportType(parent, args.reportType);

        const result = await entityAnalyticsSummaryRepo.getTrend(
          parent.cui,
          period,
          reportType,
          'balance',
          args.main_creditor_cui
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.cui },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        const request = resolveNormalizationRequest({
          normalization: args.normalization ?? null,
          currency: args.currency ?? null,
          inflationAdjusted: args.inflation_adjusted ?? null,
          showPeriodGrowth: args.show_period_growth ?? null,
        });

        let population: number | null = null;
        if (request.normalization === 'per_capita') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          request,
          period,
          population,
          normalizationService
        );

        return {
          seriesId: `${parent.cui}_balance_trend`,
          xAxis: {
            name: getAxisNameForFrequency(period.type),
            type: 'STRING',
            unit: '',
          },
          yAxis: {
            name: getYAxisNameForNormalization(request),
            type: 'FLOAT',
            unit: getUnitForNormalization(request),
          },
          data: normalizedData,
        };
      },
    },
  };
};
