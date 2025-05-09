import pool from "../connection";
import { FundingSource } from "../models";

export interface FundingSourceFilter {
  search?: string;
}

// Similarity threshold for pg_trgm (tune for short Romanian descriptions)
const SIMILARITY_THRESHOLD = 0.1;

/**
 * Builds pg_trgm search clause for source_description.
 */
function buildSearchClause(
  filter: FundingSourceFilter
): { clause: string; params: any[] } {
  if (!filter.search) {
    return { clause: "", params: [] };
  }
  return {
    clause: `WHERE similarity(source_description, $1) > $2`,
    params: [filter.search, SIMILARITY_THRESHOLD],
  };
}

/**
 * Builds extra SELECT and ORDER BY when search is active.
 */
function buildOrderAndSelect(
  filter: FundingSourceFilter
): { selectExtra: string; orderBy: string } {
  if (filter.search) {
    return {
      selectExtra: `, similarity(source_description, $1) AS relevance`,
      orderBy: "ORDER BY relevance DESC, source_id ASC",
    };
  }
  return { selectExtra: "", orderBy: "ORDER BY source_id ASC" };
}

export const fundingSourceRepository = {
  async getAll(
    filter: FundingSourceFilter = {},
    limit?: number,
    offset?: number
  ): Promise<FundingSource[]> {
    // Build search clause and params
    const { clause, params } = buildSearchClause(filter);
    const { selectExtra, orderBy } = buildOrderAndSelect(filter);

    let query = `SELECT *${selectExtra} FROM FundingSources ${clause} ${orderBy}`;

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
      console.error("Error fetching funding sources:", error);
      throw error;
    }
  },

  async count(filter: FundingSourceFilter = {}): Promise<number> {
    const { clause, params } = buildSearchClause(filter);
    const query = `SELECT COUNT(*) AS count FROM FundingSources ${clause}`;

    try {
      const result = await pool.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting funding sources:", error);
      throw error;
    }
  },

  async getById(id: number): Promise<FundingSource | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM FundingSources WHERE source_id = $1",
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error(`Error fetching funding source with id: ${id}`, error);
      throw error;
    }
  },
};
