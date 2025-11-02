import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter } from "../../types";
import { buildPeriodFilterSql, getAmountSqlFragments, getPeriodFlagCondition, getEurRateMap } from "./utils";


export interface EntityAnalyticsSortOption {
  by:
  | "amount"
  | "total_amount"
  | "per_capita_amount"
  | "entity_name"
  | "entity_type"
  | "population"
  | "county_name"
  | "county_code";
  order: "ASC" | "DESC";
}

export interface EntityAnalyticsDataPoint_Repo {
  entity_cui: string;
  entity_name: string;
  entity_type: string | null;
  uat_id: number | null;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  total_amount: number;
  per_capita_amount: number; // we compute this value in the server to enable ordering by per_capita_amount with pagination
  amount: number; // equals total_amount or per_capita_amount depending on normalization
}

type EntityAnalyticsCache = { rows: EntityAnalyticsDataPoint_Repo[]; totalCount: number };
const cache = createCache<EntityAnalyticsCache>({
  name: "entity_analytics",
  maxSize: 300 * 1024 * 1024, // Entity analytics can be large; allow up to 300MB
  maxItems: 30000,
});

function buildEntityAnalyticsWhere(
  filter: AnalyticsFilter,
  initialParamIndex: number = 1
): {
  conditions: string[];
  values: any[];
  nextParamIndex: number;
  requireReportsJoin: boolean;
  requireEntitiesJoin: boolean;
  outerConditions: string[];
} {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = initialParamIndex;
  let requireReportsJoin = false;
  let requireEntitiesJoin = false;

  // CRITICAL: Add period flags FIRST to match index prefix (is_yearly, is_quarterly, ...)
  if (!filter.report_period) {
    throw new Error("report_period is required for entity analytics.");
  }

  if (!filter.report_type) {
    throw new Error("report_type is required for entity analytics.");
  }

  const periodFlag = getPeriodFlagCondition(filter.report_period);
  if (periodFlag) {
    conditions.push(periodFlag);
  }

  // Then add period filters (year/month/quarter) for partition pruning
  const { clause, values: v, nextParamIndex: nextParam } = buildPeriodFilterSql(filter.report_period, paramIndex);
  if (clause) {
    conditions.push(clause);
    values.push(...v);
    paramIndex = nextParam;
  }

  // Then account_category (next in index)
  if (!filter.account_category) {
    throw new Error("account_category is required for entity analytics.");
  }
  conditions.push(`eli.account_category = $${paramIndex++}`);
  values.push(filter.account_category);

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
  if (filter.main_creditor_cui) {
    conditions.push(`eli.main_creditor_cui = $${paramIndex++}`);
    values.push(filter.main_creditor_cui);
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
  // account_category already enforced above
  if (filter.expense_types?.length) {
    conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
    values.push(filter.expense_types);
  }
  if (filter.program_codes?.length) {
    conditions.push(`eli.program_code = ANY($${paramIndex++}::text[])`);
    values.push(filter.program_codes);
  }
  // reporting_years deprecated; use report_period

  // Per-item thresholds for entity analytics (applied before aggregation)
  const amountFragments = getAmountSqlFragments(filter.report_period, 'eli');
  if (filter.item_min_amount !== undefined && filter.item_min_amount !== null) {
    conditions.push(`${amountFragments.itemColumn} >= $${paramIndex++}`);
    values.push(filter.item_min_amount);
  }
  if (filter.item_max_amount !== undefined && filter.item_max_amount !== null) {
    conditions.push(`${amountFragments.itemColumn} <= $${paramIndex++}`);
    values.push(filter.item_max_amount);
  }

  // Exclusions (negative filters on ELI level)
  const { exclude } = filter
  if (exclude) {
    if (exclude.report_ids?.length) {
      conditions.push(`NOT (eli.report_id = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.report_ids);
    }
    if (exclude.entity_cuis?.length) {
      conditions.push(`NOT (eli.entity_cui = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.entity_cuis);
    }
    if (exclude.main_creditor_cui) {
      conditions.push(`eli.main_creditor_cui <> $${paramIndex++}`);
      values.push(exclude.main_creditor_cui);
    }
    if (exclude.funding_source_ids?.length) {
      conditions.push(`NOT (eli.funding_source_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.funding_source_ids);
    }
    if (exclude.budget_sector_ids?.length) {
      conditions.push(`NOT (eli.budget_sector_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.budget_sector_ids);
    }
    if (exclude.functional_codes?.length) {
      conditions.push(`NOT (eli.functional_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.functional_codes);
    }
    if (exclude.functional_prefixes?.length) {
      const patterns = exclude.functional_prefixes.map((p) => `${p}%`);
      conditions.push(`NOT (eli.functional_code LIKE ANY($${paramIndex++}::text[]))`);
      values.push(patterns);
    }
    if (exclude.economic_codes?.length) {
      conditions.push(`NOT (eli.economic_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.economic_codes);
    }
    if (exclude.economic_prefixes?.length) {
      const patterns = exclude.economic_prefixes.map((p) => `${p}%`);
      conditions.push(`NOT (eli.economic_code LIKE ANY($${paramIndex++}::text[]))`);
      values.push(patterns);
    }
    if (exclude.expense_types?.length) {
      conditions.push(`NOT (eli.expense_type = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.expense_types);
    }
    if (exclude.program_codes?.length) {
      conditions.push(`NOT (eli.program_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.program_codes);
    }
  }

  // Joined filters requiring Entities and/or UATs
  if (
    filter.entity_types?.length ||
    typeof filter.is_uat === "boolean" ||
    filter.uat_ids?.length ||
    filter.county_codes?.length ||
    filter.search ||
    (exclude && (exclude.entity_types?.length || exclude.uat_ids?.length))
  ) {
    // Prepare entity-level filters and record if we must join Entities in the CTE
    if (filter.entity_types?.length) {
      conditions.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
      values.push(filter.entity_types);
      requireEntitiesJoin = true;
    }
    if (typeof filter.is_uat === "boolean") {
      conditions.push(`e.is_uat = $${paramIndex++}`);
      values.push(filter.is_uat);
      requireEntitiesJoin = true;
    }
    if (filter.uat_ids?.length) {
      conditions.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
      values.push(filter.uat_ids);
      requireEntitiesJoin = true;
    }
    if (filter.search) {
      conditions.push(`e.name ILIKE $${paramIndex++}`);
      values.push(`%${filter.search}%`);
      requireEntitiesJoin = true;
    }
    if (exclude?.entity_types?.length) {
      conditions.push(`NOT (e.entity_type = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.entity_types);
      requireEntitiesJoin = true;
    }
    if (exclude?.uat_ids?.length) {
      conditions.push(`NOT (e.uat_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.uat_ids);
      requireEntitiesJoin = true;
    }
  }

  // Note: county_codes and population filters are moved to outer query
  // because they reference UATs table which is joined after the CTE
  const outerConditions: string[] = [];

  if (filter.county_codes?.length) {
    outerConditions.push(`u.county_code = ANY($${paramIndex++}::text[])`);
    values.push(filter.county_codes);
  }
  if (exclude?.county_codes?.length) {
    outerConditions.push(`NOT (u.county_code = ANY($${paramIndex++}::text[]))`);
    values.push(exclude.county_codes);
  }
  if (exclude?.regions?.length) {
    outerConditions.push(`NOT (u.region = ANY($${paramIndex++}::text[]))`);
    values.push(exclude.regions);
  }

  if (filter.min_population !== undefined && filter.min_population !== null) {
    outerConditions.push(`COALESCE(u.population, 0) >= $${paramIndex++}`);
    values.push(filter.min_population);
  }
  if (filter.max_population !== undefined && filter.max_population !== null) {
    outerConditions.push(`COALESCE(u.population, 0) <= $${paramIndex++}`);
    values.push(filter.max_population);
  }

  return {
    conditions,
    values,
    nextParamIndex: paramIndex,
    requireReportsJoin,
    requireEntitiesJoin,
    outerConditions,
  };
}

function toOrderBy(sort?: EntityAnalyticsSortOption | { by?: string; order?: string }): string {
  if (!sort || !sort.by) return " ORDER BY amount DESC, total_amount DESC";

  // Accept both snake_case and camelCase field names from clients
  const byMap: Record<string, string> = {
    amount: "amount",
    total_amount: "total_amount",
    totalAmount: "total_amount",
    per_capita_amount: "per_capita_amount",
    perCapitaAmount: "per_capita_amount",
    entity_name: "entity_name",
    entityName: "entity_name",
    entity_type: "entity_type",
    entityType: "entity_type",
    population: "population",
    county_name: "county_name",
    countyName: "county_name",
    county_code: "county_code",
    countyCode: "county_code",
  };

  const byKey = typeof (sort as any).by === "string" ? (sort as any).by : "amount";
  const by = byMap[byKey] ?? "amount";

  const rawOrder = (sort as any).order ?? "DESC";
  const orderUpper = String(rawOrder).toUpperCase();
  const order = orderUpper === "ASC" ? "ASC" : "DESC";

  return ` ORDER BY ${by} ${order}`;
}

export const entityAnalyticsRepository = {
  async getEntityAnalytics(
    filter: AnalyticsFilter,
    sort?: EntityAnalyticsSortOption,
    limit?: number,
    offset?: number
  ): Promise<{ rows: EntityAnalyticsDataPoint_Repo[]; totalCount: number }> {
    const cacheKey = getCacheKey({ filter, sort, limit, offset });
    const cached = await cache.get(cacheKey);
    if (cached) {
      // Return fully from cache if available (rows + totalCount)
      return { rows: cached.rows, totalCount: cached.totalCount };
    }

    const values: any[] = [];
    const {
      conditions,
      values: whereValues,
      nextParamIndex,
      requireReportsJoin,
      requireEntitiesJoin,
      outerConditions,
    } = buildEntityAnalyticsWhere(filter, 1);
    values.push(...whereValues);

    const needsEuro = filter.normalization === 'total_euro' || filter.normalization === 'per_capita_euro';
    const { itemColumn } = getAmountSqlFragments(filter.report_period, 'eli');

    let ratesCTE = '';
    let ratesJoin = '';
    if (needsEuro) {
        const rateMap = getEurRateMap();
        if (rateMap.size > 0) {
            const valuesList = Array.from(rateMap.entries())
                .map(([year, rate]) => `(${year}, ${rate})`)
                .join(', ');
            ratesCTE = `exchange_rates(year, rate) AS (VALUES ${valuesList}),`;
            ratesJoin = `LEFT JOIN exchange_rates er ON er.year = eli.year`;
        }
    }

    const whereClause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    let paramIndex = nextParamIndex;

    // Define expressions
    // Population rules:
    // - If the entity is a UAT (e.is_uat = TRUE), use that UAT's population (from the joined `u` row)
    // - If the entity is a county-level council (admin_county_council), use the county population
    //   Pre-computed in CTE for efficiency (avoid N+1 subqueries)
    // - Otherwise, population is NULL and per-capita is 0

    // Pre-compute county populations in a CTE for admin_county_council entities
    const countyPopCTE = `county_populations AS (
      SELECT
        county_code,
        MAX(CASE
          WHEN county_code = 'B' AND siruta_code = '179132' THEN population
          WHEN siruta_code = county_code THEN population
          ELSE 0
        END) AS county_population
      FROM UATs
      GROUP BY county_code
    )`;

    const populationExpr = `CASE
      WHEN e.is_uat = TRUE THEN u.population
      WHEN e.entity_type = 'admin_county_council' THEN COALESCE(cp.county_population, 0)
      ELSE NULL
    END`;

    const totalAmountExprRON = getAmountSqlFragments(filter.report_period, 'eli').sumExpression;
    const totalAmountExpr = needsEuro ? `COALESCE(SUM(${itemColumn} / COALESCE(er.rate, 1)), 0)` : totalAmountExprRON;

    const perCapitaSelectExpr = `COALESCE(fa.total_amount / NULLIF(${populationExpr}, 0), 0)`;
    const needsPerCapitaNormalization =
      filter.normalization === "per_capita" || filter.normalization === "per_capita_euro";
    const amountSelectExpr = needsPerCapitaNormalization ? perCapitaSelectExpr : "fa.total_amount";

    // For total-based normalization we can push aggregate thresholds into the CTE HAVING
    const havingParts: string[] = [];
    if (!needsPerCapitaNormalization) {
      if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
        havingParts.push(`${totalAmountExpr} >= $${paramIndex++}`);
        values.push(filter.aggregate_min_amount);
      }
      if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
        havingParts.push(`${totalAmountExpr} <= $${paramIndex++}`);
        values.push(filter.aggregate_max_amount);
      }
    } else {
      // For per-capita normalization we evaluate thresholds after joining population data
      if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
        outerConditions.push(`${amountSelectExpr} >= $${paramIndex++}`);
        values.push(filter.aggregate_min_amount);
      }
      if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
        outerConditions.push(`${amountSelectExpr} <= $${paramIndex++}`);
        values.push(filter.aggregate_max_amount);
      }
    }
    const havingClause = havingParts.length ? ` HAVING ${havingParts.join(" AND ")}` : "";

    const outerWhereClause = outerConditions.length ? ` WHERE ${outerConditions.join(" AND ")}` : "";

    // Optimized query structure: Filter ExecutionLineItems first in CTE, then join
    // This ensures we use the index on (is_yearly, is_quarterly, account_category, ...) efficiently
    const reportsJoin = requireReportsJoin ? " LEFT JOIN Reports r ON eli.report_id = r.report_id" : "";
    const entitiesJoin = requireEntitiesJoin ? " JOIN Entities e ON e.cui = eli.entity_cui" : "";

    // CTE: Pre-aggregate line items with optimal filtering + pre-compute county populations
    const cteQuery = `WITH ${ratesCTE} ${countyPopCTE}, filtered_aggregates AS (
      SELECT
        eli.entity_cui,
        ${totalAmountExpr} AS total_amount
      FROM ExecutionLineItems eli
      ${entitiesJoin}
      ${reportsJoin}
      ${ratesJoin}
      ${whereClause}
      GROUP BY eli.entity_cui
      ${havingClause}
    )`;

    const orderBy = toOrderBy(sort);

    // Main query: Join pre-filtered results with entity and UAT data
    const select = `SELECT
      e.cui AS entity_cui,
      e.name AS entity_name,
      e.entity_type AS entity_type,
      e.uat_id AS uat_id,
      u.county_code AS county_code,
      u.county_name AS county_name,
      ${populationExpr} AS population,
      fa.total_amount AS total_amount,
      ${perCapitaSelectExpr} AS per_capita_amount,
      ${amountSelectExpr} AS amount
    FROM filtered_aggregates fa
      JOIN Entities e ON fa.entity_cui = e.cui
      LEFT JOIN UATs u ON (u.id = e.uat_id OR u.uat_code = e.cui)
      LEFT JOIN county_populations cp ON u.county_code = cp.county_code
    ${outerWhereClause}`;

    const query = `${cteQuery}${select}${orderBy}`;

    // Count query (number of groups after HAVING) - reuses the filtered_aggregates CTE with outer filters
    const countSelect = `SELECT
      e.cui,
      u.county_code,
      u.population
    FROM filtered_aggregates fa
      JOIN Entities e ON fa.entity_cui = e.cui
      LEFT JOIN UATs u ON (u.id = e.uat_id OR u.uat_code = e.cui)
      LEFT JOIN county_populations cp ON u.county_code = cp.county_code
    ${outerWhereClause}`;

    const countQuery = `${cteQuery} SELECT COUNT(*) AS count FROM (${countSelect}) t`;

    const countResult = await pool.query(countQuery, values);
    const totalCount = parseInt(countResult.rows[0]?.count ?? "0", 10);

    let finalQuery = query;
    if (limit !== undefined) {
      finalQuery += ` LIMIT $${paramIndex++}`;
      values.push(limit);
    }
    if (offset !== undefined) {
      finalQuery += ` OFFSET $${paramIndex++}`;
      values.push(offset);
    }

    const result = await pool.query(finalQuery, values);

    const rows: EntityAnalyticsDataPoint_Repo[] = result.rows.map((row) => ({
      entity_cui: row.entity_cui,
      entity_name: row.entity_name,
      entity_type: row.entity_type ?? null,
      uat_id: row.uat_id !== null && row.uat_id !== undefined ? parseInt(row.uat_id, 10) : null,
      county_code: row.county_code ?? null,
      county_name: row.county_name ?? null,
      population: row.population !== null && row.population !== undefined ? parseInt(row.population, 10) : null,
      total_amount: parseFloat(row.total_amount ?? 0),
      per_capita_amount: parseFloat(row.per_capita_amount ?? 0),
      amount: parseFloat(row.amount ?? 0),
    }));

    // Cache rows and totalCount together
    await cache.set(cacheKey, { rows, totalCount });

    return { rows, totalCount };
  },
};
