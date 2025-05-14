import { analyticsRepository } from "../../db/repositories/analyticsRepository";

interface HeatmapFilterInput {
    functional_codes?: string[] | null;
    economic_codes?: string[] | null;
    account_categories: string[];
    years: number[];
    min_amount?: number | null;
    max_amount?: number | null;
    normalization?: 'total' | 'per-capita';
    min_population?: number | null;
    max_population?: number | null;
}

interface HeatmapUATDataPoint_Repo {
    uat_id: number;
    uat_code: string;
    uat_name: string;
    county_code: string | null;
    county_name: string | null;
    population: number | null;
    aggregated_value: number;
}

// Type matching the GraphQL Schema for HeatmapUATDataPoint
interface HeatmapUATDataPoint_GQL {
    uat_id: string; // ID! is string in GraphQL
    uat_code: string;
    uat_name: string;
    county_code: string | null;
    county_name: string | null;
    population: number | null;
    aggregated_value: number; // Float! is number in JS/TS
}

export const analyticsResolver = {
    Query: {
        async heatmapUATData(
            _parent: any,
            args: { filter: HeatmapFilterInput },
            _context: any,
            _info: any
        ): Promise<HeatmapUATDataPoint_GQL[]> { // Returns type matching GQL schema
            try {
                const repoData: HeatmapUATDataPoint_Repo[] = await analyticsRepository.getHeatmapData(args.filter);

                // Map repository data to GraphQL schema type (e.g., convert uat_id to string)
                let gqlData: HeatmapUATDataPoint_GQL[] = repoData.map(repoItem => ({
                    ...repoItem,
                    uat_id: String(repoItem.uat_id), // Convert number ID to string for GraphQL ID!
                }));

                // Apply normalization if specified
                if (args.filter.normalization === 'per-capita') {
                    gqlData = gqlData.map(item => {
                        if (item.population && item.population > 0) {
                            return {
                                ...item,
                                aggregated_value: item.aggregated_value / item.population,
                            };
                        }
                        // If population is null or 0, keep aggregated_value as is or handle as error/specific value
                        // For now, returning item as is, effectively making aggregated_value 0 or unchanged if not calculable
                        return item; 
                    });
                }

                return gqlData;
            } catch (error: any) {
                console.error("Error in heatmapUATData resolver:", error);
                if (error.message.includes("cannot be empty")) { // Check for validation errors from repo
                    throw new Error(error.message); // Propagate validation errors
                }
                throw new Error("An error occurred while fetching heatmap data."); // Generic error
            }
        },
    },
};