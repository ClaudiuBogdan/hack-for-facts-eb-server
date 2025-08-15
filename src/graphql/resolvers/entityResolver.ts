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
import { AnalyticsFilter } from "../../types";

interface GraphQLSortOrderInput {
  by: string;
  order: "ASC" | "DESC";
}

// GraphQL args expect the unified AnalyticsFilter shape
type GraphQLAnalyticsFilterInput = Partial<AnalyticsFilter>;

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
      parent: { cui: string },
      {
        filter = {},
        limit = 100,
        offset = 0,
        sort,
      }: {
        filter?: GraphQLAnalyticsFilterInput;
        limit?: number;
        offset?: number;
        sort?: ELISortOrderOption;
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
      return trends.map(t => ({ year: t.year, value: t.totalIncome }));
    },
    expenseTrend: async (parent: { cui: string }, { startYear, endYear }: { startYear: number; endYear: number }) => {
      const trends: YearlyFinancials[] = await executionLineItemRepository.getYearlyFinancialTrends(parent.cui, startYear, endYear);
      return trends.map(t => ({ year: t.year, value: t.totalExpenses }));
    },
    balanceTrend: async (parent: { cui: string }, { startYear, endYear }: { startYear: number; endYear: number }) => {
      const trends: YearlyFinancials[] = await executionLineItemRepository.getYearlyFinancialTrends(parent.cui, startYear, endYear);
      return trends.map(t => ({ year: t.year, value: t.budgetBalance }));
    },
  },
};
