import pool from "../connection";
import { Report } from "../models";

export const reportRepository = {
  async getAll(
    filters: Partial<{
      entity_cui: string;
      reporting_year: number;
      reporting_period: string;
      report_date_start: Date;
      report_date_end: Date;
    }> = {},
    limit?: number,
    offset?: number
  ): Promise<Report[]> {
    try {
      // Start with base query
      let query = "SELECT * FROM Reports WHERE 1=1";
      const values: any[] = [];
      let paramIndex = 1;

      // Add filters dynamically
      if (filters.entity_cui) {
        query += ` AND entity_cui = $${paramIndex++}`;
        values.push(filters.entity_cui);
      }

      if (filters.reporting_year) {
        query += ` AND reporting_year = $${paramIndex++}`;
        values.push(filters.reporting_year);
      }

      if (filters.reporting_period) {
        query += ` AND reporting_period = $${paramIndex++}`;
        values.push(filters.reporting_period);
      }

      if (filters.report_date_start) {
        query += ` AND report_date >= $${paramIndex++}`;
        values.push(filters.report_date_start);
      }

      if (filters.report_date_end) {
        query += ` AND report_date <= $${paramIndex++}`;
        values.push(filters.report_date_end);
      }

      // Add ordering - newest first as a sensible default
      query += " ORDER BY report_date DESC";

      // Add pagination
      if (limit !== undefined) {
        query += ` LIMIT $${paramIndex++}`;
        values.push(limit);
      }

      if (offset !== undefined) {
        query += ` OFFSET $${paramIndex++}`;
        values.push(offset);
      }

      const result = await pool.query(query, values);
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
      return result.rows.length ? result.rows[0] : null;
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
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(
        `Error fetching report for entity: ${entityCui} on date: ${reportDate}`,
        error
      );
      throw error;
    }
  },

  async count(
    filters: Partial<{
      entity_cui: string;
      reporting_year: number;
      reporting_period: string;
      report_date_start: Date;
      report_date_end: Date;
    }> = {}
  ): Promise<number> {
    try {
      // Start with base query
      let query = "SELECT COUNT(*) FROM Reports WHERE 1=1";
      const values: any[] = [];
      let paramIndex = 1;

      // Add filters dynamically
      if (filters.entity_cui) {
        query += ` AND entity_cui = $${paramIndex++}`;
        values.push(filters.entity_cui);
      }

      if (filters.reporting_year) {
        query += ` AND reporting_year = $${paramIndex++}`;
        values.push(filters.reporting_year);
      }

      if (filters.reporting_period) {
        query += ` AND reporting_period = $${paramIndex++}`;
        values.push(filters.reporting_period);
      }

      if (filters.report_date_start) {
        query += ` AND report_date >= $${paramIndex++}`;
        values.push(filters.report_date_start);
      }

      if (filters.report_date_end) {
        query += ` AND report_date <= $${paramIndex++}`;
        values.push(filters.report_date_end);
      }

      const result = await pool.query(query, values);
      return parseInt(result.rows[0].count);
    } catch (error) {
      console.error("Error counting reports:", error);
      throw error;
    }
  },
};
