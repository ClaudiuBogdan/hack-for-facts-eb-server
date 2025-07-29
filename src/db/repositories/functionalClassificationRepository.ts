import pool from "../connection";
import { FunctionalClassification } from "../models";
import { createCache } from "../../utils/cache";

const cache = createCache<FunctionalClassification>();

export interface FunctionalClassificationFilter {
  search?: string;
}

// Similarity threshold for pg_trgm; adjust for Romanian short strings
const SIMILARITY_THRESHOLD = 0.1;

/**
 * Builds the WHERE clause and parameters for pg_trgm search filtering.
 */
function buildSearchClause(
  filter: FunctionalClassificationFilter
): { clause: string; params: any[] } {
  const { search } = filter;
  const params: any[] = [];
  let clause = "";

  if (search) {
    clause = `WHERE similarity(functional_name, $1) > $2`;
    params.push(search, SIMILARITY_THRESHOLD);
  }

  return { clause, params };
}

/**
 * Builds ORDER BY clause and selects similarity score if searching.
 */
function buildOrderAndSelect(
  filter: FunctionalClassificationFilter
): { selectExtra: string; orderBy: string } {
  if (filter.search) {
    return {
      selectExtra: ", similarity(functional_name, $1) AS relevance",
      orderBy: "ORDER BY relevance DESC, functional_code ASC",
    };
  }

  return { selectExtra: "", orderBy: "ORDER BY functional_code ASC" };
}

export const functionalClassificationRepository = {
  async getAll(
    filter: FunctionalClassificationFilter = {},
    limit?: number,
    offset?: number
  ): Promise<FunctionalClassification[]> {
    const { clause, params } = buildSearchClause(filter);
    const { selectExtra, orderBy } = buildOrderAndSelect(filter);

    // Build base query with optional relevance select
    let query = `SELECT *${selectExtra} FROM FunctionalClassifications ${clause} ${orderBy}`;

    // Pagination
    if (limit !== undefined) {
      params.push(limit);
      query += ` LIMIT $${params.length}`;
    }
    if (offset !== undefined) {
      params.push(offset);
      query += ` OFFSET $${params.length}`;
    }

    try {
      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.error("Error fetching functional classifications:", error);
      throw error;
    }
  },

  async count(filter: FunctionalClassificationFilter = {}): Promise<number> {
    const { clause, params } = buildSearchClause(filter);
    const query = `SELECT COUNT(*) AS count FROM FunctionalClassifications ${clause}`;

    try {
      const result = await pool.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting functional classifications:", error);
      throw error;
    }
  },

  async getByCode(code: string): Promise<FunctionalClassification | null> {
    const cacheKey = String(code);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const query =
      "SELECT * FROM FunctionalClassifications WHERE functional_code = $1";
    try {
      const { rows } = await pool.query<FunctionalClassification>(query, [code]);
      const result = rows.length > 0 ? rows[0] : null;
      if (result) cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error(
        `Error fetching functional classification with code: ${code}`,
        error
      );
      throw error;
    }
  },
};
