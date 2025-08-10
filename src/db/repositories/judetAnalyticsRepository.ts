import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter } from "../../types";

const cache = createCache<HeatmapJudetDataPoint_Repo[]>({ name: 'heatmap_judet', maxSize: 100 * 1024 * 1024, maxItems: 20000 });

// This should be moved to a central types file, e.g. src/graphql/types/index.ts
// Use AnalyticsFilter instead of legacy HeatmapFilterInput

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
        filter: AnalyticsFilter
    ): Promise<HeatmapJudetDataPoint_Repo[]> {
        const cacheKey = getCacheKey(filter);
        const cached = cache.get(cacheKey);
        if (cached) return cached;

        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;

        if (!filter.account_category) {
            throw new Error("account_category is required for heatmap data.");
        }
        conditions.push(`eli.account_category = $${paramIndex++}`);
        params.push(filter.account_category);

        if (!filter.years || filter.years.length === 0) {
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

        if (filter.functional_prefixes && filter.functional_prefixes.length > 0) {
            const patterns = filter.functional_prefixes.map((p) => `${p}%`);
            conditions.push(`eli.functional_code LIKE ANY($${paramIndex++})`);
            params.push(patterns);
        }

        if (filter.economic_prefixes && filter.economic_prefixes.length > 0) {
            const patterns = filter.economic_prefixes.map((p) => `${p}%`);
            conditions.push(`eli.economic_code LIKE ANY($${paramIndex++})`);
            params.push(patterns);
        }

        if (filter.county_codes && filter.county_codes.length > 0) {
            conditions.push(`u.county_code = ANY($${paramIndex++})`);
            params.push(filter.county_codes);
        }

        if (filter.regions && filter.regions.length > 0) {
            conditions.push(`u.region = ANY($${paramIndex++})`);
            params.push(filter.regions);
        }

        if (filter.uat_ids && filter.uat_ids.length > 0) {
            conditions.push(`u.id = ANY($${paramIndex++})`);
            params.push(filter.uat_ids);
        }

        if (filter.entity_cuis && filter.entity_cuis.length > 0) {
            conditions.push(`eli.entity_cui = ANY($${paramIndex++})`);
            params.push(filter.entity_cuis);
        }

        if (filter.funding_source_ids && filter.funding_source_ids.length > 0) {
            conditions.push(`eli.funding_source_id = ANY($${paramIndex++}::int[])`);
            params.push(filter.funding_source_ids);
        }

        if (filter.budget_sector_ids && filter.budget_sector_ids.length > 0) {
            conditions.push(`eli.budget_sector_id = ANY($${paramIndex++}::int[])`);
            params.push(filter.budget_sector_ids);
        }

        if (filter.expense_types && filter.expense_types.length > 0) {
            conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
            params.push(filter.expense_types);
        }

        if (filter.program_codes && filter.program_codes.length > 0) {
            conditions.push(`eli.program_code = ANY($${paramIndex++}::text[])`);
            params.push(filter.program_codes);
        }

        // Per-item thresholds
        if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
            conditions.push(`eli.amount >= $${paramIndex++}`);
            params.push(filter.item_min_amount);
        }
        if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
            conditions.push(`eli.amount <= $${paramIndex++}`);
            params.push(filter.item_max_amount);
        }

        let requireReportsJoin = false;
        if (filter.report_type) {
            requireReportsJoin = true;
            conditions.push(`eli.report_type = $${paramIndex++}`);
            params.push(filter.report_type);
        }

        if (filter.report_ids && filter.report_ids.length > 0) {
            conditions.push(`eli.report_id = ANY($${paramIndex++}::text[])`);
            params.push(filter.report_ids);
        }

        if (filter.reporting_years && filter.reporting_years.length > 0) {
            requireReportsJoin = true;
            conditions.push(`r.reporting_year = ANY($${paramIndex++}::int[])`);
            params.push(filter.reporting_years);
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
            havingConditions.push(`COALESCE(${countyPopulationExpression}, 0) >= $${paramIndex++}`);
            params.push(filter.min_population);
        }

        if (filter.max_population !== undefined && filter.max_population !== null) {
            havingConditions.push(`COALESCE(${countyPopulationExpression}, 0) <= $${paramIndex++}`);
            params.push(filter.max_population);
        }

        if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
            const amountExpression = filter.normalization === 'per_capita' ? `SUM(eli.amount) / NULLIF(COALESCE(${countyPopulationExpression}, 0), 0)` : 'SUM(eli.amount)';
            havingConditions.push(`${amountExpression} >= $${paramIndex++}`);
            params.push(filter.aggregate_min_amount);
        }

        if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
            const amountExpression = filter.normalization === 'per_capita' ? `SUM(eli.amount) / NULLIF(COALESCE(${countyPopulationExpression}, 0), 0)` : 'SUM(eli.amount)';
            havingConditions.push(`${amountExpression} <= $${paramIndex++}`);
            params.push(filter.aggregate_max_amount);
        }

        const havingClause = havingConditions.length > 0 ? `HAVING ${havingConditions.join(" AND ")}` : "";

        const reportsJoin = requireReportsJoin ? `JOIN Reports r ON eli.report_id = r.report_id` : "";
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
            ${reportsJoin}
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

                const amount = filter.normalization === 'per_capita' ? perCapitaAmount : totalAmount;

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
