import {
  reportRepository,
  entityRepository,
  executionLineItemRepository,
} from "../../db/repositories";
import pool from "../../db/connection";

export const reportResolver = {
  Query: {
    report: async (_: any, { report_id }: { report_id: number }) => {
      return reportRepository.getById(report_id);
    },
    reports: async (
      _: any,
      {
        filter = {},
        limit = 20,
        offset = 0,
      }: {
        filter: any;
        limit: number;
        offset: number;
      }
    ) => {
      const [reports, totalCount] = await Promise.all([
        reportRepository.getAll(filter, limit, offset),
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
    entityBudgetTimeline: async (
      _: any,
      {
        cui,
        startYear,
        endYear,
      }: {
        cui: string;
        startYear?: number;
        endYear?: number;
      }
    ) => {
      const filter: any = { entity_cui: cui };

      if (startYear) {
        filter.report_date_start = new Date(startYear, 0, 1);
      }

      if (endYear) {
        filter.report_date_end = new Date(endYear, 11, 31);
      }

      const reports = await reportRepository.getAll(filter);
      return reports;
    },
  },
  Report: {
    entity: async (parent: any) => {
      return entityRepository.getById(parent.entity_cui);
    },
    executionLineItems: async (
      parent: any,
      {
        limit = 100,
        offset = 0,
        functionalCode,
        economicCode,
        accountCategory,
        minAmount,
        maxAmount,
      }: {
        limit: number;
        offset: number;
        functionalCode?: string;
        economicCode?: string;
        accountCategory?: "vn" | "ch";
        minAmount?: number;
        maxAmount?: number;
      }
    ) => {
      const filter: any = { report_id: parent.report_id };

      if (functionalCode) filter.functional_code = functionalCode;
      if (economicCode) filter.economic_code = economicCode;
      if (accountCategory) filter.account_category = accountCategory;
      if (minAmount !== undefined) filter.min_amount = minAmount;
      if (maxAmount !== undefined) filter.max_amount = maxAmount;

      const [lineItems, totalCount] = await Promise.all([
        executionLineItemRepository.getAll(filter, limit, offset),
        executionLineItemRepository.count(filter),
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
    budgetTotals: async (parent: any) => {
      const totals = await executionLineItemRepository.getTotalsByCategory(
        parent.report_id
      );

      // Initialize with zeros
      let revenue = 0;
      let expense = 0;

      // Sum up totals by category
      totals.forEach((item) => {
        if (item.account_category === "vn") {
          revenue =
            typeof item.total === "string"
              ? parseFloat(item.total)
              : item.total;
        } else if (item.account_category === "ch") {
          expense =
            typeof item.total === "string"
              ? parseFloat(item.total)
              : item.total;
        }
      });

      return {
        revenue,
        expense,
        balance: revenue - expense,
      };
    },
    topFunctionalCodesExpense: async (
      parent: any,
      { limit = 10 }: { limit: number }
    ) => {
      const topCodes = await executionLineItemRepository.getTopFunctionalCodes(
        parent.report_id,
        "ch",
        limit
      );

      // Get the total expense for percentage calculation
      const totals = await executionLineItemRepository.getTotalsByCategory(
        parent.report_id
      );
      const expenseItem = totals.find((t) => t.account_category === "ch");
      const totalExpense = expenseItem
        ? typeof expenseItem.total === "string"
          ? parseFloat(expenseItem.total)
          : expenseItem.total
        : 0;

      // Get all functional classifications for names
      const fcResult = await pool.query(
        "SELECT * FROM FunctionalClassifications"
      );
      const functionalClassifications = fcResult.rows.reduce(
        (acc: any, fc: any) => {
          acc[fc.functional_code] = fc.functional_name;
          return acc;
        },
        {}
      );

      // Calculate percentages and add names
      return topCodes.map((code) => ({
        functional_code: code.functional_code,
        functional_name:
          functionalClassifications[code.functional_code] || "Unknown",
        total:
          typeof code.total === "string" ? parseFloat(code.total) : code.total,
        percentage:
          totalExpense > 0
            ? ((typeof code.total === "string"
                ? parseFloat(code.total)
                : code.total) /
                totalExpense) *
              100
            : 0,
      }));
    },
    topFunctionalCodesRevenue: async (
      parent: any,
      { limit = 10 }: { limit: number }
    ) => {
      const topCodes = await executionLineItemRepository.getTopFunctionalCodes(
        parent.report_id,
        "vn",
        limit
      );

      // Get the total revenue for percentage calculation
      const totals = await executionLineItemRepository.getTotalsByCategory(
        parent.report_id
      );
      const revenueItem = totals.find((t) => t.account_category === "vn");
      const totalRevenue = revenueItem
        ? typeof revenueItem.total === "string"
          ? parseFloat(revenueItem.total)
          : revenueItem.total
        : 0;

      // Get all functional classifications for names
      const fcResult = await pool.query(
        "SELECT * FROM FunctionalClassifications"
      );
      const functionalClassifications = fcResult.rows.reduce(
        (acc: any, fc: any) => {
          acc[fc.functional_code] = fc.functional_name;
          return acc;
        },
        {}
      );

      // Calculate percentages and add names
      return topCodes.map((code) => ({
        functional_code: code.functional_code,
        functional_name:
          functionalClassifications[code.functional_code] || "Unknown",
        total:
          typeof code.total === "string" ? parseFloat(code.total) : code.total,
        percentage:
          totalRevenue > 0
            ? ((typeof code.total === "string"
                ? parseFloat(code.total)
                : code.total) /
                totalRevenue) *
              100
            : 0,
      }));
    },
  },
};
