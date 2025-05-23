import {
  executionLineItemRepository,
  reportRepository,
} from "../../db/repositories";
import pool from "../../db/connection";
import { ExecutionLineItemFilter, SortOrderOption } from "../../db/repositories/executionLineItemRepository";

export const executionLineItemResolver = {
  Query: {
    executionLineItem: async (_: any, { id }: { id: number }) => {
      return executionLineItemRepository.getById(id);
    },
    executionLineItems: async (
      _: any,
      {
        filter = {},
        sort,
        limit = 100,
        offset = 0,
      }: {
        filter?: ExecutionLineItemFilter;
        sort?: SortOrderOption;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        executionLineItemRepository.getAll(filter, sort, limit, offset),
        executionLineItemRepository.count(filter),
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
  ExecutionLineItem: {
    report: async (parent: any) => {
      return reportRepository.getById(parent.report_id);
    },
    entity: async (parent: any) => {
      if (!parent.entity_cui) return null;
      const { entityRepository } = await import("../../db/repositories");
      return entityRepository.getById(parent.entity_cui);
    },
    fundingSource: async (parent: any) => {
      const result = await pool.query(
        "SELECT * FROM FundingSources WHERE source_id = $1",
        [parent.funding_source_id]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    functionalClassification: async (parent: any) => {
      const result = await pool.query(
        "SELECT * FROM FunctionalClassifications WHERE functional_code = $1",
        [parent.functional_code]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    economicClassification: async (parent: any) => {
      if (!parent.economic_code) return null;

      const result = await pool.query(
        "SELECT * FROM EconomicClassifications WHERE economic_code = $1",
        [parent.economic_code]
      );
      return result.rows.length ? result.rows[0] : null;
    },
  },
};
