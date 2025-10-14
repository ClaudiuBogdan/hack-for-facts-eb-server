import pool from "../connection";
import { createCache, getCacheKey } from "../../utils/cache";

export interface CategoryAggregateFilter {
  account_category: "vn" | "ch";
  years: number[];
  functional_codes?: string[];
  functional_prefixes?: string[];
  economic_codes?: string[];
  economic_prefixes?: string[];
  county_codes?: string[];
  funding_source_ids?: number[];
}

export interface FunctionalAggregateRow {
  functional_code: string;
  functional_name: string;
  total_amount: number;
  contributing_entities_count: number;
  avg_amount: number;
  min_amount: number;
  max_amount: number;
}

export interface EconomicAggregateRow {
  economic_code: string | null;
  economic_name: string | null;
  total_amount: number;
  contributing_entities_count: number;
  avg_amount: number;
  min_amount: number;
  max_amount: number;
}

// Caches for list + count results
type FunctionalAggregatesCache = { rows: FunctionalAggregateRow[]; totalCount: number };
type EconomicAggregatesCache = { rows: EconomicAggregateRow[]; totalCount: number };

const functionalCache = createCache<FunctionalAggregatesCache>({
  name: "category_functional_aggregates",
  maxSize: 100 * 1024 * 1024,
  maxItems: 10000,
});

const economicCache = createCache<EconomicAggregatesCache>({
  name: "category_economic_aggregates",
  maxSize: 100 * 1024 * 1024,
  maxItems: 10000,
});

function buildWhere(filter: CategoryAggregateFilter) {
  const conditions: string[] = [];
  const values: any[] = [];
  let i = 1;

  conditions.push(`account_category = $${i++}`);
  values.push(filter.account_category);
  conditions.push(`reporting_year = ANY($${i++}::int[])`);
  values.push(filter.years);

  if (filter.functional_codes?.length) {
    conditions.push(`functional_code = ANY($${i++}::text[])`);
    values.push(filter.functional_codes);
  }
  if (filter.functional_prefixes?.length) {
    const patterns = filter.functional_prefixes.map((p) => `${p}%`);
    conditions.push(`functional_code LIKE ANY($${i++}::text[])`);
    values.push(patterns);
  }
  if (filter.economic_codes?.length) {
    conditions.push(`economic_code = ANY($${i++}::text[])`);
    values.push(filter.economic_codes);
  }
  if (filter.economic_prefixes?.length) {
    const patterns = filter.economic_prefixes.map((p) => `${p}%`);
    conditions.push(`economic_code LIKE ANY($${i++}::text[])`);
    values.push(patterns);
  }
  if (filter.county_codes?.length) {
    conditions.push(`county_code = ANY($${i++}::text[])`);
    values.push(filter.county_codes);
  }
  if (filter.funding_source_ids?.length) {
    conditions.push(`funding_source_id = ANY($${i++}::int[])`);
    values.push(filter.funding_source_ids);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { where, values };
}

export const categoryAnalyticsRepository = {
  async getFunctionalAggregates(
    filter: CategoryAggregateFilter,
    limit = 50,
    offset = 0
  ): Promise<{ rows: FunctionalAggregateRow[]; totalCount: number }> {
    const cacheKey = getCacheKey({ filter, limit, offset });
    const cached = await functionalCache.get(cacheKey);
    if (cached) return cached;

    const { where, values } = buildWhere(filter);
    const base = `FROM vw_Category_Aggregated_Metrics ${where}`;
    const select = `SELECT functional_code, COALESCE(functional_name, '') AS functional_name, SUM(total_amount) AS total_amount, SUM(contributing_entities_count) AS contributing_entities_count, AVG(avg_amount) AS avg_amount, MIN(min_amount) AS min_amount, MAX(max_amount) AS max_amount ${base} GROUP BY functional_code, functional_name ORDER BY total_amount DESC`;
    const count = `SELECT COUNT(*) AS count FROM (SELECT functional_code ${base} GROUP BY functional_code) t`;

    const finalValues = [...values];
    const selectWithLimit = `${select} LIMIT $${finalValues.length + 1} OFFSET $${finalValues.length + 2}`;
    finalValues.push(limit, offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(selectWithLimit, finalValues),
      pool.query(count, values),
    ]);
    const result = {
      rows: rowsRes.rows.map((r) => ({
        functional_code: r.functional_code,
        functional_name: r.functional_name,
        total_amount: parseFloat(r.total_amount ?? 0),
        contributing_entities_count: parseInt(r.contributing_entities_count ?? 0, 10),
        avg_amount: parseFloat(r.avg_amount ?? 0),
        min_amount: parseFloat(r.min_amount ?? 0),
        max_amount: parseFloat(r.max_amount ?? 0),
      })),
      totalCount: parseInt(countRes.rows[0].count, 10),
    };
    await functionalCache.set(cacheKey, result);
    return result;
  },

  async getEconomicAggregates(
    filter: CategoryAggregateFilter,
    limit = 50,
    offset = 0
  ): Promise<{ rows: EconomicAggregateRow[]; totalCount: number }> {
    const cacheKey = getCacheKey({ filter, limit, offset });
    const cached = await economicCache.get(cacheKey);
    if (cached) return cached;

    const { where, values } = buildWhere(filter);
    const base = `FROM vw_Category_Aggregated_Metrics ${where}`;
    const select = `SELECT economic_code, COALESCE(economic_name, '') AS economic_name, SUM(total_amount) AS total_amount, SUM(contributing_entities_count) AS contributing_entities_count, AVG(avg_amount) AS avg_amount, MIN(min_amount) AS min_amount, MAX(max_amount) AS max_amount ${base} GROUP BY economic_code, economic_name ORDER BY total_amount DESC`;
    const count = `SELECT COUNT(*) AS count FROM (SELECT economic_code ${base} GROUP BY economic_code) t`;

    const finalValues = [...values];
    const selectWithLimit = `${select} LIMIT $${finalValues.length + 1} OFFSET $${finalValues.length + 2}`;
    finalValues.push(limit, offset);

    const [rowsRes, countRes] = await Promise.all([
      pool.query(selectWithLimit, finalValues),
      pool.query(count, values),
    ]);
    const result = {
      rows: rowsRes.rows.map((r) => ({
        economic_code: r.economic_code,
        economic_name: r.economic_name,
        total_amount: parseFloat(r.total_amount ?? 0),
        contributing_entities_count: parseInt(r.contributing_entities_count ?? 0, 10),
        avg_amount: parseFloat(r.avg_amount ?? 0),
        min_amount: parseFloat(r.min_amount ?? 0),
        max_amount: parseFloat(r.max_amount ?? 0),
      })),
      totalCount: parseInt(countRes.rows[0].count, 10),
    };
    await economicCache.set(cacheKey, result);
    return result;
  },
};

