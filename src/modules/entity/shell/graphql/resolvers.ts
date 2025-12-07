/**
 * Entity Module GraphQL Resolvers
 *
 * Implements Query and Entity type resolvers.
 */

import { Decimal } from 'decimal.js';

import { Frequency } from '@/common/types/temporal.js';

import {
  DEFAULT_REPORT_LIMIT,
  DEFAULT_REPORT_ELI_LIMIT,
  DEFAULT_UAT_LIMIT,
  type Entity,
  type EntityFilter,
  type Report,
  type ReportFilter,
  type ReportSort,
  type ReportPeriodInput,
  type GqlReportType,
  type DbReportType,
  type UAT,
  type UATFilter,
} from '../../core/types.js';
import { getEntity } from '../../core/usecases/get-entity.js';
import { getReport } from '../../core/usecases/get-report.js';
import { getUAT } from '../../core/usecases/get-uat.js';
import { listEntities } from '../../core/usecases/list-entities.js';
import { listReports } from '../../core/usecases/list-reports.js';
import { listUATs } from '../../core/usecases/list-uats.js';

import type {
  EntityRepository,
  UATRepository,
  ReportRepository,
  EntityAnalyticsSummaryRepository,
} from '../../core/ports.js';
import type {
  PeriodType,
  PeriodDate,
  AnalyticsFilter,
  PeriodSelection,
  Currency,
} from '@/common/types/analytics.js';
import type { BudgetSectorRepository } from '@/modules/budget-sector/index.js';
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
import type { IResolvers, MercuriusContext } from 'mercurius';

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

interface GqlReportFilterInput {
  entity_cui?: string;
  reporting_year?: number;
  reporting_period?: string;
  report_date_start?: string;
  report_date_end?: string;
  report_type?: GqlReportType;
  main_creditor_cui?: string;
  search?: string;
}

interface GqlUATFilterInput {
  id?: string;
  ids?: string[];
  uat_key?: string;
  uat_code?: string;
  name?: string;
  county_code?: string;
  county_name?: string;
  region?: string;
  search?: string;
  is_county?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ELI_LIMIT = 10_000;

/** Map GraphQL ReportType to DB value */
const GQL_TO_DB_REPORT_TYPE_MAP: Record<GqlReportType, DbReportType> = {
  PRINCIPAL_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator principal',
  SECONDARY_AGGREGATED: 'Executie bugetara agregata la nivel de ordonator secundar',
  DETAILED: 'Executie bugetara detaliata',
};

// ─────────────────────────────────────────────────────────────────────────────
// Normalization Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses GraphQL Normalization enum to internal normalization mode and currency.
 *
 * GraphQL enum values:
 * - total -> normalization: 'total', currency: 'RON'
 * - total_euro -> normalization: 'total', currency: 'EUR'
 * - per_capita -> normalization: 'per_capita', currency: 'RON'
 * - per_capita_euro -> normalization: 'per_capita', currency: 'EUR'
 * - percent_gdp -> normalization: 'percent_gdp', currency: 'RON'
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
 * Used for totalIncome, totalExpenses, budgetBalance.
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

  // Build transformation options
  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization,
    showPeriodGrowth: false,
  };

  // Create a single data point to normalize
  // Use the end year for single-value normalization (snapshot)
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
    return value; // Fallback to original value on error
  }

  const firstPoint = result.value[0];
  if (firstPoint === undefined) {
    return value;
  }

  let normalizedValue = firstPoint.y.toNumber();

  // Apply per_capita if needed (since NormalizationService doesn't handle population directly for single values)
  if (normalization === 'per_capita' && population !== null && population > 0) {
    normalizedValue = normalizedValue / population;
  }

  return normalizedValue;
};

/**
 * Applies normalization to a data series (array of data points).
 * Used for incomeTrend, expensesTrend, balanceTrend.
 */
const applyNormalizationToSeries = async (
  data: { date: string; value: Decimal }[],
  gqlNorm: GqlNormalization | undefined,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<{ x: string; y: number }[]> => {
  if (data.length === 0) return [];

  // If no normalization needed, just convert
  if (gqlNorm === undefined || gqlNorm === 'total') {
    return data.map((point) => ({
      x: point.date,
      y: point.value.toNumber(),
    }));
  }

  const { normalization, currency } = parseGqlNormalization(gqlNorm);
  const [startYear, endYear] = getYearRangeFromPeriod(period);

  // Build transformation options
  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization: normalization === 'per_capita' ? 'total' : normalization, // Handle per_capita separately
    showPeriodGrowth: false,
  };

  // Convert to DataPoint format
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
    // Fallback to original values on error
    return data.map((point) => ({
      x: point.date,
      y: point.value.toNumber(),
    }));
  }

  // Apply per_capita if needed
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
 * Amounts are numbers after normalization is applied.
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
 * Used for the executionLineItems field resolver.
 *
 * @param items - Raw execution line items with Decimal amounts
 * @param gqlNorm - GraphQL normalization mode
 * @param period - Report period for normalization factors
 * @param population - Entity population for per_capita
 * @param normService - Normalization service
 * @returns Normalized items with number amounts
 */
const applyNormalizationToLineItems = async (
  items: ExecutionLineItem[],
  gqlNorm: GqlNormalization | undefined,
  period: ReportPeriodInput,
  population: number | null,
  normService: NormalizationService
): Promise<NormalizedExecutionLineItem[]> => {
  if (items.length === 0) return [];

  // If no normalization needed, just convert Decimal to number
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

  // Build transformation options (handle per_capita separately after currency conversion)
  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization: normalization === 'per_capita' ? 'total' : normalization,
    showPeriodGrowth: false,
  };

  const normalizedItems: NormalizedExecutionLineItem[] = [];

  for (const item of items) {
    const yearLabel = String(item.year);

    // Normalize ytd_amount
    const ytdDataPoint: DataPoint = { x: yearLabel, year: item.year, y: item.ytd_amount };
    const ytdResult = await normService.normalize([ytdDataPoint], options, Frequency.YEAR, [
      startYear,
      endYear,
    ]);

    // Normalize monthly_amount
    const monthlyDataPoint: DataPoint = { x: yearLabel, year: item.year, y: item.monthly_amount };
    const monthlyResult = await normService.normalize([monthlyDataPoint], options, Frequency.YEAR, [
      startYear,
      endYear,
    ]);

    // Normalize quarterly_amount if present
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

    // Extract normalized values (fallback to original on error)
    let normalizedYtd =
      ytdResult.isOk() && ytdResult.value.length > 0 && ytdResult.value[0] !== undefined
        ? ytdResult.value[0].y.toNumber()
        : item.ytd_amount.toNumber();
    let normalizedMonthly =
      monthlyResult.isOk() && monthlyResult.value.length > 0 && monthlyResult.value[0] !== undefined
        ? monthlyResult.value[0].y.toNumber()
        : item.monthly_amount.toNumber();

    // Apply per_capita division if needed
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

/** Default report type used when entity doesn't have one set */
const DEFAULT_REPORT_TYPE: DbReportType = 'Executie bugetara detaliata';

/** Set of valid DB report type values for validation */
const VALID_DB_REPORT_TYPES = new Set<string>(Object.values(GQL_TO_DB_REPORT_TYPE_MAP));

/**
 * Checks if a string is a valid DB report type value (Romanian string).
 */
const isValidDbReportType = (value: string): value is DbReportType => {
  return VALID_DB_REPORT_TYPES.has(value);
};

/**
 * Resolves the database report type from various input sources.
 *
 * This function handles multiple input formats for backward compatibility:
 *
 * 1. **GraphQL enum values**: `PRINCIPAL_AGGREGATED`, `SECONDARY_AGGREGATED`, `DETAILED`
 *    - These are mapped to their Romanian DB equivalents
 *
 * 2. **DB string values**: Already-resolved Romanian strings like
 *    `'Executie bugetara agregata la nivel de ordonator principal'`
 *    - These are returned as-is (supports clients that pass DB values directly)
 *
 * 3. **Entity default**: Falls back to `parent.default_report_type` if no arg provided
 *
 * 4. **System default**: Falls back to `'Executie bugetara detaliata'` if entity
 *    doesn't have a default set (defensive, should not happen with valid data)
 *
 * @param parent - The parent Entity containing default_report_type
 * @param gqlReportType - Optional report type from GraphQL args (enum or DB string)
 * @returns The resolved DB report type string (Romanian)
 *
 * @example
 * // GraphQL enum input
 * getDbReportType(entity, 'PRINCIPAL_AGGREGATED')
 * // Returns: 'Executie bugetara agregata la nivel de ordonator principal'
 *
 * @example
 * // DB string input (already resolved)
 * getDbReportType(entity, 'Executie bugetara detaliata')
 * // Returns: 'Executie bugetara detaliata'
 *
 * @example
 * // No input - uses entity default
 * getDbReportType(entity, undefined)
 * // Returns: entity.default_report_type or DEFAULT_REPORT_TYPE
 */
const getDbReportType = (parent: Entity, gqlReportType?: string): string => {
  if (gqlReportType !== undefined) {
    // Check if it's already a DB value (Romanian string)
    if (isValidDbReportType(gqlReportType)) {
      return gqlReportType;
    }
    // Otherwise, try to map from GraphQL enum
    const mapped = GQL_TO_DB_REPORT_TYPE_MAP[gqlReportType as GqlReportType] as string | undefined;
    if (mapped !== undefined) {
      return mapped;
    }
    // Unknown value - fall through to use entity default
  }
  // Use entity's default (type says non-nullable, but defensive fallback for runtime safety)
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
 * Converts GraphQL ReportFilterInput to internal ReportFilter.
 */
const mapGqlFilterToReportFilter = (gqlFilter?: GqlReportFilterInput): ReportFilter => {
  if (gqlFilter === undefined) {
    return {};
  }
  const filter: ReportFilter = {};
  if (gqlFilter.entity_cui !== undefined) filter.entity_cui = gqlFilter.entity_cui;
  if (gqlFilter.reporting_year !== undefined) filter.reporting_year = gqlFilter.reporting_year;
  if (gqlFilter.reporting_period !== undefined)
    filter.reporting_period = gqlFilter.reporting_period;
  if (gqlFilter.report_date_start !== undefined)
    filter.report_date_start = gqlFilter.report_date_start;
  if (gqlFilter.report_date_end !== undefined) filter.report_date_end = gqlFilter.report_date_end;
  if (gqlFilter.report_type !== undefined) filter.report_type = gqlFilter.report_type;
  if (gqlFilter.main_creditor_cui !== undefined)
    filter.main_creditor_cui = gqlFilter.main_creditor_cui;
  if (gqlFilter.search !== undefined) filter.search = gqlFilter.search;
  return filter;
};

/**
 * Converts GraphQL UATFilterInput to internal UATFilter.
 */
const mapGqlFilterToUATFilter = (gqlFilter?: GqlUATFilterInput): UATFilter => {
  if (gqlFilter === undefined) {
    return {};
  }
  const filter: UATFilter = {};
  if (gqlFilter.id !== undefined) filter.id = Number.parseInt(gqlFilter.id, 10);
  if (gqlFilter.ids !== undefined) filter.ids = gqlFilter.ids.map((id) => Number.parseInt(id, 10));
  if (gqlFilter.uat_key !== undefined) filter.uat_key = gqlFilter.uat_key;
  if (gqlFilter.uat_code !== undefined) filter.uat_code = gqlFilter.uat_code;
  if (gqlFilter.name !== undefined) filter.name = gqlFilter.name;
  if (gqlFilter.county_code !== undefined) filter.county_code = gqlFilter.county_code;
  if (gqlFilter.county_name !== undefined) filter.county_name = gqlFilter.county_name;
  if (gqlFilter.region !== undefined) filter.region = gqlFilter.region;
  if (gqlFilter.search !== undefined) filter.search = gqlFilter.search;
  if (gqlFilter.is_county !== undefined) filter.is_county = gqlFilter.is_county;
  return filter;
};

/**
 * Gets the population for an entity based on entity type.
 *
 * Population calculation rules:
 * - If is_uat === true: Use the UAT's population
 * - If entity_type === 'admin_county_council': Sum all UAT populations in that county
 * - Otherwise (ministries, national agencies): Return null (no per-capita makes sense)
 *
 * @param entity - The entity to get population for
 * @param uatRepo - UAT repository
 * @returns Population or null if not applicable
 */
const getEntityPopulation = async (
  entity: Entity,
  uatRepo: UATRepository
): Promise<number | null> => {
  // For UAT entities, use the UAT's population directly
  if (entity.is_uat && entity.uat_id !== null) {
    const uatResult = await uatRepo.getById(entity.uat_id);
    if (uatResult.isOk() && uatResult.value !== null) {
      return uatResult.value.population;
    }
    return null;
  }

  // For county councils, get the county's total population
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

  // For ministries and other national entities, per-capita doesn't make sense
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
  budgetSectorRepo: BudgetSectorRepository;
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
    budgetSectorRepo,
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
            limit: args.limit ?? 20,
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

      report: async (
        _parent: unknown,
        args: { report_id: string },
        context: MercuriusContext
      ): Promise<Report | null> => {
        const result = await getReport({ reportRepo }, { reportId: args.report_id });

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, report_id: args.report_id },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      reports: async (
        _parent: unknown,
        args: { filter?: GqlReportFilterInput; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapGqlFilterToReportFilter(args.filter);
        const result = await listReports(
          { reportRepo },
          {
            filter,
            limit: args.limit ?? DEFAULT_REPORT_LIMIT,
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

      uat: async (
        _parent: unknown,
        args: { id: string },
        context: MercuriusContext
      ): Promise<UAT | null> => {
        const id = Number.parseInt(args.id, 10);
        if (Number.isNaN(id)) {
          throw new Error('[VALIDATION_ERROR] Invalid UAT ID');
        }

        const result = await getUAT({ uatRepo }, { id });

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, id: args.id },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      uats: async (
        _parent: unknown,
        args: { filter?: GqlUATFilterInput; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapGqlFilterToUATFilter(args.filter);
        const result = await listUATs(
          { uatRepo },
          {
            filter,
            limit: args.limit ?? DEFAULT_UAT_LIMIT,
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
      // Note: default_report_type returns the DB value (Romanian string).
      // The EnumResolvers in common/resolvers.ts automatically maps it to
      // the GraphQL ReportType enum (PRINCIPAL_AGGREGATED, etc.)
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      default_report_type: (parent: Entity): string => {
        return parent.default_report_type;
      },

      // Compute is_main_creditor based on having children
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      is_main_creditor: async (parent: Entity): Promise<boolean> => {
        const result = await entityRepo.getChildren(parent.cui);
        if (result.isErr()) {
          return false;
        }
        return result.value.length > 0;
      },

      // UAT relation
      uat: async (parent: Entity) => {
        if (parent.uat_id === null) {
          return null;
        }
        const result = await uatRepo.getById(parent.uat_id);
        if (result.isErr()) {
          return null;
        }
        return result.value;
      },

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

      // Reports relation
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
        // Build filter with injected entity_cuis and default report_type
        const reportType = args.filter?.report_type ?? parent.default_report_type;

        // Check if report_period is provided
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

        // Support both 'field' (new) and 'by' (old) property names for backward compatibility
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

        // Get normalization from args OR from filter (backwards compatibility)
        // Filter may contain normalization from older clients
        const filterWithNormalization = args.filter as
          | (Partial<AnalyticsFilter> & { normalization?: GqlNormalization })
          | undefined;
        const normalization = args.normalization ?? filterWithNormalization?.normalization;

        // Get population for per_capita normalization
        let population: number | null = null;
        if (normalization === 'per_capita' || normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        // Apply normalization to line items
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

        // Get population for per_capita normalization
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

        // Get population for per_capita normalization
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

        // Get population for per_capita normalization
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

        // Get population for per_capita normalization
        let population: number | null = null;
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        // Apply normalization to the data series
        const normalizedData = await applyNormalizationToSeries(
          result.value.data,
          args.normalization,
          period,
          population,
          normalizationService
        );

        // Convert to AnalyticsSeries format
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

        // Get population for per_capita normalization
        let population: number | null = null;
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        // Apply normalization to the data series
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

        // Get population for per_capita normalization
        let population: number | null = null;
        if (args.normalization === 'per_capita' || args.normalization === 'per_capita_euro') {
          population = await getEntityPopulation(parent, uatRepo);
        }

        // Apply normalization to the data series
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

    // ─────────────────────────────────────────────────────────────────────────
    // Report Type Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    Report: {
      // Note: report_type returns the DB value (Romanian string).
      // The EnumResolvers in common/resolvers.ts automatically maps it to
      // the GraphQL ReportType enum (PRINCIPAL_AGGREGATED, etc.)
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      report_type: (parent: Report): string => {
        return parent.report_type;
      },

      // Entity relation
      entity: async (parent: Report, _args: unknown, context: MercuriusContext) => {
        const result = await entityRepo.getById(parent.entity_cui);
        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.entity_cui },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }
        return result.value;
      },

      // Main creditor relation
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      main_creditor: async (parent: Report, _args: unknown, context: MercuriusContext) => {
        if (parent.main_creditor_cui === null) {
          return null;
        }
        const result = await entityRepo.getById(parent.main_creditor_cui);
        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, cui: parent.main_creditor_cui },
            `[${result.error.type}] ${result.error.message}`
          );
          return null;
        }
        return result.value;
      },

      // Budget sector relation
      budgetSector: async (parent: Report, _args: unknown, context: MercuriusContext) => {
        const result = await budgetSectorRepo.findById(parent.budget_sector_id);
        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, budget_sector_id: parent.budget_sector_id },
            `[${result.error.type}] ${result.error.message}`
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }
        return result.value;
      },

      // Execution line items relation
      executionLineItems: async (
        parent: Report,
        args: {
          limit?: number;
          offset?: number;
          functionalCode?: string;
          economicCode?: string;
          accountCategory?: 'vn' | 'ch';
          minAmount?: number;
          maxAmount?: number;
        },
        context: MercuriusContext
      ) => {
        // Build filter with report_id
        const filter: AnalyticsFilter = {
          report_ids: [parent.report_id],
          account_category: args.accountCategory ?? 'vn',
          report_type: parent.report_type,
          report_period: {
            type: Frequency.YEAR,
            selection: {
              interval: {
                start: String(parent.reporting_year) as PeriodDate,
                end: String(parent.reporting_year) as PeriodDate,
              },
            },
          },
        };

        // Apply optional filters
        if (args.functionalCode !== undefined) {
          filter.functional_codes = [args.functionalCode];
        }

        if (args.economicCode !== undefined) {
          filter.economic_codes = [args.economicCode];
        }

        if (args.minAmount !== undefined) {
          filter.item_min_amount = args.minAmount;
        }

        if (args.maxAmount !== undefined) {
          filter.item_max_amount = args.maxAmount;
        }

        const sort = { field: 'ytd_amount' as SortableField, order: 'DESC' as const };

        const result = await executionLineItemRepo.list(
          filter,
          sort,
          args.limit ?? DEFAULT_REPORT_ELI_LIMIT,
          args.offset ?? 0
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, report_id: parent.report_id },
            `[${result.error.type}] ${result.error.message}`
          );
          return {
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          };
        }

        return result.value;
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // UAT Type Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    UAT: {
      // County entity relation - returns the Entity (not UAT) for the county
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      county_entity: async (parent: UAT, _args: unknown, context: MercuriusContext) => {
        // County UAT identification:
        // - siruta_code = county_code, OR
        // - county_code = 'B' AND siruta_code = '179132' (Bucharest special case)
        const isCounty =
          parent.siruta_code === parent.county_code ||
          (parent.county_code === 'B' && parent.siruta_code === '179132');

        if (isCounty) {
          // This UAT is itself a county, no parent county entity
          return null;
        }

        // Find the Entity linked to the county UAT for this UAT's county_code
        const result = await entityRepo.getCountyEntity(parent.county_code);

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, parent_id: parent.id, county_code: parent.county_code },
            `[${result.error.type}] county_entity lookup failed`
          );
          return null;
        }

        return result.value;
      },
    },
  };
};
