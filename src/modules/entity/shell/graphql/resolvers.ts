/**
 * Entity Module GraphQL Resolvers
 *
 * Implements Query and Entity type resolvers.
 */

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
  NormalizationMode,
  PeriodSelection,
} from '@/common/types/analytics.js';
import type { BudgetSectorRepository } from '@/modules/budget-sector/index.js';
import type {
  ExecutionLineItemRepository as ExecutionLineItemsModuleRepository,
  SortableField,
} from '@/modules/execution-line-items/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

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

/** Map DB ReportType to GraphQL value */
const DB_TO_GQL_REPORT_TYPE_MAP: Record<DbReportType, GqlReportType> = {
  'Executie bugetara agregata la nivel de ordonator principal': 'PRINCIPAL_AGGREGATED',
  'Executie bugetara agregata la nivel de ordonator secundar': 'SECONDARY_AGGREGATED',
  'Executie bugetara detaliata': 'DETAILED',
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
  frequency: mapPeriodTypeToFrequency(gqlPeriod.type),
  selection: gqlPeriod.selection as unknown as PeriodSelection,
});

/**
 * Gets the DB report type from parent entity or GraphQL arg.
 */
const getDbReportType = (parent: Entity, gqlReportType?: GqlReportType): string => {
  if (gqlReportType !== undefined) {
    return GQL_TO_DB_REPORT_TYPE_MAP[gqlReportType];
  }
  return parent.default_report_type;
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
    // Reserved for future normalization support
    // normalizationService,
  } = deps;
  void deps.normalizationService; // Suppress unused warning

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
      // Map default_report_type to GraphQL enum
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      default_report_type: (parent: Entity): GqlReportType => {
        return DB_TO_GQL_REPORT_TYPE_MAP[parent.default_report_type];
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
          sort?: { field: string; order: string };
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

        const sort =
          args.sort !== undefined
            ? { field: args.sort.field as SortableField, order: args.sort.order as 'ASC' | 'DESC' }
            : { field: 'year' as SortableField, order: 'DESC' as const };

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

        return result.value;
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Analytics - Totals
      // ─────────────────────────────────────────────────────────────────────────

      totalIncome: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: NormalizationMode;
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

        return result.value.totalIncome;
      },

      totalExpenses: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: NormalizationMode;
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

        return result.value.totalExpenses;
      },

      budgetBalance: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: NormalizationMode;
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

        return result.value.budgetBalance;
      },

      // ─────────────────────────────────────────────────────────────────────────
      // Analytics - Trends
      // ─────────────────────────────────────────────────────────────────────────

      incomeTrend: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: NormalizationMode;
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

        // Convert to AnalyticsSeries format
        return {
          seriesId: `${parent.cui}_income_trend`,
          xAxis: {
            name: period.frequency,
            type: 'DATE',
            unit: period.frequency,
          },
          yAxis: {
            name: 'Income',
            type: 'FLOAT',
            unit: args.normalization ?? 'total',
          },
          data: result.value.data.map((point) => ({
            x: point.date,
            y: point.value.toNumber(),
          })),
        };
      },

      expensesTrend: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: NormalizationMode;
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

        return {
          seriesId: `${parent.cui}_expenses_trend`,
          xAxis: {
            name: period.frequency,
            type: 'DATE',
            unit: period.frequency,
          },
          yAxis: {
            name: 'Expenses',
            type: 'FLOAT',
            unit: args.normalization ?? 'total',
          },
          data: result.value.data.map((point) => ({
            x: point.date,
            y: point.value.toNumber(),
          })),
        };
      },

      balanceTrend: async (
        parent: Entity,
        args: {
          period: GqlReportPeriodInput;
          reportType?: GqlReportType;
          normalization?: NormalizationMode;
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

        return {
          seriesId: `${parent.cui}_balance_trend`,
          xAxis: {
            name: period.frequency,
            type: 'DATE',
            unit: period.frequency,
          },
          yAxis: {
            name: 'Balance',
            type: 'FLOAT',
            unit: args.normalization ?? 'total',
          },
          data: result.value.data.map((point) => ({
            x: point.date,
            y: point.value.toNumber(),
          })),
        };
      },
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Report Type Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    Report: {
      // Map report_type to GraphQL enum
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      report_type: (parent: Report): GqlReportType => {
        return DB_TO_GQL_REPORT_TYPE_MAP[parent.report_type];
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
            frequency: Frequency.YEAR,
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
      // County entity relation
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      county_entity: async (parent: UAT, _args: unknown, context: MercuriusContext) => {
        // County UAT identification:
        // - siruta_code = county_code, OR
        // - county_code = 'B' AND siruta_code = '179132' (Bucharest special case)
        const isCounty =
          parent.siruta_code === parent.county_code ||
          (parent.county_code === 'B' && parent.siruta_code === '179132');

        if (isCounty) {
          // This UAT is itself a county, no parent county
          return null;
        }

        // Find the county UAT for this UAT's county_code
        const result = await uatRepo.getAll(
          { is_county: true, county_code: parent.county_code },
          1,
          0
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, parent_id: parent.id },
            `[${result.error.type}] county_entity lookup failed`
          );
          return null;
        }

        return result.value.nodes[0] ?? null;
      },
    },
  };
};
