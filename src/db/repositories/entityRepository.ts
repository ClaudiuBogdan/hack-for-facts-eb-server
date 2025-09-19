import { createCache } from "../../utils/cache";
import pool from "../connection";
import { Entity } from "../models";
import { SqlFilterParts } from "../../types";

const entityCache = createCache<Entity>({ name: 'entity', maxItems: 50_000, maxSize: 20 * 1024 * 1024 }); // individual rows are small; prefer many items
const entitiesCache = createCache<Entity[]>({ name: 'entities', maxItems: 20_000, maxSize: 50 * 1024 * 1024 });
const countCache = createCache<{ count: number }>({ name: 'entityCount', maxItems: 20_000, maxSize: 10 * 1024 * 1024 });

export interface EntityFilter {
  cui?: string;
  cuis?: string[];
  name?: string;    // Exact or partial match
  entity_type?: string;
  uat_id?: number;
  address?: string; // Exact or partial match
  search?: string;  // pg_trgm based search across name & address
  is_uat?: boolean;
  parents?: string[];
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

/**
 * Unified builder used by both getAll and count to avoid drift.
 * Ensures that, when search is present, its parameters occupy $1/$2 consistently
 * so that order/select relevance clauses can safely reference $1.
 */
export function buildEntityFilterParts(
  filter: EntityFilter,
  initialIndex: number = 1
): SqlFilterParts {
  const conditions: string[] = [];
  const values: any[] = [];

  // Search uses fixed $1/$2 to keep ORDER BY stable. Must be appended first.
  const search = buildSearchCondition(filter);
  if (search.condition) {
    if (initialIndex !== 1) {
      throw new Error("buildEntityFilterParts expects initialIndex=1 when search is used");
    }
    conditions.push(search.condition);
    values.push(...search.params);
  } else {
    // Fallback partial matches when search is not used
    if (filter.name) {
      conditions.push(`name ILIKE $${values.length + 1}`);
      values.push(`%${filter.name}%`);
    }
    if (filter.address) {
      conditions.push(`address ILIKE $${values.length + 1}`);
      values.push(`%${filter.address}%`);
    }
  }

  // Exact-match filters
  if (filter.cui) {
    conditions.push(`cui = $${values.length + 1}`);
    values.push(filter.cui);
  }
  if (filter.cuis) {
    conditions.push(`cui = ANY($${values.length + 1}::text[])`);
    values.push(filter.cuis);
  }
  if (filter.parents && filter.parents.length > 0) {
    conditions.push(`(main_creditor_1_cui = ANY($${values.length + 1}::text[]) OR main_creditor_2_cui = ANY($${values.length + 1}::text[]))`);
    values.push(filter.parents);
  }
  if (filter.entity_type) {
    conditions.push(`entity_type = $${values.length + 1}`);
    values.push(filter.entity_type);
  }
  if (filter.uat_id !== undefined) {
    conditions.push(`uat_id = $${values.length + 1}`);
    values.push(filter.uat_id);
  }
  if (filter.is_uat !== undefined) {
    conditions.push(`is_uat = $${values.length + 1}`);
    values.push(filter.is_uat);
  }

  const whereClause = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
  return {
    joins: "",
    where: whereClause,
    values,
    nextIndex: initialIndex + values.length,
  };
}

export const entityRepository = {
  async getAll(
    filter: EntityFilter = {},
    limit?: number,
    offset?: number
  ): Promise<Entity[]> {
    const { where, values } = buildEntityFilterParts(filter);
    const { selectExtra, orderBy } = buildOrderAndSelect(filter);

    let query = `SELECT *${selectExtra} FROM Entities${where} ${orderBy}`;
    const params: any[] = [...values];

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
      const cached = await entitiesCache.get(cacheKey);
      if (cached) {
        return cached;
      }
      const result = await pool.query(query, params);
      await entitiesCache.set(cacheKey, result.rows);
      return result.rows;
    } catch (error) {
      console.error("Error fetching entities:", error);
      throw error;
    }
  },

  async getById(cui: string): Promise<Entity | null> {
    const cacheKey = String(cui);
    const cached = await entityCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const { rows } = await pool.query<Entity>(
        "SELECT * FROM Entities WHERE cui = $1",
        [cui]
      );
      const result = rows.length > 0 ? rows[0] : null;
      if (result) await entityCache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error(`Error fetching entity with CUI: ${cui}`, error);
      throw error;
    }
  },

  async getChildren(cui: string): Promise<Entity[]> {
    const cacheKey = `getChildren:${cui}`;
    const cached = await entitiesCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await pool.query(
      "SELECT * FROM Entities WHERE main_creditor_1_cui = $1 OR main_creditor_2_cui = $1",
      [cui]
    );
    await entitiesCache.set(cacheKey, result.rows);
    return result.rows;
  },

  async getParents(cui: string): Promise<Entity[]> {
    const cacheKey = `getParents:${cui}`;
    const cached = await entitiesCache.get(cacheKey);
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
    await entitiesCache.set(cacheKey, result.rows);
    return result.rows;
  },

  async count(filter: EntityFilter = {}): Promise<number> {
    const { where, values } = buildEntityFilterParts(filter);
    const query = `SELECT COUNT(*) AS count FROM Entities${where}`;

    try {
      const cacheKey = `count:${query}:${JSON.stringify(values)}`;
      const cached = await countCache.get(cacheKey);
      if (cached) {
        return cached.count;
      }
      const result = await pool.query(query, values);
      const count = parseInt(result.rows[0].count, 10);
      await countCache.set(cacheKey, { count });
      return count;
    } catch (error) {
      console.error("Error counting entities:", error);
      throw error;
    }
  },

  async getCountyEntity(countyCode?: string | null): Promise<Entity | null> {
    if (!countyCode) {
      return null;
    }
    const query = `
      SELECT * FROM Entities e
      JOIN Uats u ON e.uat_id = u.id
      WHERE u.county_code = $1 AND (e.entity_type = 'admin_county_council' OR e.cui = '179132')
    `;
    const result = await pool.query(query, [countyCode]);
    return result.rows.length ? result.rows[0] : null;
  },

};
