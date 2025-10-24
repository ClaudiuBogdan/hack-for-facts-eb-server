import {
  reportRepository,
  entityRepository,
  executionLineItemRepository,
  budgetSectorRepository,
} from "../../db/repositories";
import { ReportFilter } from "../../db/repositories/reportRepository";
import pool from "../../db/connection";

export const reportResolver = {
  Query: {
    report: async (_: any, { report_id }: { report_id: string }) => {
      return reportRepository.getById(report_id);
    },
    reports: async (
      _: any,
      {
        filter = {},
        limit = 20,
        offset = 0,
      }: {
        filter?: ReportFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        reportRepository.getAll(filter, limit, offset),
        reportRepository.count(filter),
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
  Report: {
    entity: async (parent: any) => {
      return entityRepository.getById(parent.entity_cui);
    },
    main_creditor: async (parent: any) => {
      return entityRepository.getById(parent.main_creditor_cui);
    },
    budgetSector: async (parent: any) => {
      return budgetSectorRepository.getById(parent.budget_sector_id);
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
        executionLineItemRepository.getAll(filter, undefined, limit, offset),
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
  },
};
