import {
  executionLineItemRepository,
  fundingSourceRepository,
} from "../../db/repositories";
import { FundingSourceFilter } from "../../db/repositories/fundingSourceRepository";

export const fundingSourcesResolver = {
  Query: {
    fundingSource: async (_: any, { id }: { id: number }) => {
      return await fundingSourceRepository.getById(id);
    },
    fundingSources: async (
      _: any,
      {
        filter,
        limit = 10,
        offset = 0,
      }: {
        filter?: FundingSourceFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const [nodes, totalCount] = await Promise.all([
        fundingSourceRepository.getAll(filter, limit, offset),
        fundingSourceRepository.count(filter),
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
