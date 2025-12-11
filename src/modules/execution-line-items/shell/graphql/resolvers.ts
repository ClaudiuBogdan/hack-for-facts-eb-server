/**
 * GraphQL resolvers for Execution Line Items module.
 *
 * Query resolvers only. Nested field resolvers are handled by
 * Mercurius loaders (see loaders.ts) for N+1 prevention.
 */

import { Frequency } from '@/common/types/temporal.js';

import {
  DEFAULT_LIMIT,
  type ExecutionLineItem,
  type ExecutionLineItemOutput,
  type SortInput,
  type SortOrder,
  type SortableField,
  SORTABLE_FIELDS,
} from '../../core/types.js';
import { getExecutionLineItem } from '../../core/usecases/get-execution-line-item.js';
import { listExecutionLineItems } from '../../core/usecases/list-execution-line-items.js';

import type { ExecutionLineItemRepository } from '../../core/ports.js';
import type {
  AnalyticsExclude,
  AnalyticsFilter,
  AccountCategory,
  ExpenseType,
  PeriodDate,
  Currency,
} from '@/common/types/analytics.js';
import type {
  NormalizationService,
  DataPoint,
  TransformationOptions,
  NormalizationMode,
} from '@/modules/normalization/index.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ============================================================================
// Types
// ============================================================================

/**
 * Dependencies for execution line item resolvers.
 */
export interface MakeExecutionLineItemResolversDeps {
  executionLineItemRepo: ExecutionLineItemRepository;
  normalizationService: NormalizationService;
}

// ============================================================================
// GraphQL Input Types
// ============================================================================

interface ExecutionLineItemQueryArgs {
  id: string;
}

/**
 * GraphQL Normalization enum values.
 * Maps to internal normalization mode + currency combination.
 */
type GqlNormalization = 'total' | 'total_euro' | 'per_capita' | 'per_capita_euro' | 'percent_gdp';

interface ExecutionLineItemsQueryArgs {
  filter: GraphQLAnalyticsFilterInput;
  sort?: {
    /** New format: field name */
    field?: string;
    /** Old format: field name (backward compatible) */
    by?: string;
    /** Sort order - accepts string for backward compatibility with old API */
    order?: string;
  };
  normalization?: GqlNormalization;
  limit?: number;
  offset?: number;
}

/**
 * GraphQL input for analytics filter (matches AnalyticsFilterInput schema).
 */
interface GraphQLAnalyticsFilterInput {
  account_category: 'vn' | 'ch';
  report_period: {
    type: 'MONTH' | 'QUARTER' | 'YEAR';
    selection: {
      interval?: {
        start: string;
        end: string;
      };
      dates?: string[];
    };
  };
  report_type?: string;
  main_creditor_cui?: string;
  report_ids?: string[];
  entity_cuis?: string[];
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_ids?: string[];
  budget_sector_ids?: string[];
  expense_types?: string[];
  program_codes?: string[];
  county_codes?: string[];
  regions?: string[];
  uat_ids?: string[];
  entity_types?: string[];
  is_uat?: boolean;
  search?: string;
  min_population?: number;
  max_population?: number;
  aggregate_min_amount?: number;
  aggregate_max_amount?: number;
  normalization?: string;
  inflation_adjusted?: boolean;
  currency?: string;
  show_period_growth?: boolean;
  item_min_amount?: number;
  item_max_amount?: number;
  exclude?: {
    report_ids?: string[];
    entity_cuis?: string[];
    main_creditor_cui?: string;
    functional_codes?: string[];
    functional_prefixes?: string[];
    economic_codes?: string[];
    economic_prefixes?: string[];
    funding_source_ids?: string[];
    budget_sector_ids?: string[];
    expense_types?: string[];
    program_codes?: string[];
    county_codes?: string[];
    regions?: string[];
    uat_ids?: string[];
    entity_types?: string[];
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Map GraphQL period type to domain Frequency enum.
 */
const mapPeriodType = (type: 'MONTH' | 'QUARTER' | 'YEAR'): Frequency => {
  switch (type) {
    case 'MONTH':
      return Frequency.MONTH;
    case 'QUARTER':
      return Frequency.QUARTER;
    case 'YEAR':
      return Frequency.YEAR;
  }
};

/**
 * Convert GraphQL filter input to domain filter.
 * Note: AnalyticsFilter keeps IDs as strings - repo does the conversion.
 */
const transformFilter = (input: GraphQLAnalyticsFilterInput): AnalyticsFilter => {
  const frequency = mapPeriodType(input.report_period.type);

  // Cast to AnalyticsFilter to handle exactOptionalPropertyTypes
  // GraphQL input has all optional fields as potentially undefined
  return {
    account_category: input.account_category as AccountCategory,
    report_period: {
      type: frequency,
      selection:
        input.report_period.selection.interval !== undefined
          ? {
              interval: {
                start: input.report_period.selection.interval.start as PeriodDate,
                end: input.report_period.selection.interval.end as PeriodDate,
              },
            }
          : {
              dates: (input.report_period.selection.dates ?? []) as PeriodDate[],
            },
    },
    report_type: input.report_type,
    main_creditor_cui: input.main_creditor_cui,
    report_ids: input.report_ids,
    entity_cuis: input.entity_cuis,
    functional_codes: input.functional_codes,
    functional_prefixes: input.functional_prefixes,
    economic_codes: input.economic_codes,
    economic_prefixes: input.economic_prefixes,
    // Keep as string[] - repo does number conversion
    funding_source_ids: input.funding_source_ids,
    budget_sector_ids: input.budget_sector_ids,
    expense_types: input.expense_types as ExpenseType[] | undefined,
    program_codes: input.program_codes,
    county_codes: input.county_codes,
    regions: input.regions,
    uat_ids: input.uat_ids,
    entity_types: input.entity_types,
    is_uat: input.is_uat,
    search: input.search,
    min_population: input.min_population,
    max_population: input.max_population,
    aggregate_min_amount: input.aggregate_min_amount,
    aggregate_max_amount: input.aggregate_max_amount,
    item_min_amount: input.item_min_amount,
    item_max_amount: input.item_max_amount,
    exclude:
      input.exclude !== undefined
        ? ({
            report_ids: input.exclude.report_ids,
            entity_cuis: input.exclude.entity_cuis,
            main_creditor_cui: input.exclude.main_creditor_cui,
            functional_codes: input.exclude.functional_codes,
            functional_prefixes: input.exclude.functional_prefixes,
            economic_codes: input.exclude.economic_codes,
            economic_prefixes: input.exclude.economic_prefixes,
            // Keep as string[] - repo does number conversion
            funding_source_ids: input.exclude.funding_source_ids,
            budget_sector_ids: input.exclude.budget_sector_ids,
            expense_types: input.exclude.expense_types as ExpenseType[] | undefined,
            program_codes: input.exclude.program_codes,
            county_codes: input.exclude.county_codes,
            regions: input.exclude.regions,
            uat_ids: input.exclude.uat_ids,
            entity_types: input.exclude.entity_types,
          } as AnalyticsExclude)
        : undefined,
  } as AnalyticsFilter;
};

/**
 * Convert sort input from GraphQL to domain type.
 * Supports both new format (field) and old format (by) for backward compatibility.
 */
const transformSort = (
  sort: { field?: string; by?: string; order?: string } | undefined
): SortInput | undefined => {
  if (sort === undefined) {
    return undefined;
  }

  // Support both 'field' (new) and 'by' (old) property names
  const fieldName = sort.field ?? sort.by;
  if (fieldName === undefined) {
    return undefined; // Use case will apply default
  }

  // Validate field is in allowed list
  const isValidField = SORTABLE_FIELDS.includes(fieldName as SortableField);
  if (!isValidField) {
    return undefined; // Use case will apply default
  }

  // Normalize order value (old format uses string, new uses enum)
  const order = sort.order?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  return {
    field: fieldName as SortableField,
    order: order as SortOrder,
  };
};

/**
 * Convert domain ExecutionLineItem to GraphQL output format.
 * Converts Decimal amounts to numbers for GraphQL Float type.
 */
const toOutput = (item: ExecutionLineItem): ExecutionLineItemOutput => ({
  line_item_id: item.line_item_id,
  report_id: item.report_id,
  entity_cui: item.entity_cui,
  funding_source_id: item.funding_source_id,
  budget_sector_id: item.budget_sector_id,
  functional_code: item.functional_code,
  economic_code: item.economic_code,
  account_category: item.account_category,
  expense_type: item.expense_type,
  program_code: item.program_code,
  year: item.year,
  month: item.month,
  quarter: item.quarter,
  ytd_amount: item.ytd_amount.toNumber(),
  monthly_amount: item.monthly_amount.toNumber(),
  quarterly_amount: item.quarterly_amount !== null ? item.quarterly_amount.toNumber() : null,
  anomaly: item.anomaly,
});

// ============================================================================
// Normalization Helpers
// ============================================================================

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
 * Extracts year range from GraphQL filter input.
 */
const getYearRangeFromFilter = (filter: GraphQLAnalyticsFilterInput): [number, number] => {
  const selection = filter.report_period.selection;

  if (selection.interval !== undefined) {
    const startYear = parseInt(selection.interval.start.substring(0, 4), 10);
    const endYear = parseInt(selection.interval.end.substring(0, 4), 10);
    return [startYear, endYear];
  }

  const dates = selection.dates;
  if (dates !== undefined && dates.length > 0) {
    const years = dates.map((d) => parseInt(d.substring(0, 4), 10));
    return [Math.min(...years), Math.max(...years)];
  }

  const currentYear = new Date().getFullYear();
  return [currentYear, currentYear];
};

/**
 * Applies normalization to execution line items.
 * Note: per_capita normalization is not available at root query level
 * because we don't have entity context for population lookup.
 *
 * @param items - Raw line items
 * @param gqlNorm - GraphQL normalization mode
 * @param filter - Original filter (for year range)
 * @param normService - Normalization service
 * @returns Normalized items with string amounts
 */
const applyNormalizationToItems = async (
  items: ExecutionLineItem[],
  gqlNorm: GqlNormalization | undefined,
  filter: GraphQLAnalyticsFilterInput,
  normService: NormalizationService
): Promise<ExecutionLineItemOutput[]> => {
  if (items.length === 0) return [];

  // If no normalization needed, just convert
  if (gqlNorm === undefined || gqlNorm === 'total') {
    return items.map(toOutput);
  }

  // per_capita requires entity context which we don't have at root query level
  // Fall back to currency conversion only for per_capita modes
  const { normalization, currency } = parseGqlNormalization(gqlNorm);
  const [startYear, endYear] = getYearRangeFromFilter(filter);

  // Build transformation options
  // Note: per_capita without population is just currency conversion
  const options: TransformationOptions = {
    inflationAdjusted: false,
    currency,
    normalization: normalization === 'per_capita' ? 'total' : normalization,
    showPeriodGrowth: false,
  };

  const normalizedItems: ExecutionLineItemOutput[] = [];

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
    const normalizedYtd =
      ytdResult.isOk() && ytdResult.value.length > 0 && ytdResult.value[0] !== undefined
        ? ytdResult.value[0].y.toNumber()
        : item.ytd_amount.toNumber();
    const normalizedMonthly =
      monthlyResult.isOk() && monthlyResult.value.length > 0 && monthlyResult.value[0] !== undefined
        ? monthlyResult.value[0].y.toNumber()
        : item.monthly_amount.toNumber();

    normalizedItems.push({
      line_item_id: item.line_item_id,
      report_id: item.report_id,
      entity_cui: item.entity_cui,
      funding_source_id: item.funding_source_id,
      budget_sector_id: item.budget_sector_id,
      functional_code: item.functional_code,
      economic_code: item.economic_code,
      account_category: item.account_category,
      expense_type: item.expense_type,
      program_code: item.program_code,
      year: item.year,
      month: item.month,
      quarter: item.quarter,
      ytd_amount: normalizedYtd,
      monthly_amount: normalizedMonthly,
      quarterly_amount: normalizedQuarterly,
      anomaly: item.anomaly,
    });
  }

  return normalizedItems;
};

// ============================================================================
// Resolver Factory
// ============================================================================

/**
 * Creates GraphQL resolvers for execution line item queries.
 *
 * @param deps - Repository and normalization service dependencies
 * @returns Mercurius-compatible resolvers
 */
export const makeExecutionLineItemResolvers = (
  deps: MakeExecutionLineItemResolversDeps
): IResolvers => {
  const { executionLineItemRepo, normalizationService } = deps;

  return {
    Query: {
      /**
       * Get a single execution line item by ID.
       */
      executionLineItem: async (
        _parent: unknown,
        args: ExecutionLineItemQueryArgs,
        context: MercuriusContext
      ) => {
        const result = await getExecutionLineItem({ executionLineItemRepo }, args.id);

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, errorType: error.type, id: args.id },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        const item = result.value;
        return item !== null ? toOutput(item) : null;
      },

      /**
       * List execution line items with filtering, sorting, and pagination.
       * Supports normalization (EUR conversion, percent_gdp).
       * Note: per_capita normalization requires entity context and is only
       * available via Entity.executionLineItems.
       */
      executionLineItems: async (
        _parent: unknown,
        args: ExecutionLineItemsQueryArgs,
        context: MercuriusContext
      ) => {
        const filter = transformFilter(args.filter);
        const sort = transformSort(args.sort);

        const result = await listExecutionLineItems(
          { executionLineItemRepo },
          {
            filter,
            sort,
            limit: args.limit ?? DEFAULT_LIMIT,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            { err: error, errorType: error.type, filter: args.filter },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        const connection = result.value;

        // Apply normalization if requested
        const normalizedNodes = await applyNormalizationToItems(
          connection.nodes,
          args.normalization,
          args.filter,
          normalizationService
        );

        return {
          nodes: normalizedNodes,
          pageInfo: connection.pageInfo,
        };
      },
    },
    // Note: Nested field resolvers (report, entity, fundingSource, etc.)
    // are handled by Mercurius loaders - see loaders.ts
  };
};
