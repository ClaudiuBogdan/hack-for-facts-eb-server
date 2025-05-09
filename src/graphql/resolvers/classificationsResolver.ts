import pool from "../../db/connection";
import {
  executionLineItemRepository,
  functionalClassificationRepository,
  economicClassificationRepository,
} from "../../db/repositories";
import { FunctionalClassificationFilter } from "../../db/repositories/functionalClassificationRepository";
import { EconomicClassificationFilter } from "../../db/repositories/economicClassificationRepository";

export const classificationsResolver = {
  Query: {
    // Functional Classification resolvers
    functionalClassification: async (_: any, { code }: { code: string }) => {
      const result = await pool.query(
        "SELECT * FROM FunctionalClassifications WHERE functional_code = $1",
        [code]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    functionalClassifications: async (
      _: any,
      {
        filter,
        limit = 10,
        offset = 0,
      }: {
        filter?: FunctionalClassificationFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        functionalClassificationRepository.getAll(filter, limit, offset),
        functionalClassificationRepository.count(filter),
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

    // Economic Classification resolvers
    economicClassification: async (_: any, { code }: { code: string }) => {
      const result = await pool.query(
        "SELECT * FROM EconomicClassifications WHERE economic_code = $1",
        [code]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    economicClassifications: async (
      _: any,
      {
        filter,
        limit = 10,
        offset = 0,
      }: {
        filter?: EconomicClassificationFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        economicClassificationRepository.getAll(filter, limit, offset),
        economicClassificationRepository.count(filter),
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

    // Funding Source resolvers
    fundingSource: async (_: any, { id }: { id: number }) => {
      const result = await pool.query(
        "SELECT * FROM FundingSources WHERE source_id = $1",
        [id]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    fundingSources: async () => {
      const result = await pool.query(
        "SELECT * FROM FundingSources ORDER BY source_id"
      );
      return result.rows;
    },
  },

  FunctionalClassification: {
    executionLineItems: async (
      parent: any,
      {
        limit = 100,
        offset = 0,
        reportId,
        accountCategory,
      }: {
        limit: number;
        offset: number;
        reportId?: number;
        accountCategory?: "vn" | "ch";
      }
    ) => {
      const filter: any = { functional_code: parent.functional_code };

      if (reportId) filter.report_id = reportId;
      if (accountCategory) filter.account_category = accountCategory;

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
  },

  EconomicClassification: {
    executionLineItems: async (
      parent: any,
      {
        limit = 100,
        offset = 0,
        reportId,
        accountCategory,
      }: {
        limit: number;
        offset: number;
        reportId?: number;
        accountCategory?: "vn" | "ch";
      }
    ) => {
      const filter: any = { economic_code: parent.economic_code };

      if (reportId) filter.report_id = reportId;
      if (accountCategory) filter.account_category = accountCategory;

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
  },

  FundingSource: {
    executionLineItems: async (
      parent: any,
      {
        limit = 100,
        offset = 0,
        reportId,
        accountCategory,
      }: {
        limit: number;
        offset: number;
        reportId?: number;
        accountCategory?: "vn" | "ch";
      }
    ) => {
      const filter: any = { funding_source_id: parent.source_id };

      if (reportId) filter.report_id = reportId;
      if (accountCategory) filter.account_category = accountCategory;

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
  },
};
