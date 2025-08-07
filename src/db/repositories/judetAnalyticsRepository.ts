import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";

const cache = createCache<HeatmapJudetDataPoint_Repo[]>({ name: 'heatmap_judet' });

// This should be moved to a central types file, e.g. src/graphql/types/index.ts
export interface HeatmapFilterInput {
    functional_codes?: string[] | null;
    economic_codes?: string[] | null;
    account_categories: string[]; // Mandatory, and array ensured by GQL to be non-null, items non-null
    years: number[];             // Mandatory, and array ensured by GQL to be non-null, items non-null
    min_amount?: number | null;
    max_amount?: number | null;
    normalization?: 'total' | 'per-capita';
    min_population?: number | null;
    max_population?: number | null;
    county_codes?: string[] | null;
    regions?: string[] | null;
}

export interface HeatmapJudetDataPoint_GQL {
    county_code: string;
    county_name: string;
    amount: number;
    total_amount: number;
    per_capita_amount: number;
    county_population: number;
}

export interface HeatmapJudetDataPoint_Repo {
    county_code: string;
    county_name: string;
    county_population: number;
    amount: number;
    total_amount: number;
    per_capita_amount: number;
    county_entity_cui: string;
}

export const judetAnalyticsRepository = {
    async getHeatmapJudetData(
        filter: HeatmapFilterInput
    ): Promise<HeatmapJudetDataPoint_Repo[]> {
        const cacheKey = getCacheKey(filter);
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (filter.account_categories.length === 0) {
            throw new Error("Account categories array cannot be empty for heatmap data.");
        }
        conditions.push(`eli.account_category = ANY($${paramIndex++})`);
        params.push(filter.account_categories);

        if (filter.years.length === 0) {
            throw new Error("Years array cannot be empty for heatmap data.");
        }
        conditions.push(`eli.year = ANY($${paramIndex++})`);
        params.push(filter.years);

        if (filter.functional_codes && filter.functional_codes.length > 0) {
            conditions.push(`eli.functional_code = ANY($${paramIndex++})`);
            params.push(filter.functional_codes);
        }

        if (filter.economic_codes && filter.economic_codes.length > 0) {
            conditions.push(`eli.economic_code = ANY($${paramIndex++})`);
            params.push(filter.economic_codes);
        }

        if (filter.county_codes && filter.county_codes.length > 0) {
            conditions.push(`u.county_code = ANY($${paramIndex++})`);
            params.push(filter.county_codes);
        }

        const whereClause = `WHERE e.is_uat = TRUE AND ${conditions.join(" AND ")}`;

        // This expression identifies the population for a county's main administrative unit.
        // It includes a special case for Bucharest (county_code 'B' and siruta_code '179132')
        // and a general case for other counties.
        // The SIRUTA code is treated as text to match its likely data type in the DB.
        const countyPopulationExpression = `MAX(CASE
            WHEN u.county_code = 'B' AND u.siruta_code = '179132' THEN u.population
            WHEN u.siruta_code = u.county_code THEN u.population
            ELSE 0
        END)`;

        // This expression retrieves the CUI (as uat_code) for the county's main administrative unit,
        // also handling the Bucharest special case.
        const countyCuiExpression = `MAX(CASE
            WHEN u.county_code = 'B' AND u.siruta_code = '179132' THEN u.uat_code
            WHEN u.siruta_code = u.county_code THEN u.uat_code
            ELSE NULL
        END)`;

        const havingConditions: string[] = [];

        if (filter.min_population !== undefined && filter.min_population !== null) {
            havingConditions.push(`${countyPopulationExpression} >= $${paramIndex++}`);
            params.push(filter.min_population);
        }

        if (filter.max_population !== undefined && filter.max_population !== null) {
            havingConditions.push(`${countyPopulationExpression} <= $${paramIndex++}`);
            params.push(filter.max_population);
        }

        if (filter.min_amount !== undefined && filter.min_amount !== null) {
            const amountExpression = filter.normalization === 'per-capita' ? `SUM(eli.amount) / NULLIF(${countyPopulationExpression}, 0)` : 'SUM(eli.amount)';
            havingConditions.push(`${amountExpression} >= $${paramIndex++}`);
            params.push(filter.min_amount);
        }

        if (filter.max_amount !== undefined && filter.max_amount !== null) {
            const amountExpression = filter.normalization === 'per-capita' ? `SUM(eli.amount) / NULLIF(${countyPopulationExpression}, 0)` : 'SUM(eli.amount)';
            havingConditions.push(`${amountExpression} <= $${paramIndex++}`);
            params.push(filter.max_amount);
        }

        const havingClause = havingConditions.length > 0 ? `HAVING ${havingConditions.join(" AND ")}` : "";

        const queryString = `
            SELECT
                u.county_code,
                u.county_name,
                SUM(eli.amount) AS total_amount,
                ${countyPopulationExpression} AS county_population,
                ${countyCuiExpression} AS county_entity_cui
            FROM ExecutionLineItems eli
            JOIN Entities e ON eli.entity_cui = e.cui
            JOIN UATs u ON e.cui = u.uat_code
            ${whereClause}
            GROUP BY
                u.county_code,
                u.county_name
            ${havingClause}
            ORDER BY
                u.county_code;
        `;

        try {
            const result = await pool.query(queryString, params);

            const data = result.rows.map((row): HeatmapJudetDataPoint_Repo => {
                const totalAmount = parseFloat(row.total_amount || 0);
                const countyPopulation = parseInt(row.county_population, 10) || 0;

                const perCapitaAmount = countyPopulation === 0
                    ? 0
                    : totalAmount / countyPopulation;

                const amount = filter.normalization === 'per-capita' ? perCapitaAmount : totalAmount;

                return {
                    county_code: row.county_code,
                    county_name: row.county_name,
                    county_population: countyPopulation,
                    amount: amount,
                    total_amount: totalAmount,
                    per_capita_amount: perCapitaAmount,
                    county_entity_cui: row.county_entity_cui,
                }
            });
            cache.set(cacheKey, data);
            return data;
        } catch (error) {
            console.error("Error fetching heatmap judet data:", error);
            throw new Error("Database error while fetching heatmap judet data.");
        }
    },
};
