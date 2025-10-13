import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter, NormalizationMode } from "../../types";
import { buildPeriodFilterSql, getAmountSqlFragments, getPeriodFlagCondition, getEurRateMap } from "./utils";

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
    const cached = await cache.get(cacheKey);
    if (cached) return cached;

    const normalization = filter.normalization ?? 'total';
    const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
    const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;
    let requireReportsJoin = false;
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

    if (filter.report_ids && filter.report_ids.length > 0) {
      conditions.push(`eli.report_id = ANY($${paramIndex++})`);
      params.push(filter.report_ids);
    }

    if (filter.report_type) {
      conditions.push(`eli.report_type = $${paramIndex++}`);
      params.push(filter.report_type);
    }

    // reporting_years deprecated; use report_period

    if (filter.entity_cuis && filter.entity_cuis.length > 0) {
      conditions.push(`eli.entity_cui = ANY($${paramIndex++})`);
      params.push(filter.entity_cuis);
    }

    if (filter.is_uat !== undefined) {
      conditions.push(`e.is_uat = $${paramIndex++}`);
      params.push(filter.is_uat);
      requireEntitiesJoin = true;
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
    const { itemColumn, sumExpression } = getAmountSqlFragments(filter.report_period, 'eli');
    if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
      conditions.push(`${itemColumn} >= $${paramIndex++}`);
      params.push(filter.item_min_amount);
    }
    if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
      conditions.push(`${itemColumn} <= $${paramIndex++}`);
      params.push(filter.item_max_amount);
    }

    // UAT/population/county/region filters will be applied in outer query after JOIN
    const outerConditions: string[] = [];

    if (filter.min_population !== undefined && filter.min_population !== null) {
      outerConditions.push(`COALESCE(u.population, 0) >= $${paramIndex++}`);
      params.push(filter.min_population);
    }

    if (filter.max_population !== undefined && filter.max_population !== null) {
      outerConditions.push(`COALESCE(u.population, 0) <= $${paramIndex++}`);
      params.push(filter.max_population);
    }

    if (filter.county_codes && filter.county_codes.length > 0) {
      outerConditions.push(`u.county_code = ANY($${paramIndex++})`);
      params.push(filter.county_codes);
    }

    if (filter.regions && filter.regions.length > 0) {
      outerConditions.push(`u.region = ANY($${paramIndex++})`);
      params.push(filter.regions);
    }

    if (filter.uat_ids && filter.uat_ids.length > 0) {
      outerConditions.push(`u.id = ANY($${paramIndex++})`);
      params.push(filter.uat_ids);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const outerWhereClause = outerConditions.length > 0 ? `WHERE ${outerConditions.join(" AND ")}` : "";

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

    // Optimized query structure: Filter and aggregate ExecutionLineItems first in CTE
    const reportsJoin = requireReportsJoin ? `JOIN Reports r ON eli.report_id = r.report_id` : "";
    const entitiesJoin = requireEntitiesJoin ? `JOIN Entities e ON eli.entity_cui = e.cui` : "";

    const yearlySumExpression = getAmountSqlFragments(filter.report_period, 'eli').sumExpression;
    const finalSumExpression = needsEuro ? 'SUM(fa.total_amount)' : yearlySumExpression;

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
      )
      SELECT
        u.id AS uat_id,
        u.uat_code,
        u.siruta_code,
        u.name AS uat_name,
        u.county_code,
        u.county_name,
        u.population,
        fa.total_amount
        ${needsEuro ? ', fa.year' : ''}
      FROM filtered_aggregates fa
      JOIN UATs u ON fa.entity_cui = u.uat_code
      ${outerWhereClause}
      ORDER BY u.id;
    `;

    try {
      const result = await pool.query(queryString, params);
      
      let data: HeatmapUATDataPoint_Repo[];

      if (needsEuro) {
        const rateByYear = getEurRateMap();
        const uatData = new Map<number, HeatmapUATDataPoint_Repo>();

        for (const row of result.rows) {
          const rate = rateByYear.get(row.year) || 1;
          const euroAmount = parseFloat(row.total_amount) / rate;

          let entry = uatData.get(row.uat_id);
          if (!entry) {
            entry = {
              uat_id: row.uat_id,
              uat_code: row.uat_code,
              uat_name: row.uat_name,
              population: row.population,
              siruta_code: row.siruta_code,
              county_code: row.county_code,
              county_name: row.county_name,
              amount: 0,
              total_amount: 0,
              per_capita_amount: 0,
            };
            uatData.set(row.uat_id, entry);
          }
          entry.total_amount += euroAmount;
        }

        data = Array.from(uatData.values()).map(entry => {
          const perCapitaAmount = entry.population > 0 ? entry.total_amount / entry.population : 0;
          entry.amount = needsPerCapita ? perCapitaAmount : entry.total_amount;
          entry.per_capita_amount = perCapitaAmount;
          return entry;
        });
      } else {
        data = result.rows.map((row): HeatmapUATDataPoint_Repo => {
          const totalAmount = parseFloat(row.total_amount);
          const perCapitaAmount = row.population > 0 ? totalAmount / row.population : 0;
          const amount = needsPerCapita ? perCapitaAmount : totalAmount;
          return {
            uat_id: row.uat_id,
            uat_code: row.uat_code,
            uat_name: row.uat_name,
            population: row.population,
            siruta_code: row.siruta_code,
            county_code: row.county_code,
            county_name: row.county_name,
            amount: amount,
            total_amount: totalAmount,
            per_capita_amount: perCapitaAmount,
          };
        });
      }
      
      await cache.set(cacheKey, data);
      return data;
    } catch (error) {
      console.error("Error fetching heatmap data:", error);
      // Consider re-throwing a more specific error or a custom error type
      throw new Error("Database error while fetching heatmap data.");
    }
  },
}; 