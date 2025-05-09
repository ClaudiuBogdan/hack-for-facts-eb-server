import pool from "../connection";
import { EconomicClassification } from "../models";

export interface EconomicClassificationFilter {
  search?: string;
}

// Similarity threshold for pg_trgm; adjust for Romanian short strings
const SIMILARITY_THRESHOLD = 0.1;

/**
 * Builds the WHERE clause and parameters for pg_trgm search filtering.
 */
function buildSearchClause(
  filter: EconomicClassificationFilter
): { clause: string; params: any[] } {
  const { search } = filter;
  const params: any[] = [];
  let clause = "";

  if (search) {
    clause = `WHERE similarity(economic_name, $1) > $2`;
    params.push(search, SIMILARITY_THRESHOLD);
  }

  return { clause, params };
}

/**
 * Builds ORDER BY clause and selects similarity score if searching.
 */
function buildOrderAndSelect(
  filter: EconomicClassificationFilter
): { selectExtra: string; orderBy: string } {
  if (filter.search) {
    return {
      selectExtra: ", similarity(economic_name, $1) AS relevance",
      orderBy: "ORDER BY relevance DESC, economic_code ASC",
    };
  }

  return { selectExtra: "", orderBy: "ORDER BY economic_code ASC" };
}

export const economicClassificationRepository = {
  async getAll(
    filter: EconomicClassificationFilter = {},
    limit?: number,
    offset?: number
  ): Promise<EconomicClassification[]> {
    const { clause, params } = buildSearchClause(filter);
    const { selectExtra, orderBy } = buildOrderAndSelect(filter);

    // Build base query with optional relevance select
    let query = `SELECT *${selectExtra} FROM EconomicClassifications ${clause} ${orderBy}`;

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
      console.error("Error fetching economic classifications:", error);
      throw error;
    }
  },

  async count(filter: EconomicClassificationFilter = {}): Promise<number> {
    const { clause, params } = buildSearchClause(filter);
    const query = `SELECT COUNT(*) AS count FROM EconomicClassifications ${clause}`;

    try {
      const result = await pool.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting economic classifications:", error);
      throw error;
    }
  },

  async getByCode(code: string): Promise<EconomicClassification | null> {
    const query =
      "SELECT * FROM EconomicClassifications WHERE economic_code = $1";
    try {
      const result = await pool.query(query, [code]);
      return result.rows[0] || null;
    } catch (error) {
      console.error(
        `Error fetching economic classification with code: ${code}`,
        error
      );
      throw error;
    }
  },
};
