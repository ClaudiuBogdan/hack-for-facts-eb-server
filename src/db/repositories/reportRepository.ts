import pool from "../connection";
import { Report } from "../models";

export interface ReportFilter {
  entity_cui?: string;
  reporting_year?: number;
  reporting_period?: string;
  report_date_start?: string; // ISO string
  report_date_end?: string;   // ISO string
  search?: string;            // pg_trgm search term
}

export interface SortOptions {
  by: string;
  order: "ASC" | "DESC";
}

// Similarity threshold for pg_trgm (tune for Romanian text)
const SIMILARITY_THRESHOLD = 0.1;
// Base join clause for Reports -> Entities
const BASE_QUERY = "FROM Reports r JOIN Entities e ON r.entity_cui = e.cui";

/**
 * Builds pg_trgm search condition for entity name & download_links.
 */
function buildSearchCondition(
  filter: ReportFilter
): { condition: string; params: any[] } {
  if (!filter.search) {
    return { condition: "", params: [] };
  }
  // Ensure placeholder numbers here are distinct if params are combined later.
  // Using $1 and $2 here, assuming they are the first params if search is active.
  return {
    condition: `GREATEST(similarity(e.name, $1), similarity(COALESCE(array_to_string(r.download_links, ' '), ''), $1)) > $2`,
    params: [filter.search, SIMILARITY_THRESHOLD],
  };
}

/**
 * Builds SELECT extra and ORDER BY clause.
 */
function buildOrderAndSelect(
  filter: ReportFilter,
  sort?: SortOptions,
  searchParamCount: number = 0 // Number of params already used by search
): { selectExtra: string; orderBy: string } {
  let orderByClause = "ORDER BY r.report_date DESC, r.report_id DESC"; // Default sort
  let selectExtraClause = "";

  if (sort) {
    const validSortColumns: { [key: string]: string } = {
      "report_date": "r.report_date",
    };
    const sortColumn = validSortColumns[sort.by];
    const sortDirection = sort.order.toUpperCase() === "ASC" ? "ASC" : "DESC";

    if (sortColumn) {
      orderByClause = `ORDER BY ${sortColumn} ${sortDirection}, r.report_id ${sortDirection}`;
    }
  }

  if (filter.search) {
    // Adjust parameter index for similarity function if search params are not $1, $2
    // This assumes searchCond.params are always the first if present.
    const searchRelevanceCol = `GREATEST(similarity(e.name, $1), similarity(COALESCE(array_to_string(r.download_links, ' '), ''), $1))`;
    selectExtraClause = `, ${searchRelevanceCol} AS relevance`;
    if (!sort) {
        orderByClause = `ORDER BY relevance DESC, r.report_date DESC, r.report_id DESC`;
    }
  }
  return {
    selectExtra: selectExtraClause,
    orderBy: orderByClause,
  };
}

export const reportRepository = {
  async getAll(
    filter: ReportFilter = {},
    limit?: number,
    offset?: number,
    sort?: SortOptions
  ): Promise<Report[]> {
    const conditions: string[] = [];
    let queryParams: any[] = [];

    const searchCond = buildSearchCondition(filter);
    if (searchCond.condition) {
      conditions.push(searchCond.condition);
      queryParams.push(...searchCond.params);
    }

    if (filter.entity_cui) {
      conditions.push(`r.entity_cui = $${queryParams.length + 1}`);
      queryParams.push(filter.entity_cui);
    }
    if (filter.reporting_year !== undefined) {
      conditions.push(`r.reporting_year = $${queryParams.length + 1}`);
      queryParams.push(filter.reporting_year);
    }
    if (filter.reporting_period) {
      conditions.push(`r.reporting_period = $${queryParams.length + 1}`);
      queryParams.push(filter.reporting_period);
    }
    if (filter.report_date_start) {
      conditions.push(`r.report_date >= $${queryParams.length + 1}`);
      queryParams.push(filter.report_date_start);
    }
    if (filter.report_date_end) {
      conditions.push(`r.report_date <= $${queryParams.length + 1}`);
      queryParams.push(filter.report_date_end);
    }

    const whereClause = conditions.length
      ? ` WHERE ${conditions.join(" AND ")}`
      : "";

    const { selectExtra, orderBy } = buildOrderAndSelect(filter, sort, searchCond.params.length);
    
    let query = `SELECT r.*${selectExtra} ${BASE_QUERY}${whereClause} ${orderBy}`;

    if (limit !== undefined) {
      queryParams.push(limit);
      query += ` LIMIT $${queryParams.length}`;
    }
    if (offset !== undefined) {
      queryParams.push(offset);
      query += ` OFFSET $${queryParams.length}`;
    }

    try {
      const result = await pool.query(query, queryParams);
      return result.rows;
    } catch (error) {
      console.error("Error fetching reports:", error, { query, queryParams });
      throw error;
    }
  },

  async getById(reportId: string): Promise<Report | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM Reports WHERE report_id = $1",
        [reportId]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error(`Error fetching report with ID: ${reportId}`, error);
      throw error;
    }
  },

  async getByEntityAndDate(
    entityCui: string,
    reportDate: Date
  ): Promise<Report | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM Reports WHERE entity_cui = $1 AND report_date = $2",
        [entityCui, reportDate]
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error(
        `Error fetching report for entity: ${entityCui} on date: ${reportDate}`,
        error
      );
      throw error;
    }
  },

  async count(filter: ReportFilter = {}): Promise<number> {
    const conditions: string[] = [];
    let queryParams: any[] = [];

    const searchCond = buildSearchCondition(filter);
    if (searchCond.condition) {
      conditions.push(searchCond.condition);
      queryParams.push(...searchCond.params);
    }

    if (filter.entity_cui) {
      conditions.push(`r.entity_cui = $${queryParams.length + 1}`);
      queryParams.push(filter.entity_cui);
    }
    if (filter.reporting_year !== undefined) {
      conditions.push(`r.reporting_year = $${queryParams.length + 1}`);
      queryParams.push(filter.reporting_year);
    }
    if (filter.reporting_period) {
      conditions.push(`r.reporting_period = $${queryParams.length + 1}`);
      queryParams.push(filter.reporting_period);
    }
    if (filter.report_date_start) {
      conditions.push(`r.report_date >= $${queryParams.length + 1}`);
      queryParams.push(filter.report_date_start);
    }
    if (filter.report_date_end) {
      conditions.push(`r.report_date <= $${queryParams.length + 1}`);
      queryParams.push(filter.report_date_end);
    }

    const whereClause = conditions.length
      ? ` WHERE ${conditions.join(" AND ")}`
      : "";

    const countQuery =
      `SELECT COUNT(DISTINCT r.report_id) AS count ${BASE_QUERY}${whereClause}`;
    
    try {
      const result = await pool.query(countQuery, queryParams);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting reports:", error, { query: countQuery, queryParams });
      throw error;
    }
  },
};