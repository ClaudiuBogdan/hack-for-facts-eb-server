import {
  entityRepository,
  reportRepository,
  uatRepository,
  executionLineItemRepository,
} from "../../db/repositories";
import { EntityFilter } from "../../db/repositories/entityRepository";
import { SortOrderOption as ELISortOrderOption } from "../../db/repositories/executionLineItemRepository";
import { SortOptions as ReportSortOptions } from "../../db/repositories/reportRepository";
import { YearlyFinancials } from "../../db/repositories/executionLineItemRepository";

interface GraphQLSortOrderInput {
  by: string;
  order: "ASC" | "DESC";
}

// Type for ExecutionLineItemFilter from GraphQL args
interface GraphQLExecutionLineItemFilterInput { 
  // Define fields based on ExecutionLineItemFilter in src/graphql/types/index.ts
  report_id?: number;
  report_ids?: number[];
  entity_cuis?: string[]; // This will be overridden by parent.cui
  funding_source_id?: number;
  functional_codes?: string[];
  economic_codes?: string[];
  account_categories?: string[];
  min_amount?: number;
  max_amount?: number;
  program_code?: string;
  reporting_year?: number;
  county_code?: string;
  uat_ids?: number[];
  year?: number;
  years?: number[];
  start_year?: number;
  end_year?: number;
  search?: string;
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
      parent: { cui: string },
      {
        filter = {},
        limit = 100,
        offset = 0,
        sort,
      }: {
        filter?: GraphQLExecutionLineItemFilterInput;
        limit?: number;
        offset?: number;
        sort?: GraphQLSortOrderInput;
      }
    ) => {
      const combinedFilter: any = { ...filter, entity_cuis: [parent.cui] };

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
    totalIncome: async (parent: { cui: string }, { year }: { year: number }) => {
      const { totalIncome } = await executionLineItemRepository.getYearlySnapshotTotals(parent.cui, year);
      return totalIncome;
    },
    totalExpenses: async (parent: { cui: string }, { year }: { year: number }) => {
      const { totalExpenses } = await executionLineItemRepository.getYearlySnapshotTotals(parent.cui, year);
      return totalExpenses;
    },
    budgetBalance: async (parent: { cui: string }, { year }: { year: number }, context: any, info: any) => {

      const income = await entityResolver.Entity.totalIncome(parent, { year });
      const expenses = await entityResolver.Entity.totalExpenses(parent, { year });
      if (income !== null && expenses !== null) {
        return income - expenses;
      }
      return null;
    },
    incomeTrend: async (parent: { cui: string }, { startYear, endYear }: { startYear: number; endYear: number }) => {
      const trends: YearlyFinancials[] = await executionLineItemRepository.getYearlyFinancialTrends(parent.cui, startYear, endYear);
      return trends.map(t => ({ year: t.year, totalAmount: t.totalIncome }));
    },
    expenseTrend: async (parent: { cui: string }, { startYear, endYear }: { startYear: number; endYear: number }) => {
      const trends: YearlyFinancials[] = await executionLineItemRepository.getYearlyFinancialTrends(parent.cui, startYear, endYear);
      return trends.map(t => ({ year: t.year, totalAmount: t.totalExpenses }));
    },
    balanceTrend: async (parent: { cui: string }, { startYear, endYear }: { startYear: number; endYear: number }) => {
      const trends: YearlyFinancials[] = await executionLineItemRepository.getYearlyFinancialTrends(parent.cui, startYear, endYear);
      return trends.map(t => ({ year: t.year, totalAmount: t.budgetBalance }));
    },
  },
};
