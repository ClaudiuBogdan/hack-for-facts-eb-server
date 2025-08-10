import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter, NormalizationMode } from "../../types";

const cache = createCache<HeatmapUATDataPoint_Repo[]>({ name: 'heatmap', maxSize: 150 * 1024 * 1024, maxItems: 30000 });

// Type matching the GraphQL Schema for HeatmapUATDataPoint
export interface HeatmapUATDataPoint_GQL {
  uat_id: string; // ID! is string in GraphQL
  uat_code: string;
  uat_name: string;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  total_amount: number; // Float! is number in JS/TS
  per_capita_amount: number;
}

export interface HeatmapUATDataPoint_Repo {
  uat_id: number;
  uat_code: string;
  uat_name: string;
  population: number;
  siruta_code: string;
  county_code: string | null;
  county_name: string | null;
  amount: number;
  total_amount: number;
  per_capita_amount: number;
}

// Use AnalyticsFilter instead of legacy HeatmapFilterInput

export const uatAnalyticsRepository = {
  async getHeatmapData(
    filter: AnalyticsFilter
  ): Promise<HeatmapUATDataPoint_Repo[]> {
    const cacheKey = getCacheKey(filter);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    let requireReportsJoin = false;

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

    if (filter.report_ids && filter.report_ids.length > 0) {
      conditions.push(`eli.report_id = ANY($${paramIndex++})`);
      params.push(filter.report_ids);
    }

    if (filter.report_type) {
      requireReportsJoin = true;
      conditions.push(`eli.report_type = $${paramIndex++}`);
      params.push(filter.report_type);
    }

    if (filter.reporting_years && filter.reporting_years.length > 0) {
      requireReportsJoin = true;
      conditions.push(`r.reporting_year = ANY($${paramIndex++})`);
      params.push(filter.reporting_years);
    }

    if (filter.entity_cuis && filter.entity_cuis.length > 0) {
      conditions.push(`eli.entity_cui = ANY($${paramIndex++})`);
      params.push(filter.entity_cuis);
    }

    if (filter.funding_source_ids && filter.funding_source_ids.length > 0) {
      conditions.push(`eli.funding_source_id = ANY($${paramIndex++})`);
      params.push(filter.funding_source_ids);
    }

    if (filter.budget_sector_ids && filter.budget_sector_ids.length > 0) {
      conditions.push(`eli.budget_sector_id = ANY($${paramIndex++})`);
      params.push(filter.budget_sector_ids);
    }

    if (filter.expense_types && filter.expense_types.length > 0) {
      conditions.push(`eli.expense_type = ANY($${paramIndex++})`);
      params.push(filter.expense_types);
    }

    if (filter.program_codes && filter.program_codes.length > 0) {
      conditions.push(`eli.program_code = ANY($${paramIndex++})`);
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

    // Add population filters to the WHERE clause targeting the UATs table
    if (filter.min_population !== undefined && filter.min_population !== null) {
      conditions.push(`COALESCE(u.population, 0) >= $${paramIndex++}`);
      params.push(filter.min_population);
    }

    if (filter.max_population !== undefined && filter.max_population !== null) {
      conditions.push(`COALESCE(u.population, 0) <= $${paramIndex++}`);
      params.push(filter.max_population);
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const havingConditions: string[] = [];
    if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
      const amountExpression = filter.normalization === 'per_capita' ? 'SUM(eli.amount) / NULLIF(COALESCE(u.population, 0), 0)' : 'SUM(eli.amount)';
      havingConditions.push(`${amountExpression} >= $${paramIndex++}`);
      params.push(filter.aggregate_min_amount);
    }

    if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
      const amountExpression = filter.normalization === 'per_capita' ? 'SUM(eli.amount) / NULLIF(COALESCE(u.population, 0), 0)' : 'SUM(eli.amount)';
      havingConditions.push(`${amountExpression} <= $${paramIndex++}`);
      params.push(filter.aggregate_max_amount);
    }
    const havingClause = havingConditions.length > 0 ? `HAVING ${havingConditions.join(" AND ")}` : "";

    const reportsJoin = requireReportsJoin ? `JOIN Reports r ON eli.report_id = r.report_id` : "";
    const queryString = `
      SELECT
        u.id AS uat_id,
        u.uat_code,
        u.siruta_code,
        u.name AS uat_name,
        u.county_code,
        u.county_name,
        u.population,
        SUM(eli.amount) AS total_amount
      FROM ExecutionLineItems eli
      JOIN Entities e ON eli.entity_cui = e.cui
      JOIN UATs u ON e.cui = u.uat_code
      ${reportsJoin}
      ${whereClause}
      GROUP BY
        u.id,
        u.uat_code,
        u.siruta_code,
        u.name,
        u.county_code,
        u.county_name,
        u.population
      ${havingClause}
      ORDER BY
        u.id;
    `;

    try {
      const result = await pool.query(queryString, params);

      const calculateValue = (value: string, population: number) => {
        const valueNumber = parseFloat(value);
        const den = population || 0;
        return den > 0 ? valueNumber / den : 0;
      };

      const data = result.rows.map((row): HeatmapUATDataPoint_Repo => {
        const perCapitaAmount = calculateValue(row.total_amount, row.population);
        const amount = filter.normalization === 'per_capita' ? perCapitaAmount : row.total_amount;
        return {
          uat_id: row.uat_id,
          uat_code: row.uat_code,
          uat_name: row.uat_name,
          population: row.population,
          siruta_code: row.siruta_code,
          county_code: row.county_code,
          county_name: row.county_name,
          amount: amount,
          total_amount: row.total_amount,
          per_capita_amount: perCapitaAmount,
        }
      });
      cache.set(cacheKey, data);
      return data;
    } catch (error) {
      console.error("Error fetching heatmap data:", error);
      // Consider re-throwing a more specific error or a custom error type
      throw new Error("Database error while fetching heatmap data.");
    }
  },
}; 