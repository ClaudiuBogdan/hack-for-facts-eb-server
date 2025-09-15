import {
  entityRepository,
  reportRepository,
  uatRepository,
  executionLineItemRepository,
} from "../../db/repositories";
import { EntityFilter } from "../../db/repositories/entityRepository";
import { SortOrderOption as ELISortOrderOption } from "../../db/repositories/executionLineItemRepository";
import { SortOptions as ReportSortOptions } from "../../db/repositories/reportRepository";
import { PeriodFinancials } from "../../db/repositories/executionLineItemRepository";
import { AnalyticsFilter, AnalyticsSeries, NormalizationMode, ReportPeriodInput, ReportPeriodType } from "../../types";
import { getNormalizationUnit } from "../../db/repositories/utils";

interface GraphQLSortOrderInput {
  by: string;
  order: "ASC" | "DESC";
}

// GraphQL args expect the unified AnalyticsFilter shape
type GraphQLAnalyticsFilterInput = Partial<AnalyticsFilter>;

// Removed per-parent caching; rely on repository-level cache for consistency.

function formatAsAnalyticsSeries(
  seriesId: string,
  trends: PeriodFinancials[],
  periodType: ReportPeriodType,
  valueKey: keyof PeriodFinancials,
  normalization: NormalizationMode,
): AnalyticsSeries {
  let xKey: keyof PeriodFinancials;
  let xAxisName: string;

  switch (periodType) {
    case 'YEAR':
      xKey = 'year';
      xAxisName = 'Year';
      break;
    case 'QUARTER':
      xKey = 'quarter';
      xAxisName = 'Quarter';
      break;
    case 'MONTH':
      xKey = 'month';
      xAxisName = 'Month';
      break;
  }

  return {
    seriesId,
    xAxis: { name: xAxisName, type: 'INTEGER', unit: '' },
    yAxis: { name: 'Amount', type: 'FLOAT', unit: getNormalizationUnit(normalization) },
    data: trends.map(t => ({ x: String(t[xKey]!), y: t[valueKey] as number })),
  };
}

export const entityResolver = {
  Query: {
    entity: async (_: any, { cui }: { cui: string }) => {
      return entityRepository.getById(cui);
    },
    entities: async (
      _: any,
      {
        filter = {},
        limit = 20,
        offset = 0,
      }: {
        filter?: EntityFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        entityRepository.getAll(filter, limit, offset),
        entityRepository.count(filter),
      ]);

      return {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
  },
  Entity: {
    uat: async (parent: any) => {
      if (!parent.uat_id) return null;
      return uatRepository.getById(parent.uat_id);
    },
    children: async (parent: any) => {
      return entityRepository.getChildren(parent.cui);
    },
    parents: async (parent: any) => {
      return entityRepository.getParents(parent.cui);
    },
    reports: async (
      parent: any,
      {
        limit = 10,
        offset = 0,
        year,
        period,
        sort,
      }: {
        limit: number;
        offset: number;
        year?: number;
        period?: string;
        sort?: GraphQLSortOrderInput;
      }
    ) => {
      const filter: any = { entity_cui: parent.cui };

      if (year) filter.reporting_year = year;
      if (period) filter.reporting_period = period;

      // Map GraphQLSortOrderInput to ReportSortOptions if necessary, or ensure they are compatible
      // In this case, they are compatible.
      const reportSortOptions: ReportSortOptions | undefined = sort;

      const [reports, totalCount] = await Promise.all([
        reportRepository.getAll(filter, limit, offset, reportSortOptions),
        reportRepository.count(filter),
      ]);

      return {
        nodes: reports,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
    executionLineItems: async (
      parent: { cui: string, default_report_type: string },
      {
        filter = {},
        limit = 10000,
        offset = 0,
        sort,
      }: {
        filter?: GraphQLAnalyticsFilterInput;
        limit?: number;
        offset?: number;
        sort?: ELISortOrderOption;
      }
    ) => {
      const combinedFilter: any = {
        ...filter,
        report_type: filter.report_type ?? parent.default_report_type,
        entity_cuis: [parent.cui]
      }

      const eliSortOption: ELISortOrderOption | undefined = sort;

      const [lineItems, totalCount] = await Promise.all([
        executionLineItemRepository.getAll(combinedFilter, eliSortOption, limit, offset),
        executionLineItemRepository.count(combinedFilter),
      ]);

      return {
        nodes: lineItems,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
    totalIncome: async (parent: { cui: string, default_report_type: string }, { period, reportType, normalization }: { period: ReportPeriodInput, reportType?: string, normalization?: NormalizationMode }) => {
      const rt = reportType ?? parent.default_report_type;
      const { totalIncome } = await executionLineItemRepository.getPeriodSnapshotTotals(parent.cui, period, rt, normalization);
      return totalIncome;
    },
    totalExpenses: async (parent: { cui: string, default_report_type: string }, { period, reportType, normalization }: { period: ReportPeriodInput, reportType?: string, normalization?: NormalizationMode }) => {
      const rt = reportType ?? parent.default_report_type;
      const { totalExpenses } = await executionLineItemRepository.getPeriodSnapshotTotals(parent.cui, period, rt, normalization);
      return totalExpenses;
    },
    budgetBalance: async (parent: { cui: string, default_report_type: string }, { period, reportType, normalization }: { period: ReportPeriodInput, reportType?: string, normalization?: NormalizationMode }) => {
      const rt = reportType ?? parent.default_report_type;
      const { budgetBalance } = await executionLineItemRepository.getPeriodSnapshotTotals(parent.cui, period, rt, normalization);
      return budgetBalance;
    },
    incomeTrend: async (parent: { cui: string, default_report_type: string }, { period, reportType, normalization }: { period: ReportPeriodInput, reportType?: string, normalization: NormalizationMode }): Promise<AnalyticsSeries> => {
      const rt = reportType ?? parent.default_report_type;
      const mode = normalization ?? 'total';
      const trends = await executionLineItemRepository.getFinancialTrends(parent.cui, rt, period, mode);
      return formatAsAnalyticsSeries('income', trends, period.type, 'totalIncome', mode);
    },
    expensesTrend: async (parent: { cui: string, default_report_type: string }, { period, reportType, normalization }: { period: ReportPeriodInput, reportType?: string, normalization: NormalizationMode }): Promise<AnalyticsSeries> => {
      const rt = reportType ?? parent.default_report_type;
      const mode = normalization ?? 'total';
      const trends = await executionLineItemRepository.getFinancialTrends(parent.cui, rt, period, mode);
      return formatAsAnalyticsSeries('expenses', trends, period.type, 'totalExpenses', mode);
    },
    balanceTrend: async (parent: { cui: string, default_report_type: string }, { period, reportType, normalization }: { period: ReportPeriodInput, reportType?: string, normalization: NormalizationMode }): Promise<AnalyticsSeries> => {
      const rt = reportType ?? parent.default_report_type;
      const mode = normalization ?? 'total';
      const trends = await executionLineItemRepository.getFinancialTrends(parent.cui, rt, period, mode);
      return formatAsAnalyticsSeries('balance', trends, period.type, 'budgetBalance', mode);
    },
  },
};
