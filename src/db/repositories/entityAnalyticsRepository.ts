import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";

export type NormalizationMode = "total" | "per-capita";

export interface EntityAnalyticsFilter {
  // Aggregation scope
  account_category: ("vn" | "ch"); // required single
  years: number[]; // required

  // Execution line item filters
  report_id?: string;
  report_ids?: string[];
  report_type?: string;
  entity_cuis?: string[];
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  funding_source_id?: number;
  funding_source_ids?: number[];
  budget_sector_id?: number;
  budget_sector_ids?: number[];
  expense_types?: string[];
  program_code?: string;
  reporting_year?: number;
  county_code?: string;
  county_codes?: string[];
  uat_ids?: number[];
  year?: number; // ignored for aggregation, use years instead
  start_year?: number; // ignored for aggregation, use years instead
  end_year?: number; // ignored for aggregation, use years instead
  entity_types?: string[];
  is_uat?: boolean;
  // Population constraints for per-capita
  min_population?: number | null;
  max_population?: number | null;

  // Entity-level filters
  search?: string; // search by entity name (ILIKE)

  // Aggregated constraints & transforms
  min_amount?: number | null; // applies to aggregated amount (after normalization)
  max_amount?: number | null; // applies to aggregated amount (after normalization)
  normalization?: NormalizationMode; // default 'total'
}

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
  per_capita_amount: number;
  amount: number; // equals total_amount or per_capita_amount depending on normalization
}

const cache = createCache<EntityAnalyticsDataPoint_Repo[]>({
  name: "entity_analytics",
  maxSize: 200 * 1024 * 1024,
  maxItems: 10000,
});

function buildEntityAnalyticsWhere(
  filter: EntityAnalyticsFilter,
  initialParamIndex: number = 1
): { conditions: string[]; values: any[]; nextParamIndex: number; requireReportsJoin: boolean } {
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = initialParamIndex;
  let requireReportsJoin = false;

  // Mandatory
  if (!filter.account_category) {
    throw new Error("account_category is required for entity analytics.");
  }
  conditions.push(`eli.account_category = $${paramIndex++}`);
  values.push(filter.account_category);

  if (!filter.years || filter.years.length === 0) {
    throw new Error("Years array cannot be empty for entity analytics.");
  }
  conditions.push(`eli.year = ANY($${paramIndex++}::int[])`);
  values.push(filter.years);

  // Basic ELI filters
  if (filter.report_id) {
    conditions.push(`eli.report_id = $${paramIndex++}`);
    values.push(filter.report_id);
  }
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
  if (filter.funding_source_id) {
    conditions.push(`eli.funding_source_id = $${paramIndex++}`);
    values.push(filter.funding_source_id);
  }
  if (filter.funding_source_ids?.length) {
    conditions.push(`eli.funding_source_id = ANY($${paramIndex++}::int[])`);
    values.push(filter.funding_source_ids);
  }
  if (filter.budget_sector_id) {
    conditions.push(`eli.budget_sector_id = $${paramIndex++}`);
    values.push(filter.budget_sector_id);
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
  if (filter.program_code) {
    conditions.push(`eli.program_code = $${paramIndex++}`);
    values.push(filter.program_code);
  }
  if (filter.reporting_year !== undefined) {
    requireReportsJoin = true;
    conditions.push(`r.reporting_year = $${paramIndex++}`);
    values.push(filter.reporting_year);
  }

  // Joined filters requiring Entities and/or UATs
  if (
    filter.entity_types?.length ||
    typeof filter.is_uat === "boolean" ||
    filter.uat_ids?.length ||
    filter.county_code ||
    filter.county_codes?.length ||
    filter.search
  ) {
    // Entities are always joined in main query; just add conditions here
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

  if (filter.county_code || filter.county_codes?.length) {
    if (filter.county_code) {
      conditions.push(`u.county_code = $${paramIndex++}`);
      values.push(filter.county_code);
    }
    if (filter.county_codes?.length) {
      conditions.push(`u.county_code = ANY($${paramIndex++}::text[])`);
      values.push(filter.county_codes);
    }
  }

  if (filter.min_population !== undefined && filter.min_population !== null) {
    conditions.push(`u.population >= $${paramIndex++}`);
    values.push(filter.min_population);
  }
  if (filter.max_population !== undefined && filter.max_population !== null) {
    conditions.push(`u.population <= $${paramIndex++}`);
    values.push(filter.max_population);
  }

  return { conditions, values, nextParamIndex: paramIndex, requireReportsJoin };
}

function buildHavingClause(
  filter: EntityAnalyticsFilter,
  amountExpression: string,
  initialParamIndex: number,
  values: any[]
): { havingClause: string; nextParamIndex: number } {
  const havingConditions: string[] = [];
  let paramIndex = initialParamIndex;

  if (filter.min_amount !== undefined && filter.min_amount !== null) {
    havingConditions.push(`${amountExpression} >= $${paramIndex++}`);
    values.push(filter.min_amount);
  }
  if (filter.max_amount !== undefined && filter.max_amount !== null) {
    havingConditions.push(`${amountExpression} <= $${paramIndex++}`);
    values.push(filter.max_amount);
  }

  const havingClause = havingConditions.length ? ` HAVING ${havingConditions.join(" AND ")}` : "";
  return { havingClause, nextParamIndex: paramIndex };
}

function toOrderBy(sort?: EntityAnalyticsSortOption): string {
  if (!sort) return " ORDER BY amount DESC, total_amount DESC";
  const sortable = new Set([
    "amount",
    "total_amount",
    "per_capita_amount",
    "entity_name",
    "entity_type",
    "population",
    "county_name",
    "county_code",
  ]);
  const by = sortable.has(sort.by) ? sort.by : "amount";
  const order = sort.order === "ASC" ? "ASC" : "DESC";
  return ` ORDER BY ${by} ${order}`;
}

export const entityAnalyticsRepository = {
  async getEntityAnalytics(
    filter: EntityAnalyticsFilter,
    sort?: EntityAnalyticsSortOption,
    limit?: number,
    offset?: number
  ): Promise<{ rows: EntityAnalyticsDataPoint_Repo[]; totalCount: number }> {
    const cacheKey = getCacheKey({ filter, sort, limit, offset });
    const cached = cache.get(cacheKey);
    // We only cache rows list; totalCount can change with data, but accept same key
    // to avoid storing two caches; we still compute totalCount separately without caching here.

    const values: any[] = [];
    const { conditions, values: whereValues, nextParamIndex, requireReportsJoin } = buildEntityAnalyticsWhere(filter, 1);
    values.push(...whereValues);

    const whereClause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";

    // Define expressions
    const populationExpr = `COALESCE(u.population, 0)`;
    const totalAmountExpr = `COALESCE(SUM(eli.amount), 0)`;
    const perCapitaExpr = `COALESCE(${totalAmountExpr} / NULLIF(${populationExpr}, 0), 0)`;
    const amountExpr = filter.normalization === "per-capita" ? perCapitaExpr : totalAmountExpr;

    // Group by entity and UAT attributes used in SELECT
    const groupBy = ` GROUP BY e.cui, e.name, e.entity_type, e.uat_id, u.county_code, u.county_name, u.population`;

    // HAVING for aggregated amount thresholds
    const { havingClause, nextParamIndex: afterHavingIndex } = buildHavingClause(
      filter,
      amountExpr,
      nextParamIndex,
      values
    );

    // Base FROM and mandatory joins
    const reportsJoin = requireReportsJoin ? " LEFT JOIN Reports r ON eli.report_id = r.report_id" : "";
    const fromJoin = ` FROM ExecutionLineItems eli
      JOIN Entities e ON eli.entity_cui = e.cui
      LEFT JOIN LATERAL (
        SELECT u1.*
        FROM UATs u1
        WHERE (u1.id = e.uat_id) OR (u1.uat_code = e.cui)
        ORDER BY CASE WHEN u1.id = e.uat_id THEN 0 ELSE 1 END
        LIMIT 1
      ) u ON TRUE${reportsJoin}`;

    const orderBy = toOrderBy(sort);

    const select = `SELECT 
      e.cui AS entity_cui,
      e.name AS entity_name,
      e.entity_type AS entity_type,
      e.uat_id AS uat_id,
      u.county_code AS county_code,
      u.county_name AS county_name,
      ${populationExpr} AS population,
      ${totalAmountExpr} AS total_amount,
      ${perCapitaExpr} AS per_capita_amount,
      ${amountExpr} AS amount`;

    const query = `${select}${fromJoin}${whereClause}${groupBy}${havingClause}${orderBy}`;

    // Count query (number of groups after HAVING)
    const countQuery = `SELECT COUNT(*) AS count FROM (
      ${select}${fromJoin}${whereClause}${groupBy}${havingClause}
    ) t`;

    const countResult = await pool.query(countQuery, values);
    const totalCount = parseInt(countResult.rows[0]?.count ?? "0", 10);

    let finalQuery = query;
    let paramIndex = afterHavingIndex;
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

    // Cache only the rows list
    cache.set(cacheKey, rows);

    return { rows, totalCount };
  },
};


