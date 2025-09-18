import { HeatmapUATDataPoint_GQL, HeatmapUATDataPoint_Repo, uatAnalyticsRepository } from "../../db/repositories/uatAnalyticsRepository";
import { executionLineItemRepository, countyAnalyticsRepository, entityRepository } from '../../db/repositories';
import { GraphQLResolveInfo } from 'graphql';
import { HeatmapCountyDataPoint_GQL, HeatmapCountyDataPoint_Repo } from "../../db/repositories/countyAnalyticsRepository";
import { entityAnalyticsRepository } from "../../db/repositories";
import { AnalyticsFilter, AnalyticsSeries } from "../../types";
import { getNormalizationUnit } from "../../db/repositories/utils";


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
    async heatmapCountyData(
      _parent: any,
      args: { filter: AnalyticsFilter },
      _context: any,
      _info: any
    ): Promise<HeatmapCountyDataPoint_GQL[]> {
      try {
        const repoData = await countyAnalyticsRepository.getHeatmapCountyData(args.filter as any);
        return repoData.map(repoItem => ({
          ...repoItem,
        }));
      } catch (error: any) {
        console.error("Error in heatmapCountyData resolver:", error);
        if (error.message.includes("cannot be empty")) {
          throw new Error(error.message);
        }
        throw new Error("An error occurred while fetching heatmap county data.");
      }
    },
    async executionAnalytics(_parent: unknown, args: AnalyticsArgs, _context: unknown, info: GraphQLResolveInfo) {
      const requestedFields: Set<string> = new Set();
      info.fieldNodes[0].selectionSet?.selections.forEach((selection: any) => {
        if (selection.kind === 'Field') requestedFields.add(selection.name.value);
      });
      return Promise.all(args.inputs.map(async (input) => {
        const unit = getNormalizationUnit(input.filter.normalization);
        const type = input.filter.report_period?.type;

        if (type === 'MONTH') {
          const monthly = await executionLineItemRepository.getMonthlyTrend(input.filter);
          const series: AnalyticsSeries = {
            seriesId: input.seriesId ?? 'series',
            xAxis: { name: 'Month', type: 'STRING', unit: 'month' },
            yAxis: { name: 'Amount', type: 'FLOAT', unit },
            data: monthly.map(p => ({ x: `${p.year}-${String(p.month).padStart(2, '0')}`, y: p.value })),
          };
          return series;
        }

        if (type === 'QUARTER') {
          const quarterly = await executionLineItemRepository.getQuarterlyTrend(input.filter);
          const series: AnalyticsSeries = {
            seriesId: input.seriesId ?? 'series',
            xAxis: { name: 'Quarter', type: 'STRING', unit: 'quarter' },
            yAxis: { name: 'Amount', type: 'FLOAT', unit },
            data: quarterly.map(p => ({ x: `${p.year}-Q${p.quarter}`, y: p.value })),
          };
          return series;
        }

        // Default: yearly
        const yearly = await executionLineItemRepository.getYearlyTrend(input.filter);
        const series: AnalyticsSeries = {
          seriesId: input.seriesId ?? 'series',
          xAxis: { name: 'Year', type: 'INTEGER', unit: 'year' },
          yAxis: { name: 'Amount', type: 'FLOAT', unit },
          data: yearly.map(p => ({ x: String(p.year), y: p.value })),
        };
        return series;
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
  HeatmapCountyDataPoint: {
    county_entity: async (parent: HeatmapCountyDataPoint_Repo) => {
      if (!parent.county_entity_cui) {
        return null;
      }
      return entityRepository.getById(parent.county_entity_cui);
    },
  },
};
