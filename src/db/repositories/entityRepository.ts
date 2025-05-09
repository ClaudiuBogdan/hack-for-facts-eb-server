import pool from "../connection";
import { Entity } from "../models";

export interface EntityFilter {
  cui?: string;
  name?: string;    // Exact or partial match
  sector_type?: string;
  uat_id?: number;
  address?: string; // Exact or partial match
  search?: string;  // pg_trgm based search across name & address
}

// Threshold for pg_trgm similarity (adjust as needed for Romanian text)
const SIMILARITY_THRESHOLD = 0.1;

/**
 * Builds a pg_trgm search condition for name & address.
 * Returns an empty condition/params if no search term is provided.
 */
function buildSearchCondition(
  filter: EntityFilter
): { condition: string; params: any[] } {
  if (!filter.search) {
    return { condition: "", params: [] };
  }
  return {
    condition: `GREATEST(similarity(name, $1), similarity(address, $1)) > $2`,
    params: [filter.search, SIMILARITY_THRESHOLD],
  };
}

/**
 * Builds extra SELECT and ORDER BY clauses when using pg_trgm search.
 */
function buildOrderAndSelect(
  filter: EntityFilter
): { selectExtra: string; orderBy: string } {
  if (filter.search) {
    return {
      selectExtra: `, GREATEST(similarity(name, $1), similarity(address, $1)) AS relevance`,
      orderBy: "ORDER BY relevance DESC, cui ASC",
    };
  }
  return { selectExtra: "", orderBy: "ORDER BY cui ASC" };
}

export const entityRepository = {
  async getAll(
    filter: EntityFilter = {},
    limit?: number,
    offset?: number
  ): Promise<Entity[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    // pg_trgm search across name & address
    const search = buildSearchCondition(filter);
    if (search.condition) {
      conditions.push(search.condition);
      params.push(...search.params);
    } else {
      // fallback filters when no pg_trgm search
      if (filter.name) {
        conditions.push(`name ILIKE $${params.length + 1}`);
        params.push(`%${filter.name}%`);
      }
      if (filter.address) {
        conditions.push(`address ILIKE $${params.length + 1}`);
        params.push(`%${filter.address}%`);
      }
    }

    // other exact-match filters
    if (filter.cui) {
      conditions.push(`cui = $${params.length + 1}`);
      params.push(filter.cui);
    }
    if (filter.sector_type) {
      conditions.push(`sector_type = $${params.length + 1}`);
      params.push(filter.sector_type);
    }
    if (filter.uat_id !== undefined) {
      conditions.push(`uat_id = $${params.length + 1}`);
      params.push(filter.uat_id);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { selectExtra, orderBy } = buildOrderAndSelect(filter);

    let query = `SELECT *${selectExtra} FROM Entities ${whereClause} ${orderBy}`;

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
      console.error("Error fetching entities:", error);
      throw error;
    }
  },

  async getById(cui: string): Promise<Entity | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM Entities WHERE cui = $1",
        [cui]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error(`Error fetching entity with CUI: ${cui}`, error);
      throw error;
    }
  },

  async count(filter: EntityFilter = {}): Promise<number> {
    const conditions: string[] = [];
    const params: any[] = [];

    // reuse search condition logic
    const search = buildSearchCondition(filter);
    if (search.condition) {
      conditions.push(search.condition);
      params.push(...search.params);
    } else {
      if (filter.name) {
        conditions.push(`name ILIKE $${params.length + 1}`);
        params.push(`%${filter.name}%`);
      }
      if (filter.address) {
        conditions.push(`address ILIKE $${params.length + 1}`);
        params.push(`%${filter.address}%`);
      }
    }

    // other exact-match filters
    if (filter.cui) {
      conditions.push(`cui = $${params.length + 1}`);
      params.push(filter.cui);
    }
    if (filter.sector_type) {
      conditions.push(`sector_type = $${params.length + 1}`);
      params.push(filter.sector_type);
    }
    if (filter.uat_id !== undefined) {
      conditions.push(`uat_id = $${params.length + 1}`);
      params.push(filter.uat_id);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT COUNT(*) AS count FROM Entities ${whereClause}`;

    try {
      const result = await pool.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting entities:", error);
      throw error;
    }
  },
};
