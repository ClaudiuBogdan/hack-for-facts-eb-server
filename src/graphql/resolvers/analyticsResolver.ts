import { HeatmapUATDataPoint_GQL, HeatmapUATDataPoint_Repo, uatAnalyticsRepository } from "../../db/repositories/uatAnalyticsRepository";
import { executionLineItemRepository, judetAnalyticsRepository, entityRepository } from '../../db/repositories';
import { GraphQLResolveInfo } from 'graphql';
import { HeatmapJudetDataPoint_GQL, HeatmapJudetDataPoint_Repo } from "../../db/repositories/judetAnalyticsRepository";
import { entityAnalyticsRepository } from "../../db/repositories";
import { AnalyticsFilter } from "../../types";


interface AnalyticsArgs {
  inputs: Array<{ filter: AnalyticsFilter; seriesId?: string }>;
}

export const analyticsResolver = {
  Query: {
    async heatmapUATData(
      _parent: any,
      args: { filter: AnalyticsFilter },
      _context: any,
      _info: any
    ): Promise<HeatmapUATDataPoint_GQL[]> { // Returns type matching GQL schema
      try {
        const repoData: HeatmapUATDataPoint_Repo[] = await uatAnalyticsRepository.getHeatmapData(args.filter as any);

        // Map repository data to GraphQL schema type (e.g., convert uat_id to string)
        let gqlData: HeatmapUATDataPoint_GQL[] = repoData.map(repoItem => ({
          ...repoItem,
          uat_id: String(repoItem.uat_id), // Convert number ID to string for GraphQL ID!
        }));
        return gqlData;
      } catch (error: any) {
        console.error("Error in heatmapUATData resolver:", error);
        if (error.message.includes("cannot be empty")) { // Check for validation errors from repo
          throw new Error(error.message); // Propagate validation errors
        }
        throw new Error("An error occurred while fetching heatmap data."); // Generic error
      }
    },
    async heatmapJudetData(
      _parent: any,
      args: { filter: AnalyticsFilter },
      _context: any,
      _info: any
    ): Promise<HeatmapJudetDataPoint_GQL[]> {
      try {
        const repoData = await judetAnalyticsRepository.getHeatmapJudetData(args.filter as any);
        return repoData.map(repoItem => ({
          ...repoItem,
        }));
      } catch (error: any) {
        console.error("Error in heatmapJudetData resolver:", error);
        if (error.message.includes("cannot be empty")) {
          throw new Error(error.message);
        }
        throw new Error("An error occurred while fetching heatmap judet data.");
      }
    },
    async executionAnalytics(_parent: unknown, args: AnalyticsArgs, _context: unknown, info: GraphQLResolveInfo) {
      const requestedFields: Set<string> = new Set();
      info.fieldNodes[0].selectionSet?.selections.forEach((selection: any) => {
        if (selection.kind === 'Field') requestedFields.add(selection.name.value);
      });
      return Promise.all(args.inputs.map(async (input) => {
        const result: { seriesId?: string; totalAmount?: number; unit?: string; yearlyTrend?: Array<{ year: number; totalAmount: number }> } = { seriesId: input.seriesId };
        if (requestedFields.has('totalAmount')) {
          result.totalAmount = await executionLineItemRepository.getTotalAmount(input.filter);
        }
        if (requestedFields.has('unit')) {
          result.unit = 'RON';
        }
        if (requestedFields.has('yearlyTrend')) {
          result.yearlyTrend = await executionLineItemRepository.getYearlyTrend(input.filter);
        }
        return result;
      }));
    },
    async entityAnalytics(
      _parent: unknown,
      args: { filter: AnalyticsFilter; sort?: { by: string; order: 'ASC' | 'DESC' }; limit?: number; offset?: number },
      _context: unknown,
      _info: GraphQLResolveInfo
    ) {
      const { rows, totalCount } = await entityAnalyticsRepository.getEntityAnalytics(args.filter as any, args.sort as any, args.limit, args.offset);
      return {
        nodes: rows,
        pageInfo: {
          totalCount,
          hasNextPage: (args.offset ?? 0) + (args.limit ?? 50) < totalCount,
          hasPreviousPage: (args.offset ?? 0) > 0,
        },
      };
    },
  },
  HeatmapJudetDataPoint: {
    county_entity: async (parent: HeatmapJudetDataPoint_Repo) => {
      if (!parent.county_entity_cui) {
        return null;
      }
      return entityRepository.getById(parent.county_entity_cui);
    },
  },
};