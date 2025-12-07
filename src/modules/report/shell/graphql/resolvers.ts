/**
 * Report Module GraphQL Resolvers
 *
 * Implements Query resolvers for Report data access.
 * Most Report type fields (entity, main_creditor, budgetSector) are resolved
 * via Mercurius loaders for N+1 prevention.
 */

import { Frequency } from '@/common/types/temporal.js';

import {
  DEFAULT_REPORT_ELI_LIMIT,
  type Report,
  type ReportFilter,
  type ReportSort,
  type GqlReportType,
} from '../../core/types.js';
import { getReport } from '../../core/usecases/get-report.js';
import { listReports } from '../../core/usecases/list-reports.js';

import type { ReportRepository } from '../../core/ports.js';
import type { PeriodDate, AnalyticsFilter } from '@/common/types/analytics.js';
import type {
  ExecutionLineItemRepository as ExecutionLineItemsModuleRepository,
  SortableField,
} from '@/modules/execution-line-items/index.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Input Types
// ─────────────────────────────────────────────────────────────────────────────

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

interface GqlSortOrder {
  by: string;
  order: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeReportResolversDeps {
  reportRepo: ReportRepository;
  executionLineItemRepo: ExecutionLineItemsModuleRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates GraphQL resolvers for the Report module.
 */
export const makeReportResolvers = (deps: MakeReportResolversDeps): IResolvers => {
  const { reportRepo, executionLineItemRepo } = deps;

  return {
    // ─────────────────────────────────────────────────────────────────────────
    // Query Resolvers
    // ─────────────────────────────────────────────────────────────────────────

    Query: {
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
        args: {
          filter?: GqlReportFilterInput;
          limit?: number;
          offset?: number;
          sort?: GqlSortOrder;
        },
        context: MercuriusContext
      ) => {
        const filter = mapGqlFilterToReportFilter(args.filter);
        const sort: ReportSort | undefined =
          args.sort !== undefined
            ? { by: args.sort.by, order: args.sort.order as 'ASC' | 'DESC' }
            : undefined;

        const result = await listReports(
          { reportRepo },
          {
            filter,
            sort,
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
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Report Type Resolvers
    // ─────────────────────────────────────────────────────────────────────────
    // Note: entity, main_creditor, and budgetSector are handled by Mercurius loaders

    Report: {
      // FIXME: Prod API returns report_date as Unix timestamp in milliseconds (as string).
      // GraphQL Date scalar was returning ISO strings by default.
      // Added explicit field resolver to match prod format.
      // The database stores dates without timezone, so we need to treat the date components
      // as UTC to match prod behavior (which returns UTC midnight timestamps).
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      report_date: (parent: Report): string => {
        // Get UTC timestamp from date components (treats date as UTC midnight)
        const d = parent.report_date;
        const utcTimestamp = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
        return utcTimestamp.toString();
      },

      // Note: report_type returns the DB value (Romanian string).
      // The EnumResolvers in common/resolvers.ts automatically maps it to
      // the GraphQL ReportType enum (PRINCIPAL_AGGREGATED, etc.)
      // eslint-disable-next-line @typescript-eslint/naming-convention -- GraphQL field name
      report_type: (parent: Report): string => {
        return parent.report_type;
      },

      // Execution line items relation (needs filtering args, so kept as resolver)
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
  };
};
