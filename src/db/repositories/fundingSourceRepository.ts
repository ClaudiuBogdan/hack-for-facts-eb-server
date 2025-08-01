import { createCache } from "../../utils/cache";
import pool from "../connection";
import { FundingSource } from "../models";

// Threshold for pg_trgm similarity
const SIMILARITY_THRESHOLD = 0.1;

const cache = createCache<FundingSource>();

export interface FundingSourceFilter {
  search?: string;
  source_ids?: number[];
}

const TABLE_NAME = "FundingSources";

const buildFilterQuery = (
  filters: FundingSourceFilter,
  initialParamIndex: number = 1
): {
  whereClause: string;
  values: any[];
} => {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = initialParamIndex;

  if (filters.search) {
    conditions.push(`similarity(source_description, $${paramIndex}) > $${paramIndex + 1}`);
    params.push(filters.search, SIMILARITY_THRESHOLD);
    paramIndex += 2;
  }

  if (filters.source_ids?.length) {
    conditions.push(`source_id = ANY($${paramIndex}::int[])`);
    params.push(filters.source_ids);
    paramIndex++;
  }

  const allConditions = conditions.filter(Boolean).join(" AND ");
  return {
    whereClause: allConditions ? `WHERE ${allConditions}` : "",
    values: params,
  };
}
export const fundingSourceRepository = {
  async getAll(
    filter: FundingSourceFilter = {},
    limit?: number,
    offset?: number
  ): Promise<FundingSource[]> {
    const { whereClause, values } = buildFilterQuery(filter, 3);

    const queryText = `SELECT * FROM ${TABLE_NAME} ${whereClause} LIMIT $1 OFFSET $2`;

    const queryParams = [limit, offset, ...values];

    const { rows } = await pool.query<FundingSource>(queryText, queryParams);
    return rows;
  },

  async count(filter: FundingSourceFilter = {}): Promise<number> {
    const { whereClause, values } = buildFilterQuery(filter);

    const queryText = `SELECT COUNT(*) FROM ${TABLE_NAME} ${whereClause}`;

    const queryParams = [...values];

    const { rows } = await pool.query<{ count: string }>(queryText, queryParams);
    return parseInt(rows[0].count, 10);
  },

  async getById(id: number): Promise<FundingSource | null> {
    const cacheKey = String(id);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { rows } = await pool.query<FundingSource>(
      `SELECT * FROM ${TABLE_NAME} WHERE source_id = $1`,
      [id]
    );
    const result = rows.length > 0 ? rows[0] : null;
    if (result) cache.set(cacheKey, result);
    return result;
  },
};
