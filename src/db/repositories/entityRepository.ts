import { createCache } from "../../utils/cache";
import pool from "../connection";
import { Entity } from "../models";

const entityCache = createCache<Entity>({ name: 'entity' });
const entitiesCache = createCache<Entity[]>({ name: 'entities' });
const countCache = createCache<{ count: number }>({ name: 'entityCount' });

export interface EntityFilter {
  cui?: string;
  cuis?: string[];
  name?: string;    // Exact or partial match
  entity_type?: string;
  uat_id?: number;
  address?: string; // Exact or partial match
  search?: string;  // pg_trgm based search across name & address
  is_uat?: boolean;
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
    condition: `GREATEST(similarity('cui:' || cui || ' ' || name, $1), similarity(address, $1)) > $2`,
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
    const relevance = `GREATEST(similarity('cui:' || cui || ' ' || name, $1), similarity(address, $1))`;
    return {
      selectExtra: `, ${relevance} AS relevance`,
      orderBy: `ORDER BY CASE WHEN 'cui:' || cui || ' ' || name ILIKE $1 || '%' THEN 0 ELSE 1 END, relevance DESC`,
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
    if (filter.cuis) {
      conditions.push(`cui = ANY($${params.length + 1}::text[])`);
      params.push(filter.cuis);
    }
    if (filter.entity_type) {
      conditions.push(`entity_type = $${params.length + 1}`);
      params.push(filter.entity_type);
    }
    if (filter.uat_id !== undefined) {
      conditions.push(`uat_id = $${params.length + 1}`);
      params.push(filter.uat_id);
    }
    if (filter.is_uat !== undefined) {
      conditions.push(`is_uat = $${params.length + 1}`);
      params.push(filter.is_uat);
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
      const cacheKey = `getAll:${query}:${JSON.stringify(params)}`;
      const cached = entitiesCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const result = await pool.query(query, params);
      entitiesCache.set(cacheKey, result.rows);
      return result.rows;
    } catch (error) {
      console.error("Error fetching entities:", error);
      throw error;
    }
  },

  async getById(cui: string): Promise<Entity | null> {
    const cacheKey = String(cui);
    const cached = entityCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await pool.query<Entity>(
        "SELECT * FROM Entities WHERE cui = $1",
        [cui]
      );
      const result = rows.length > 0 ? rows[0] : null;
      if (result) entityCache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error(`Error fetching entity with CUI: ${cui}`, error);
      throw error;
    }
  },

  async getChildren(cui: string): Promise<Entity[]> {
    const cacheKey = `getChildren:${cui}`;
    const cached = entitiesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await pool.query(
      "SELECT * FROM Entities WHERE main_creditor_1_cui = $1 OR main_creditor_2_cui = $1",
      [cui]
    );
    entitiesCache.set(cacheKey, result.rows);
    return result.rows;
  },

  async getParents(cui: string): Promise<Entity[]> {
    const cacheKey = `getParents:${cui}`;
    const cached = entitiesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const query = `
      SELECT child.*
      FROM Entities AS child
      JOIN Entities AS parent
        ON parent.cui = $1
      WHERE child.cui = parent.main_creditor_1_cui
         OR child.cui = parent.main_creditor_2_cui;
    `;

    const result = await pool.query<Entity>(query, [cui]);
    entitiesCache.set(cacheKey, result.rows);
    return result.rows;
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
    if (filter.cuis) {
      conditions.push(`cui = ANY($${params.length + 1}::text[])`);
      params.push(filter.cuis);
    }
    if (filter.entity_type) {
      conditions.push(`entity_type = $${params.length + 1}`);
      params.push(filter.entity_type);
    }
    if (filter.uat_id !== undefined) {
      conditions.push(`uat_id = $${params.length + 1}`);
      params.push(filter.uat_id);
    }
    if (filter.is_uat !== undefined) {
      conditions.push(`is_uat = $${params.length + 1}`);
      params.push(filter.is_uat);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT COUNT(*) AS count FROM Entities ${whereClause}`;

    try {
      const cacheKey = `count:${query}:${JSON.stringify(params)}`;
      const cached = countCache.get(cacheKey);
      if (cached) {
        return cached.count;
      }
      const result = await pool.query(query, params);
      const count = parseInt(result.rows[0].count, 10);
      countCache.set(cacheKey, { count });
      return count;
    } catch (error) {
      console.error("Error counting entities:", error);
      throw error;
    }
  },
};
