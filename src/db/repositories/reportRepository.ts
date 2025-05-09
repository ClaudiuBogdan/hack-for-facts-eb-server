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

// Similarity threshold for pg_trgm (tune for Romanian text)
const SIMILARITY_THRESHOLD = 0.1;
// Base join clause for Reports -> Entities
const BASE_QUERY = "FROM Reports r JOIN Entities e ON r.entity_cui = e.cui";

/**
 * Builds pg_trgm search condition for entity name & file_source.
 */
function buildSearchCondition(
  filter: ReportFilter
): { condition: string; params: any[] } {
  if (!filter.search) {
    return { condition: "", params: [] };
  }
  return {
    condition: `GREATEST(similarity(e.name, $1), similarity(COALESCE(r.file_source, ''), $1)) > $2`,
    params: [filter.search, SIMILARITY_THRESHOLD],
  };
}

/**
 * Builds SELECT extra and ORDER BY when search is active.
 */
function buildOrderAndSelect(
  filter: ReportFilter
): { selectExtra: string; orderBy: string } {
  if (filter.search) {
    return {
      selectExtra: `, GREATEST(similarity(e.name, $1), similarity(COALESCE(r.file_source, ''), $1)) AS relevance`,
      orderBy: "ORDER BY relevance DESC, r.report_date DESC, r.report_id DESC",
    };
  }
  return {
    selectExtra: "",
    orderBy: "ORDER BY r.report_date DESC, r.report_id DESC",
  };
}

export const reportRepository = {
  async getAll(
    filter: ReportFilter = {},
    limit?: number,
    offset?: number
  ): Promise<Report[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    // pg_trgm search
    const searchCond = buildSearchCondition(filter);
    if (searchCond.condition) {
      conditions.push(searchCond.condition);
      params.push(...searchCond.params);
    }

    // Additional filters
    if (filter.entity_cui) {
      conditions.push(`r.entity_cui = $${params.length + 1}`);
      params.push(filter.entity_cui);
    }
    if (filter.reporting_year !== undefined) {
      conditions.push(`r.reporting_year = $${params.length + 1}`);
      params.push(filter.reporting_year);
    }
    if (filter.reporting_period) {
      conditions.push(`r.reporting_period = $${params.length + 1}`);
      params.push(filter.reporting_period);
    }
    if (filter.report_date_start) {
      conditions.push(`r.report_date >= $${params.length + 1}`);
      params.push(filter.report_date_start);
    }
    if (filter.report_date_end) {
      conditions.push(`r.report_date <= $${params.length + 1}`);
      params.push(filter.report_date_end);
    }

    const whereClause = conditions.length
      ? ` WHERE ${conditions.join(" AND ")}`
      : "";

    const { selectExtra, orderBy } = buildOrderAndSelect(filter);
    let query = `SELECT r.*${selectExtra} ${BASE_QUERY}${whereClause} ${orderBy}`;

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
      console.error("Error fetching reports:", error);
      throw error;
    }
  },

  async getById(reportId: number): Promise<Report | null> {
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
    const params: any[] = [];

    // pg_trgm search
    const searchCond = buildSearchCondition(filter);
    if (searchCond.condition) {
      conditions.push(searchCond.condition);
      params.push(...searchCond.params);
    }

    // Additional filters
    if (filter.entity_cui) {
      conditions.push(`r.entity_cui = $${params.length + 1}`);
      params.push(filter.entity_cui);
    }
    if (filter.reporting_year !== undefined) {
      conditions.push(`r.reporting_year = $${params.length + 1}`);
      params.push(filter.reporting_year);
    }
    if (filter.reporting_period) {
      conditions.push(`r.reporting_period = $${params.length + 1}`);
      params.push(filter.reporting_period);
    }
    if (filter.report_date_start) {
      conditions.push(`r.report_date >= $${params.length + 1}`);
      params.push(filter.report_date_start);
    }
    if (filter.report_date_end) {
      conditions.push(`r.report_date <= $${params.length + 1}`);
      params.push(filter.report_date_end);
    }

    const whereClause = conditions.length
      ? ` WHERE ${conditions.join(" AND ")}`
      : "";

    const countQuery =
      `SELECT COUNT(DISTINCT r.report_id) AS count ${BASE_QUERY}${whereClause}`;
    
    try {
      const result = await pool.query(countQuery, params);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting reports:", error);
      throw error;
    }
  },
};