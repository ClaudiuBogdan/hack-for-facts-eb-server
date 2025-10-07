import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter } from "../../types";
import { buildPeriodFilterSql, getAmountSqlFragments } from "./utils";

// Fallback bucket for items missing an economic classification
const DEFAULT_ECONOMIC_CODE = "00.00.00";
const DEFAULT_ECONOMIC_NAME = "Unknown economic classification";

export interface AggregatedLineItem_Repo {
  functional_code: string;
  functional_name: string;
  economic_code: string;
  economic_name: string;
  amount: number;
  count: number;
}

const cache = createCache<AggregatedLineItem_Repo[]>({
  name: "aggregated_line_items",
  maxSize: 100 * 1024 * 1024,
  maxItems: 10000,
});

function buildWhereClause(
  filter: AnalyticsFilter,
  initialParamIndex: number = 1
): {
  conditions: string[];
  values: any[];
  nextParamIndex: number;
  requireEntitiesJoin: boolean;
  requireReportsJoin: boolean;
  requireUATsJoin: boolean;
} {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = initialParamIndex;
  let requireEntitiesJoin = false;
  let requireReportsJoin = false;
  let requireUATsJoin = false;

  // CRITICAL: Add period flags FIRST to match index prefix
  if (!filter.report_period) {
    throw new Error("report_period is required for analytics.");
  }

  // Add period flags (is_yearly/is_quarterly) first for index usage
  if (filter.report_period.type === 'YEAR') {
    conditions.push(`eli.is_yearly = true`);
  } else if (filter.report_period.type === 'QUARTER') {
    conditions.push(`eli.is_quarterly = true`);
  }

  // Then add period filters (year/month/quarter) for partition pruning
  const { clause, values: v, nextParamIndex: nextParam } = buildPeriodFilterSql(filter.report_period, paramIndex);
  if (clause) {
    conditions.push(clause);
    values.push(...v);
    paramIndex = nextParam;
  }

  if (filter.account_category) {
    conditions.push(`eli.account_category = $${paramIndex++}`);
    values.push(filter.account_category);
  }

  // Basic ELI filters
  if (filter.report_ids?.length) {
    conditions.push(`eli.report_id = ANY($${paramIndex++}::text[])`);
    values.push(filter.report_ids);
  }
  if (filter.report_type) {
    conditions.push(`eli.report_type = $${paramIndex++}`);
    values.push(filter.report_type);
  }
  if (filter.entity_cuis?.length) {
    conditions.push(`eli.entity_cui = ANY($${paramIndex++}::text[])`);
    values.push(filter.entity_cuis);
  }
  if (filter.funding_source_ids?.length) {
    conditions.push(`eli.funding_source_id = ANY($${paramIndex++}::int[])`);
    values.push(filter.funding_source_ids);
  }
  if (filter.budget_sector_ids?.length) {
    conditions.push(`eli.budget_sector_id = ANY($${paramIndex++}::int[])`);
    values.push(filter.budget_sector_ids);
  }
  if (filter.functional_codes?.length) {
    conditions.push(`eli.functional_code = ANY($${paramIndex++}::text[])`);
    values.push(filter.functional_codes);
  }
  if (filter.functional_prefixes?.length) {
    const patterns = filter.functional_prefixes.map((p) => `${p}%`);
    conditions.push(`eli.functional_code LIKE ANY($${paramIndex++}::text[])`);
    values.push(patterns);
  }
  if (filter.economic_codes?.length) {
    conditions.push(`eli.economic_code = ANY($${paramIndex++}::text[])`);
    values.push(filter.economic_codes);
  }
  if (filter.economic_prefixes?.length) {
    const patterns = filter.economic_prefixes.map((p) => `${p}%`);
    conditions.push(`eli.economic_code LIKE ANY($${paramIndex++}::text[])`);
    values.push(patterns);
  }
  if (filter.expense_types?.length) {
    conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
    values.push(filter.expense_types);
  }
  if (filter.program_codes?.length) {
    conditions.push(`eli.program_code = ANY($${paramIndex++}::text[])`);
    values.push(filter.program_codes);
  }
  // reporting_years deprecated; use report_period

  // Per-item thresholds - use correct amount column based on period type
  const { itemColumn } = getAmountSqlFragments(filter.report_period, 'eli');
  if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
    conditions.push(`${itemColumn} >= $${paramIndex++}`);
    values.push(filter.item_min_amount);
  }
  if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
    conditions.push(`${itemColumn} <= $${paramIndex++}`);
    values.push(filter.item_max_amount);
  }

  // Joined filters
  if (filter.entity_types?.length || typeof filter.is_uat === "boolean" || filter.uat_ids?.length || filter.search) {
    requireEntitiesJoin = true;
    if (filter.entity_types?.length) {
      conditions.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
      values.push(filter.entity_types);
    }
    if (typeof filter.is_uat === "boolean") {
      conditions.push(`e.is_uat = $${paramIndex++}`);
      values.push(filter.is_uat);
    }
    if (filter.uat_ids?.length) {
      conditions.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
      values.push(filter.uat_ids);
    }
    if (filter.search) {
      conditions.push(`e.name ILIKE $${paramIndex++}`);
      values.push(`%${filter.search}%`);
    }
  }

  if (filter.county_codes?.length || filter.min_population !== undefined || filter.max_population !== undefined) {
    requireUATsJoin = true;
    if (filter.county_codes?.length) {
      conditions.push(`u.county_code = ANY($${paramIndex++}::text[])`);
      values.push(filter.county_codes);
    }
    if (filter.min_population !== undefined && filter.min_population !== null) {
      conditions.push(`COALESCE(u.population, 0) >= $${paramIndex++}`);
      values.push(filter.min_population);
    }
    if (filter.max_population !== undefined && filter.max_population !== null) {
      conditions.push(`COALESCE(u.population, 0) <= $${paramIndex++}`);
      values.push(filter.max_population);
    }
  }

  if (requireUATsJoin) {
    requireEntitiesJoin = true;
  }

  return { conditions, values, nextParamIndex: paramIndex, requireEntitiesJoin, requireReportsJoin, requireUATsJoin };
}

export const aggregatedLineItemsRepository = {
  async getAggregatedLineItems(
    filter: AnalyticsFilter,
    limit?: number,
    offset?: number
  ): Promise<{ rows: AggregatedLineItem_Repo[]; totalCount: number }> {
    const cacheKey = getCacheKey({ filter, limit, offset });
    const cached = await cache.get(cacheKey);

    const values: any[] = [];
    const { conditions, values: filterValues, nextParamIndex, requireEntitiesJoin, requireReportsJoin, requireUATsJoin } = buildWhereClause(filter, 1);
    values.push(...filterValues);

    // Get the correct amount column based on period type
    const { sumExpression } = getAmountSqlFragments(filter.report_period, 'eli');

    const joins = [];
    if (requireReportsJoin) {
      joins.push("LEFT JOIN Reports r ON eli.report_id = r.report_id");
    }
    if (requireEntitiesJoin) {
      joins.push("JOIN Entities e ON eli.entity_cui = e.cui");
    }
    if (requireUATsJoin) {
      // Replace LATERAL join with standard join for better performance
      joins.push("LEFT JOIN UATs u ON (u.id = e.uat_id OR u.uat_code = e.cui)");
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const joinClause = joins.join("\n");

    const normalizedEconomicCodeExpr = `COALESCE(eli.economic_code, '${DEFAULT_ECONOMIC_CODE}')`;
    const normalizedEconomicNameExpr = `COALESCE(ec.economic_name, '${DEFAULT_ECONOMIC_NAME}')`;

    const baseQuery = `
      SELECT
        fc.functional_code,
        fc.functional_name,
        ${normalizedEconomicCodeExpr} AS economic_code,
        ${normalizedEconomicNameExpr} AS economic_name,
        ${sumExpression} AS amount,
        COUNT(eli.line_item_id) AS count
      FROM ExecutionLineItems eli
      JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
      LEFT JOIN EconomicClassifications ec ON ${normalizedEconomicCodeExpr} = ec.economic_code
      ${joinClause}
      ${whereClause}
      GROUP BY fc.functional_code, fc.functional_name, ${normalizedEconomicCodeExpr}, ${normalizedEconomicNameExpr}
    `;

    if (cached) {
      const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) as agg_count`;
      const countResult = await pool.query(countQuery, values);
      const totalCount = parseInt(countResult.rows[0]?.count ?? "0", 10);
      return { rows: cached, totalCount };
    }

    const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) as agg_count`;
    const countResult = await pool.query(countQuery, values);
    const totalCount = parseInt(countResult.rows[0]?.count ?? "0", 10);

    let finalQuery = `${baseQuery} ORDER BY amount DESC`;
    let paramIndex = nextParamIndex;

    if (limit !== undefined) {
      finalQuery += ` LIMIT $${paramIndex++}`;
      values.push(limit);
    }
    if (offset !== undefined) {
      finalQuery += ` OFFSET $${paramIndex++}`;
      values.push(offset);
    }

    const result = await pool.query(finalQuery, values);

    const rows: AggregatedLineItem_Repo[] = result.rows.map((row) => ({
      functional_code: row.functional_code,
      functional_name: row.functional_name,
      economic_code: row.economic_code,
      economic_name: row.economic_name,
      amount: parseFloat(row.amount ?? 0),
      count: parseInt(row.count ?? "0", 10),
    }));

    await cache.set(cacheKey, rows);

    return { rows, totalCount };
  },
};
