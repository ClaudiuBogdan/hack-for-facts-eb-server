import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter } from "../../types";
import { buildPeriodFilterSql, getAmountSqlFragments, getEurRateMap } from "./utils";

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

type AggregatedLineItemsCache = { rows: AggregatedLineItem_Repo[]; totalCount: number };
const cache = createCache<AggregatedLineItemsCache>({
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
  if (filter.expense_types?.length) {
    conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
    values.push(filter.expense_types);
  }
  if (filter.program_codes?.length) {
    conditions.push(`eli.program_code = ANY($${paramIndex++}::text[])`);
    values.push(filter.program_codes);
  }
  // reporting_years deprecated; use report_period

  // --- Exclusions (negative filters) ---
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
  if (filter.entity_types?.length || typeof filter.is_uat === "boolean" || filter.uat_ids?.length || filter.search || (exclude && (exclude.entity_types?.length || exclude.uat_ids?.length))) {
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
    if (exclude?.entity_types?.length) {
      conditions.push(`NOT (e.entity_type = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.entity_types);
    }
    if (exclude?.uat_ids?.length) {
      conditions.push(`NOT (e.uat_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.uat_ids);
    }
  }

  if (filter.county_codes?.length || filter.min_population !== undefined || filter.max_population !== undefined || (exclude && (exclude.county_codes?.length || exclude.regions?.length))) {
    requireUATsJoin = true;
    if (filter.county_codes?.length) {
      conditions.push(`u.county_code = ANY($${paramIndex++}::text[])`);
      values.push(filter.county_codes);
    }
    if (exclude?.county_codes?.length) {
      conditions.push(`NOT (u.county_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.county_codes);
    }
    if (exclude?.regions?.length) {
      conditions.push(`NOT (u.region = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.regions);
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
    if (cached) {
      // Return fully from cache if available (rows + totalCount)
      return { rows: cached.rows, totalCount: cached.totalCount };
    }

    const values: any[] = [];
    const { conditions, values: filterValues, nextParamIndex, requireEntitiesJoin, requireReportsJoin, requireUATsJoin } = buildWhereClause(filter, 1);
    values.push(...filterValues);

    const normalization = filter.normalization ?? 'total';
    const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
    const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

    // Get the correct amount column based on period type
    const { sumExpression } = getAmountSqlFragments(filter.report_period, 'eli');

    let paramIndex = nextParamIndex;
    const havingParts: string[] = [];
    if (!needsEuro) {
      if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
        havingParts.push(`${sumExpression} >= $${paramIndex++}`);
        values.push(filter.aggregate_min_amount);
      }
      if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
        havingParts.push(`${sumExpression} <= $${paramIndex++}`);
        values.push(filter.aggregate_max_amount);
      }
    }
    const havingClause = havingParts.length > 0 ? ` HAVING ${havingParts.join(" AND ")}` : "";

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
      ${havingClause}
    `;

    const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) as agg_count`;
    const countResult = await pool.query(countQuery, values);
    const totalCount = parseInt(countResult.rows[0]?.count ?? "0", 10);

    // For total and per_capita, we can rely on SQL ordering and pagination
    if (!needsEuro) {
      let finalQuery = `${baseQuery} ORDER BY amount DESC`;

      if (limit !== undefined) {
        finalQuery += ` LIMIT $${paramIndex++}`;
        values.push(limit);
      }
      if (offset !== undefined) {
        finalQuery += ` OFFSET $${paramIndex++}`;
        values.push(offset);
      }

      const result = await pool.query(finalQuery, values);

      let denominator = 1;
      if (needsPerCapita) {
        denominator = await computeDenominatorPopulation(filter);
      }

      const rows: AggregatedLineItem_Repo[] = result.rows.map((row) => {
        const rawAmount = parseFloat(row.amount ?? 0);
        const amount = needsPerCapita && denominator > 0 ? rawAmount / denominator : rawAmount;
        return {
          functional_code: row.functional_code,
          functional_name: row.functional_name,
          economic_code: row.economic_code,
          economic_name: row.economic_name,
          amount,
          count: parseInt(row.count ?? "0", 10),
        };
      });

      await cache.set(cacheKey, { rows, totalCount });
      return { rows, totalCount };
    }

    // Euro modes: compute per-year aggregates, convert using yearly rates, then sort/paginate in memory
    const yearlyQuery = `
      SELECT
        fc.functional_code,
        fc.functional_name,
        ${normalizedEconomicCodeExpr} AS economic_code,
        ${normalizedEconomicNameExpr} AS economic_name,
        eli.year AS year,
        ${sumExpression} AS amount,
        COUNT(eli.line_item_id) AS count
      FROM ExecutionLineItems eli
      JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
      LEFT JOIN EconomicClassifications ec ON ${normalizedEconomicCodeExpr} = ec.economic_code
      ${joinClause}
      ${whereClause}
      GROUP BY fc.functional_code, fc.functional_name, ${normalizedEconomicCodeExpr}, ${normalizedEconomicNameExpr}, eli.year
    `;

    const yearlyResult = await pool.query(yearlyQuery, values);

    const rateByYear = getEurRateMap();
    let denominator = 1;
    if (needsPerCapita) {
      denominator = await computeDenominatorPopulation(filter);
    }

    type Key = string;
    const acc = new Map<Key, { functional_code: string; functional_name: string; economic_code: string; economic_name: string; amount: number; count: number }>();

    for (const row of yearlyResult.rows) {
      const key = `${row.functional_code}|${row.economic_code}` as Key;
      const year = parseInt(row.year, 10);
      const rate = rateByYear.get(year) ?? 1;
      const amountRon = parseFloat(row.amount ?? 0);
      const amountEur = amountRon / rate;

      const current = acc.get(key) ?? {
        functional_code: row.functional_code,
        functional_name: row.functional_name,
        economic_code: row.economic_code,
        economic_name: row.economic_name,
        amount: 0,
        count: 0,
      };
      current.amount += amountEur;
      current.count += parseInt(row.count ?? "0", 10);
      acc.set(key, current);
    }

    let rows = Array.from(acc.values()).map((r) => {
      const normalizedAmount = needsPerCapita && denominator > 0 ? r.amount / denominator : r.amount;
      return {
        functional_code: r.functional_code,
        functional_name: r.functional_name,
        economic_code: r.economic_code,
        economic_name: r.economic_name,
        amount: normalizedAmount,
        count: r.count,
      } as AggregatedLineItem_Repo;
    });

    // Apply aggregate filters for euro modes in memory
    if (needsEuro) {
      if (filter.aggregate_min_amount !== undefined && filter.aggregate_min_amount !== null) {
        rows = rows.filter(r => r.amount >= filter.aggregate_min_amount!);
      }
      if (filter.aggregate_max_amount !== undefined && filter.aggregate_max_amount !== null) {
        rows = rows.filter(r => r.amount <= filter.aggregate_max_amount!);
      }
    }

    rows.sort((a, b) => b.amount - a.amount);

    const start = offset ?? 0;
    const end = limit !== undefined ? start + limit : undefined;
    const pagedRows = rows.slice(start, end);

    await cache.set(cacheKey, { rows: pagedRows, totalCount: rows.length });
    return { rows: pagedRows, totalCount: rows.length };
  },
};

// --- Helpers for normalization ---

async function computeDenominatorPopulation(filter: AnalyticsFilter): Promise<number> {
  // Determine whether to scope denominator to selected entities or country
  const hasEntityFilter = Boolean(
    (filter.entity_cuis && filter.entity_cuis.length) ||
    (filter.uat_ids && filter.uat_ids.length) ||
    (filter.county_codes && filter.county_codes.length) ||
    typeof filter.is_uat === "boolean" ||
    (filter.entity_types && filter.entity_types.length)
  );

  const countryPopulationSql = `(
    SELECT SUM(pop_val) FROM (
      SELECT MAX(CASE
        WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
        WHEN u2.siruta_code = u2.county_code THEN u2.population
        ELSE 0
      END) AS pop_val
      FROM UATs u2
      GROUP BY u2.county_code
    ) cp
  )`;

  if (!hasEntityFilter) {
    const res = await pool.query(`SELECT ${countryPopulationSql} AS population`);
    return parseInt(res.rows[0]?.population ?? 0, 10) || 0;
  }

  let paramIndex = 1;
  const entityConds: string[] = [];
  const entityValues: any[] = [];

  if (filter.entity_cuis?.length) {
    entityConds.push(`e.cui = ANY($${paramIndex++}::text[])`);
    entityValues.push(filter.entity_cuis);
  }
  if (filter.entity_types?.length) {
    entityConds.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
    entityValues.push(filter.entity_types);
  }
  if (typeof filter.is_uat === "boolean") {
    entityConds.push(`e.is_uat = $${paramIndex++}`);
    entityValues.push(filter.is_uat);
  }
  if (filter.uat_ids?.length) {
    entityConds.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
    entityValues.push(filter.uat_ids);
  }
  if (filter.county_codes?.length) {
    entityConds.push(`ul.county_code = ANY($${paramIndex++}::text[])`);
    entityValues.push(filter.county_codes);
  }

  const entityWhereClause = entityConds.length ? `WHERE ${entityConds.join(" AND ")}` : "";

  const query = `
    WITH population_units AS (
      SELECT
        CASE
          WHEN e.is_uat THEN 'uat:' || ul.id::text
          WHEN e.entity_type = 'admin_county_council' THEN 'county:' || ul.county_code
          ELSE 'country:RO'
        END AS pop_unit_key,
        CASE
          WHEN e.is_uat THEN COALESCE(ul.population, 0)
          WHEN e.entity_type = 'admin_county_council' THEN (
            SELECT MAX(CASE
              WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
              WHEN u2.siruta_code = u2.county_code THEN u2.population
              ELSE 0
            END)
            FROM UATs u2
            WHERE u2.county_code = ul.county_code
          )
          ELSE ${countryPopulationSql}
        END AS pop_value,
        CASE
          WHEN e.is_uat THEN 'uat'
          WHEN e.entity_type = 'admin_county_council' THEN 'county'
          ELSE 'country'
        END AS scope
      FROM Entities e
      LEFT JOIN UATs ul
        ON (ul.id = e.uat_id) OR (ul.uat_code = e.cui)
      ${entityWhereClause}
    ),
    denominator AS (
      SELECT CASE WHEN EXISTS (SELECT 1 FROM population_units pu WHERE pu.scope = 'country')
                  THEN (SELECT MAX(pop_value) FROM population_units pu WHERE pu.scope = 'country')
                  ELSE (
                    SELECT COALESCE(SUM(pop_value), 0)
                    FROM (SELECT DISTINCT pop_unit_key, pop_value FROM population_units) d
                  )
             END AS population
    )
    SELECT population FROM denominator
  `;

  const res = await pool.query(query, entityValues);
  return parseInt(res.rows[0]?.population ?? 0, 10) || 0;
}
