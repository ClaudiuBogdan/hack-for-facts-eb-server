import { aggregatedLineItemsRepository } from "../../db/repositories";
import { AnalyticsFilter } from "../../types";

export const aggregatedLineItemsResolver = {
  Query: {
    aggregatedLineItems: async (
      _: any,
      {
        filter,
        limit = 50,
        offset = 0,
      }: {
        filter: AnalyticsFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const { rows, totalCount } = await aggregatedLineItemsRepository.getAggregatedLineItems(
        filter,
        limit,
        offset
      );

      return {
        nodes: rows,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
  },
};
