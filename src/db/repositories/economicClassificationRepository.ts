import pool from "../connection";
import { EconomicClassification } from "../models";
import { createCache } from "../../utils/cache";

const cache = createCache<EconomicClassification>({ name: 'economicClassification' });

export interface EconomicClassificationFilter {
  search?: string;
  economic_codes?: string[];
}

// Similarity threshold for pg_trgm; adjust for Romanian short strings
const SIMILARITY_THRESHOLD = 0.1;

/**
 * Parses the incoming search string for economic classifications.
 * Supports two modes:
 *  - Code prefix search: "ec:43.00.10" or bare code-like strings (e.g. "43.00.10").
 *  - Name search: any other input treated as a textual search on economic_name.
 */
function parseEconomicSearch(searchRaw?: string):
  | { mode: "none" }
  | { mode: "code"; codePrefix: string }
  | { mode: "name"; term: string } {
  if (!searchRaw) return { mode: "none" };
  const raw = searchRaw.trim();
  if (!raw) return { mode: "none" };

  const lower = raw.toLowerCase();
  if (lower.startsWith("ec:")) {
    const codeCandidate = raw.slice(lower.indexOf(":") + 1).trim();
    const codePrefix = codeCandidate.replace(/[^0-9.]/g, "");
    if (codePrefix) return { mode: "code", codePrefix };
    return { mode: "none" };
  }

  // Bare code-like patterns (e.g., 43, 43.00, 43.00.10, 43.00.10.01)
  if (/^\d{1,2}(?:\.\d{2})(?:\.\d{2})?(?:\.\d{2})?$/.test(raw)) {
    return { mode: "code", codePrefix: raw };
  }

  return { mode: "name", term: raw };
}

/**
 * Builds the WHERE clause and parameters for robust search filtering.
 * - Code queries use prefix matching on economic_code.
 * - Name queries use substring ILIKE and trigram similarity on economic_name.
 *
 * Important: When in name mode, the first parameter ($1) is always the raw search term,
 * so ORDER BY and SELECT EXTRAs can safely reference $1. When in code mode, $1 is the
 * code prefix pattern (e.g., '43.00.10%'), and ORDER BY must not rely on $1.
 */
function buildSearchClause(
  filter: EconomicClassificationFilter
): { clause: string; params: any[]; isNameSearch: boolean } {
  const { search, economic_codes } = filter;
  const params: any[] = [];
  const conditions: string[] = [];

  let isNameSearch = false;

  if (search) {
    const parsed = parseEconomicSearch(search);
    if (parsed.mode === "code") {
      conditions.push(`economic_code LIKE $${params.length + 1}`);
      params.push(`${parsed.codePrefix}%`);
    } else if (parsed.mode === "name") {
      isNameSearch = true;
      conditions.push(`(economic_name ILIKE '%' || $1 || '%' OR similarity(economic_name, $1) > $2)`);
      params.push(parsed.term, SIMILARITY_THRESHOLD);
    }
  }

  if (economic_codes?.length) {
    conditions.push(`economic_code = ANY($${params.length + 1}::text[])`);
    params.push(economic_codes);
  }

  const clause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { clause, params, isNameSearch };
}

/**
 * Builds ORDER BY clause and selects similarity score if searching.
 */
function buildOrderAndSelect(
  isNameSearch: boolean
): { selectExtra: string; orderBy: string } {
  if (isNameSearch) {
    const relevance = `similarity(economic_name, $1)`;
    return {
      selectExtra: `, ${relevance} AS relevance`,
      orderBy: `ORDER BY CASE WHEN economic_name ILIKE $1 || '%' THEN 0 ELSE 1 END, relevance DESC, economic_code ASC`,
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
    const { clause, params, isNameSearch } = buildSearchClause(filter);
    const { selectExtra, orderBy } = buildOrderAndSelect(isNameSearch);

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
    const cacheKey = String(code);
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const query =
      "SELECT * FROM EconomicClassifications WHERE economic_code = $1";
    try {
      const { rows } = await pool.query<EconomicClassification>(query, [code]);
      const result = rows.length > 0 ? rows[0] : null;
      if (result) cache.set(cacheKey, result);
      return result;
    } catch (error) {
      console.error(
        `Error fetching economic classification with code: ${code}`,
        error
      );
      throw error;
    }
  },
};
