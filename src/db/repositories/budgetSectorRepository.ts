import pool from "../connection";
import { createCache } from "../../utils/cache";

const cache = createCache<BudgetSector>({ name: 'budgetSector', maxItems: 1000, maxSize: 2 * 1024 * 1024 });

const buildFilterQuery = (
  filters: BudgetSectorFilter,
  initialParamIndex: number = 1
): {
  whereClause: string;
  values: any[];
} => {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = initialParamIndex;

  if (filters.search) {
    conditions.push(`(sector_description ILIKE '%' || $${paramIndex} || '%' OR similarity(sector_description, $${paramIndex}) > $${paramIndex + 1})`);
    params.push(filters.search, SIMILARITY_THRESHOLD);
    paramIndex += 2;
  }

  if (filters.sector_ids?.length) {
    conditions.push(`sector_id = ANY($${paramIndex}::int[])`);
    params.push(filters.sector_ids);
    paramIndex++;
  }

  const allConditions = conditions.filter(Boolean).join(" AND ");
  return {
    whereClause: allConditions ? `WHERE ${allConditions}` : "",
    values: params,
  };
}

// Threshold for pg_trgm similarity
const SIMILARITY_THRESHOLD = 0.1;

export interface BudgetSector {
  sector_id: number;
  sector_description: string;
}

export interface BudgetSectorFilter {
  search?: string;
  sector_ids?: number[];
}

const TABLE_NAME = "BudgetSectors";

export const budgetSectorRepository = {
  async getById(id: number): Promise<BudgetSector | null> {
    const cacheKey = String(id);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const { rows } = await pool.query<BudgetSector>(
      `SELECT * FROM ${TABLE_NAME} WHERE sector_id = $1`,
      [id]
    );
    const result = rows.length > 0 ? rows[0] : null;
    if (result) cache.set(cacheKey, result);
    return result;
  },

  async getAll(
    filter: BudgetSectorFilter = {},
    limit: number,
    offset: number
  ): Promise<BudgetSector[]> {
    const { whereClause, values } = buildFilterQuery(filter, 3);

    const queryText = `SELECT * FROM ${TABLE_NAME} ${whereClause} LIMIT $1 OFFSET $2`;

    const queryParams = [limit, offset, ...values];
    const { rows } = await pool.query<BudgetSector>(queryText, queryParams);
    return rows;
  },

  async count(filter: BudgetSectorFilter = {}): Promise<number> {
    const { whereClause, values } = buildFilterQuery(filter);

    const queryText = `SELECT COUNT(*) FROM ${TABLE_NAME} ${whereClause}`;

    const queryParams = [...values];
    const { rows } = await pool.query<{ count: string }>(queryText, queryParams);
    return parseInt(rows[0].count, 10);
  },
}; 