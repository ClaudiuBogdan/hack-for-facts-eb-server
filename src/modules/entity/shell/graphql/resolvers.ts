/**
 * Entity Module GraphQL Resolvers
 *
 * Implements Query and Entity type resolvers.
 * UAT and Report Query resolvers are now in separate modules.
 */

import { Decimal } from 'decimal.js';

import { Frequency } from '@/common/types/temporal.js';

import {
  DEFAULT_LIMIT,
  type Entity,
  type EntityFilter,
  type ReportPeriodInput,
  type GqlReportType,
  type DbReportType,
} from '../../core/types.js';
import { getEntity } from '../../core/usecases/get-entity.js';
import { listEntities } from '../../core/usecases/list-entities.js';

import type { EntityRepository, EntityAnalyticsSummaryRepository } from '../../core/ports.js';
import type {
  PeriodType,
  AnalyticsFilter,
  PeriodSelection,
  Currency,
} from '@/common/types/analytics.js';
import type {
  ExecutionLineItemRepository as ExecutionLineItemsModuleRepository,
  SortableField,
  ExecutionLineItem,
} from '@/modules/execution-line-items/index.js';
import type {
  NormalizationService,
  DataPoint,
  TransformationOptions,
  NormalizationMode,
} from '@/modules/normalization/index.js';
import type { ReportRepository, ReportFilter, ReportSort } from '@/modules/report/index.js';
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

/**
 * GraphQL Normalization enum values.
 * Maps to internal normalization mode + currency combination.
 */
type GqlNormalization = 'total' | 'total_euro' | 'per_capita' | 'per_capita_euro' | 'percent_gdp';

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
 * Parses GraphQL Normalization enum to internal normalization mode and currency.
 */
const parseGqlNormalization = (
  gqlNorm: GqlNormalization | undefined
): { normalization: NormalizationMode; currency: Currency } => {
  switch (gqlNorm) {
    case 'total_euro':
      return { normalization: 'total', currency: 'EUR' };
    case 'per_capita':
      return { normalization: 'per_capita', currency: 'RON' };
    case 'per_capita_euro':
      return { normalization: 'per_capita', currency: 'EUR' };
    case 'percent_gdp':
      return { normalization: 'percent_gdp', currency: 'RON' };
    case 'total':
    default:
      return { normalization: 'total', currency: 'RON' };
  }
};

/**
 * Returns the Y-axis unit string based on normalization mode.
 */
const getUnitForNormalization = (gqlNorm: GqlNormalization | undefined): string => {
  switch (gqlNorm) {
    case 'total':
      return 'RON';
    case 'total_euro':
      return 'EUR';
    case 'per_capita':
      return 'RON/capita';
    case 'per_capita_euro':
      return 'EUR/capita';
    case 'percent_gdp':
      return '% of GDP';
    default:
      return 'RON';
  }
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
    const startYear = parseInt(selection.interval.start.substring(0, 4), 10);
    const endYear = parseInt(selection.interval.end.substring(0, 4), 10);
    return [startYear, endYear];
  }

  // At this point, selection must have dates (due to discriminated union)
  const dates = selection.dates;
  if (dates.length > 0) {
    const years = dates.map((d) => parseInt(d.substring(0, 4), 10));
    return [Math.min(...years), Math.max(...years)];
  }

  // Fallback to current year (empty dates array)
  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear];
};

/**
 * Applies normalization to a single numeric value.
 */
const applyNormalizationToValue = async (
  value: number | null,
  gqlNorm: GqlNormalization | undefined,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<number | null> => {
  if (value === null) return null;
  if (gqlNorm === undefined || gqlNorm === 'total') return value;

  const { normalization, currency } = parseGqlNormalization(gqlNorm);
  const [startYear, endYear] = getYearRangeFromPeriod(period);

  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization: normalization === 'per_capita' ? 'total' : normalization,
    showPeriodGrowth: false,
  };

  const yearLabel = String(endYear);
  const dataPoint: DataPoint = {
    x: yearLabel,
    year: endYear,
    y: new Decimal(value),
  };

  const result = await normService.normalize([dataPoint], options, Frequency.YEAR, [
    startYear,
    endYear,
  ]);

  if (result.isErr() || result.value.length === 0) {
    return value;
  }

  const firstPoint = result.value[0];
  if (firstPoint === undefined) {
    return value;
  }

  let normalizedValue = firstPoint.y.toNumber();

  if (normalization === 'per_capita' && population !== null && population > 0) {
    normalizedValue = normalizedValue / population;
  }

  return normalizedValue;
};

/**
 * Applies normalization to a data series.
 */
const applyNormalizationToSeries = async (
  data: { date: string; value: Decimal }[],
  gqlNorm: GqlNormalization | undefined,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<{ x: string; y: number }[]> => {
  if (data.length === 0) return [];

  if (gqlNorm === undefined || gqlNorm === 'total') {
    return data.map((point) => ({
      x: point.date,
      y: point.value.toNumber(),
    }));
  }

  const { normalization, currency } = parseGqlNormalization(gqlNorm);
  const [startYear, endYear] = getYearRangeFromPeriod(period);

  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization: normalization === 'per_capita' ? 'total' : normalization,
    showPeriodGrowth: false,
  };

  const dataPoints: DataPoint[] = data.map((point) => ({
    x: point.date,
    year: parseInt(point.date.substring(0, 4), 10),
    y: point.value,
  }));

  const result = await normService.normalize(dataPoints, options, period.type, [
    startYear,
    endYear,
  ]);

  if (result.isErr()) {
    return data.map((point) => ({
      x: point.date,
      y: point.value.toNumber(),
    }));
  }

  let normalizedPoints = result.value;
  if (normalization === 'per_capita' && population !== null && population > 0) {
    normalizedPoints = normalizedPoints.map((p) => ({
      ...p,
      y: p.y.div(population),
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
  gqlNorm: GqlNormalization | undefined,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<NormalizedExecutionLineItem[]> => {
  if (items.length === 0) return [];

  if (gqlNorm === undefined || gqlNorm === 'total') {
    return items.map((item) => ({
      ...item,
      account_category: item.account_category,
      expense_type: item.expense_type,
      anomaly: item.anomaly,
      ytd_amount: item.ytd_amount.toNumber(),
      monthly_amount: item.monthly_amount.toNumber(),
      quarterly_amount: item.quarterly_amount !== null ? item.quarterly_amount.toNumber() : null,
    }));
  }

  const { normalization, currency } = parseGqlNormalization(gqlNorm);
  const [startYear, endYear] = getYearRangeFromPeriod(period);

  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization: normalization === 'per_capita' ? 'total' : normalization,
    showPeriodGrowth: false,
  };

  const normalizedItems: NormalizedExecutionLineItem[] = [];

  for (const item of items) {
    const yearLabel = String(item.year);

    const ytdDataPoint: DataPoint = { x: yearLabel, year: item.year, y: item.ytd_amount };
    const ytdResult = await normService.normalize([ytdDataPoint], options, Frequency.YEAR, [
      startYear,
      endYear,
    ]);

    const monthlyDataPoint: DataPoint = { x: yearLabel, year: item.year, y: item.monthly_amount };
    const monthlyResult = await normService.normalize([monthlyDataPoint], options, Frequency.YEAR, [
      startYear,
      endYear,
    ]);

    let normalizedQuarterly: number | null = null;
    if (item.quarterly_amount !== null) {
      const quarterlyDataPoint: DataPoint = {
        x: yearLabel,
        year: item.year,
        y: item.quarterly_amount,
      };
      const quarterlyResult = await normService.normalize(
        [quarterlyDataPoint],
        options,
        Frequency.YEAR,
        [startYear, endYear]
      );
      if (quarterlyResult.isOk() && quarterlyResult.value.length > 0) {
        const qPoint = quarterlyResult.value[0];
        normalizedQuarterly = qPoint !== undefined ? qPoint.y.toNumber() : null;
      }
    }

    let normalizedYtd =
      ytdResult.isOk() && ytdResult.value.length > 0 && ytdResult.value[0] !== undefined
        ? ytdResult.value[0].y.toNumber()
        : item.ytd_amount.toNumber();
    let normalizedMonthly =
      monthlyResult.isOk() && monthlyResult.value.length > 0 && monthlyResult.value[0] !== undefined
        ? monthlyResult.value[0].y.toNumber()
        : item.monthly_amount.toNumber();

    if (normalization === 'per_capita' && population !== null && population > 0) {
      normalizedYtd = normalizedYtd / population;
      normalizedMonthly = normalizedMonthly / population;
      if (normalizedQuarterly !== null) {
        normalizedQuarterly = normalizedQuarterly / population;
      }
    }

    normalizedItems.push({
      ...item,
      account_category: item.account_category,
      expense_type: item.expense_type,
      anomaly: item.anomaly,
      ytd_amount: normalizedYtd,
      monthly_amount: normalizedMonthly,
      quarterly_amount: normalizedQuarterly,
    });
  }

  return normalizedItems;
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
        const result = await listEntities(
          { entityRepo },
          {
            filter,
            limit: args.limit ?? DEFAULT_LIMIT,
            offset: args.offset ?? 0,
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
          filter?: Partial<AnalyticsFilter>;
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

        const filterWithNormalization = args.filter as
          | (Partial<AnalyticsFilter> & { normalization?: GqlNormalization })
          | undefined;
        const normalization = args.normalization ?? filterWithNormalization?.normalization;

        let population: number | null = null;
        if (normalization === 'per_capita' || normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedNodes = await applyNormalizationToLineItems(
          result.value.nodes,
          normalization,
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
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        return applyNormalizationToValue(
          result.value.totalIncome,
          args.normalization,
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
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        return applyNormalizationToValue(
          result.value.totalExpenses,
          args.normalization,
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
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        return applyNormalizationToValue(
          result.value.budgetBalance,
          args.normalization,
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

        let population: number | null = null;
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          args.normalization,
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
            name: 'Amount',
            type: 'FLOAT',
            unit: getUnitForNormalization(args.normalization),
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

        let population: number | null = null;
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          args.normalization,
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
            name: 'Amount',
            type: 'FLOAT',
            unit: getUnitForNormalization(args.normalization),
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

        let population: number | null = null;
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          args.normalization,
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
            name: 'Amount',
            type: 'FLOAT',
            unit: getUnitForNormalization(args.normalization),
          },
          data: normalizedData,
        };
      },
    },
  };
};
