import pool from "../connection";
import { UAT } from "../models";

export interface UATFilter {
  id?: number;
  uat_key?: string;
  uat_code?: string;
  name?: string;          // Exact or partial match
  county_code?: string;
  county_name?: string;   // Exact or partial match
  region?: string;
  search?: string;        // pg_trgm based search
}

// Similarity threshold for pg_trgm searches (tune for Romanian strings)
const SIMILARITY_THRESHOLD = 0.1;

/**
 * Builds the pg_trgm search condition for name & county_name.
 */
function buildSearchCondition(
  filter: UATFilter
): { condition: string; params: any[] } {
  if (!filter.search) {
    return { condition: "", params: [] };
  }
  return {
    condition: `GREATEST(similarity(name, $1), similarity(COALESCE(county_name, ''), $1)) > $2`,
    params: [filter.search, SIMILARITY_THRESHOLD],
  };
}

/**
 * Builds SELECT extra and ORDER BY for search vs. default.
 */
function buildOrderAndSelect(
  filter: UATFilter
): { selectExtra: string; orderBy: string } {
  if (filter.search) {
    return {
      selectExtra: `, GREATEST(similarity(name, $1), similarity(COALESCE(county_name, ''), $1)) AS relevance`,
      orderBy: "ORDER BY relevance DESC, id ASC",
    };
  }
  return { selectExtra: "", orderBy: "ORDER BY id ASC" };
}

export const uatRepository = {
  async getAll(
    filter: UATFilter = {},
    limit?: number,
    offset?: number
  ): Promise<UAT[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    // pg_trgm search first
    const search = buildSearchCondition(filter);
    if (search.condition) {
      conditions.push(search.condition);
      params.push(...search.params);
    } else {
      // fallback partial matches
      if (filter.name) {
        conditions.push(`name ILIKE $${params.length + 1}`);
        params.push(`%${filter.name}%`);
      }
      if (filter.county_name) {
        conditions.push(`county_name ILIKE $${params.length + 1}`);
        params.push(`%${filter.county_name}%`);
      }
    }

    // exact-match filters
    if (filter.id !== undefined) {
      conditions.push(`id = $${params.length + 1}`);
      params.push(filter.id);
    }
    if (filter.uat_key) {
      conditions.push(`uat_key = $${params.length + 1}`);
      params.push(filter.uat_key);
    }
    if (filter.uat_code) {
      conditions.push(`uat_code = $${params.length + 1}`);
      params.push(filter.uat_code);
    }
    if (filter.county_code) {
      conditions.push(`county_code = $${params.length + 1}`);
      params.push(filter.county_code);
    }
    if (filter.region) {
      conditions.push(`region = $${params.length + 1}`);
      params.push(filter.region);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const { selectExtra, orderBy } = buildOrderAndSelect(filter);

    let query = `SELECT *${selectExtra} FROM UATs ${whereClause} ${orderBy}`;

    // pagination
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
      console.error("Error fetching UATs:", error);
      throw error;
    }
  },

  async getById(id: number): Promise<UAT | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM UATs WHERE id = $1",
        [id]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error(`Error fetching UAT with ID: ${id}`, error);
      throw error;
    }
  },

  async count(filter: UATFilter = {}): Promise<number> {
    const conditions: string[] = [];
    const params: any[] = [];

    const search = buildSearchCondition(filter);
    if (search.condition) {
      conditions.push(search.condition);
      params.push(...search.params);
    } else {
      if (filter.name) {
        conditions.push(`name ILIKE $${params.length + 1}`);
        params.push(`%${filter.name}%`);
      }
      if (filter.county_name) {
        conditions.push(`county_name ILIKE $${params.length + 1}`);
        params.push(`%${filter.county_name}%`);
      }
    }

    if (filter.id !== undefined) {
      conditions.push(`id = $${params.length + 1}`);
      params.push(filter.id);
    }
    if (filter.uat_key) {
      conditions.push(`uat_key = $${params.length + 1}`);
      params.push(filter.uat_key);
    }
    if (filter.uat_code) {
      conditions.push(`uat_code = $${params.length + 1}`);
      params.push(filter.uat_code);
    }
    if (filter.county_code) {
      conditions.push(`county_code = $${params.length + 1}`);
      params.push(filter.county_code);
    }
    if (filter.region) {
      conditions.push(`region = $${params.length + 1}`);
      params.push(filter.region);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT COUNT(*) AS count FROM UATs ${whereClause}`;

    try {
      const result = await pool.query(query, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting UATs:", error);
      throw error;
    }
  },
};
