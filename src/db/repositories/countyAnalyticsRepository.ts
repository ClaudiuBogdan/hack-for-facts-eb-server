import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter } from "../../types";
import { buildPeriodFilterSql, getAmountSqlFragments, getPeriodFlagCondition, getEurRateMap } from "./utils";

const cache = createCache<HeatmapCountyDataPoint_Repo[]>({ name: 'heatmap_county', maxSize: 100 * 1024 * 1024, maxItems: 20000 });

// This should be moved to a central types file, e.g. src/graphql/types/index.ts
// Use AnalyticsFilter instead of legacy HeatmapFilterInput

export interface HeatmapCountyDataPoint_GQL {
    county_code: string;
    county_name: string;
    amount: number;
    total_amount: number;
    per_capita_amount: number;
    county_population: number;
}

export interface HeatmapCountyDataPoint_Repo {
    county_code: string;
    county_name: string;
    county_population: number;
    amount: number;
    total_amount: number;
    per_capita_amount: number;
    county_entity_cui: string;
}

export const countyAnalyticsRepository = {
    async getHeatmapCountyData(
        filter: AnalyticsFilter
    ): Promise<HeatmapCountyDataPoint_Repo[]> {
        const cacheKey = getCacheKey(filter);
        const cached = await cache.get(cacheKey);
        if (cached) return cached;

        const normalization = filter.normalization ?? 'total';
        const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
        const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

        const conditions: string[] = [];
        const params: any[] = [];
        let paramIndex = 1;
        let requireEntitiesJoin = false;

        // CRITICAL: Add period flags FIRST to match index prefix (is_yearly, is_quarterly, ...)
        if (!filter.report_period) {
            throw new Error("report_period is required for heatmap data.");
        }

        const periodFlag = getPeriodFlagCondition(filter.report_period);
        if (periodFlag) {
            conditions.push(periodFlag);
        }

        // Add period filters for partition pruning (year/month/quarter)
        const { clause, values, nextParamIndex } = buildPeriodFilterSql(filter.report_period, paramIndex);
        if (clause) {
            conditions.push(clause);
            params.push(...values);
            paramIndex = nextParamIndex;
        }

        // Then account_category (next in index)
        if (!filter.account_category) {
            throw new Error("account_category is required for heatmap data.");
        }
        conditions.push(`eli.account_category = $${paramIndex++}`);
        params.push(filter.account_category);

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

        // County/region/UAT/population filters will be applied in the outer query after aggregation
        const postAggFilters: string[] = [];
        if (filter.county_codes && filter.county_codes.length > 0) {
            postAggFilters.push(`ci.county_code = ANY($${paramIndex++})`);
            params.push(filter.county_codes);
        }

        // Region and UAT ID filters need to be applied on the outer query
        // Note: These are kept separate and will be joined to UATs in the outer query
        const uatOuterConditions: string[] = [];
        if (filter.regions && filter.regions.length > 0) {
            uatOuterConditions.push(`u.region = ANY($${paramIndex++})`);
            params.push(filter.regions);
        }

        if (filter.uat_ids && filter.uat_ids.length > 0) {
            uatOuterConditions.push(`u.id = ANY($${paramIndex++})`);
            params.push(filter.uat_ids);
        }

        // Population filters applied after aggregation
        if (filter.min_population !== undefined && filter.min_population !== null) {
            postAggFilters.push(`COALESCE(ci.county_population, 0) >= $${paramIndex++}`);
            params.push(filter.min_population);
        }

        if (filter.max_population !== undefined && filter.max_population !== null) {
            postAggFilters.push(`COALESCE(ci.county_population, 0) <= $${paramIndex++}`);
            params.push(filter.max_population);
        }

        if (filter.entity_cuis && filter.entity_cuis.length > 0) {
            conditions.push(`eli.entity_cui = ANY($${paramIndex++})`);
            params.push(filter.entity_cuis);
        }

        if (filter.main_creditor_cui) {
            conditions.push(`eli.main_creditor_cui = $${paramIndex++}`);
            params.push(filter.main_creditor_cui);
        }

        if (filter.is_uat !== undefined) {
            conditions.push(`e.is_uat = $${paramIndex++}`);
            params.push(filter.is_uat);
            requireEntitiesJoin = true;
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
        const { itemColumn, sumExpression } = getAmountSqlFragments(filter.report_period, 'eli');
        if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
            conditions.push(`${itemColumn} >= $${paramIndex++}`);
            params.push(filter.item_min_amount);
        }
        if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
            conditions.push(`${itemColumn} <= $${paramIndex++}`);
            params.push(filter.item_max_amount);
        }

        let requireReportsJoin = false;
        if (filter.report_type) {
            conditions.push(`eli.report_type = $${paramIndex++}`);
            params.push(filter.report_type);
        }

        if (filter.report_ids && filter.report_ids.length > 0) {
            conditions.push(`eli.report_id = ANY($${paramIndex++}::text[])`);
            params.push(filter.report_ids);
        }

        // reporting_years deprecated; use report_period

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        // Build HAVING clause for aggregate amount filtering
        const havingConditions: string[] = [];
        if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
            havingConditions.push(`${sumExpression} >= $${paramIndex++}`);
            params.push(filter.aggregate_min_amount);
        }
        if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
            havingConditions.push(`${sumExpression} <= $${paramIndex++}`);
            params.push(filter.aggregate_max_amount);
        }
        const havingClause = havingConditions.length > 0 ? `HAVING ${havingConditions.join(" AND ")}` : "";

        // Optimized query structure: Filter ExecutionLineItems first, then join to UATs and aggregate by county
        const reportsJoin = requireReportsJoin ? `JOIN Reports r ON eli.report_id = r.report_id` : "";
        const entitiesJoin = requireEntitiesJoin ? `JOIN Entities e ON eli.entity_cui = e.cui` : "";

        const yearlySumExpression = getAmountSqlFragments(filter.report_period, 'eli').sumExpression;

        // Combine all outer filters (county, population, region, uat_ids)
        const allOuterFilters = [...postAggFilters, ...uatOuterConditions];
        const postAggWhereClause = allOuterFilters.length > 0 ? `AND ${allOuterFilters.join(" AND ")}` : "";

        const queryString = `
            WITH filtered_aggregates AS (
                SELECT
                    eli.entity_cui,
                    ${needsEuro ? 'eli.year,' : ''}
                    ${yearlySumExpression} AS total_amount
                FROM ExecutionLineItems eli
                ${entitiesJoin}
                ${reportsJoin}
                ${whereClause}
                GROUP BY eli.entity_cui${needsEuro ? ', eli.year' : ''}
                ${havingClause}
            ),
            county_info AS (
                SELECT
                    county_code,
                    county_name,
                    MAX(CASE
                        WHEN county_code = 'B' AND siruta_code = '179132' THEN population
                        WHEN siruta_code = county_code THEN population
                        ELSE 0
                    END) AS county_population,
                    MAX(CASE
                        WHEN county_code = 'B' AND siruta_code = '179132' THEN uat_code
                        WHEN siruta_code = county_code THEN uat_code
                        ELSE NULL
                    END) AS county_entity_cui
                FROM UATs
                GROUP BY county_code, county_name
            )
            SELECT
                ci.county_code,
                ci.county_name,
                COALESCE(SUM(fa.total_amount), 0) AS total_amount,
                ci.county_population,
                ci.county_entity_cui
                ${needsEuro ? ', fa.year' : ''}
            FROM county_info ci
            LEFT JOIN UATs u ON u.county_code = ci.county_code
            LEFT JOIN filtered_aggregates fa ON fa.entity_cui = u.uat_code
            WHERE 1=1 ${postAggWhereClause}
            GROUP BY ci.county_code, ci.county_name, ci.county_population, ci.county_entity_cui${needsEuro ? ', fa.year' : ''}
            ORDER BY ci.county_code;
        `;

        try {
            const result = await pool.query(queryString, params);

            let data: HeatmapCountyDataPoint_Repo[];

            if (needsEuro) {
                const rateByYear = getEurRateMap();
                const countyData = new Map<string, HeatmapCountyDataPoint_Repo>();

                for (const row of result.rows) {
                    const rate = rateByYear.get(row.year) || 1;
                    const euroAmount = parseFloat(row.total_amount) / rate;

                    let entry = countyData.get(row.county_code);
                    if (!entry) {
                        entry = {
                            county_code: row.county_code,
                            county_name: row.county_name,
                            county_population: row.county_population,
                            amount: 0,
                            total_amount: 0,
                            per_capita_amount: 0,
                            county_entity_cui: row.county_entity_cui,
                        };
                        countyData.set(row.county_code, entry);
                    }
                    entry.total_amount += euroAmount;
                }

                data = Array.from(countyData.values()).map(entry => {
                    const perCapitaAmount = entry.county_population > 0 ? entry.total_amount / entry.county_population : 0;
                    entry.amount = needsPerCapita ? perCapitaAmount : entry.total_amount;
                    entry.per_capita_amount = perCapitaAmount;
                    return entry;
                });
            } else {
                data = result.rows.map((row): HeatmapCountyDataPoint_Repo => {
                    const totalAmount = parseFloat(row.total_amount || 0);
                    const countyPopulation = parseInt(row.county_population, 10) || 0;
                    const perCapitaAmount = countyPopulation > 0 ? totalAmount / countyPopulation : 0;
                    const amount = needsPerCapita ? perCapitaAmount : totalAmount;

                    return {
                        county_code: row.county_code,
                        county_name: row.county_name,
                        county_population: countyPopulation,
                        amount: amount,
                        total_amount: totalAmount,
                        per_capita_amount: perCapitaAmount,
                        county_entity_cui: row.county_entity_cui,
                    };
                });
            }

            await cache.set(cacheKey, data);
            return data;
        } catch (error) {
            console.error("Error fetching heatmap county data:", error);
            throw new Error("Database error while fetching heatmap county data.");
        }
    },
};
