import pool from "../connection";
import { UAT } from "../models";

export const uatRepository = {
  async getAll(
    filters: Partial<UAT> = {},
    limit?: number,
    offset?: number
  ): Promise<UAT[]> {
    try {
      // Start with base query
      let query = "SELECT * FROM UATs WHERE 1=1";
      const values: any[] = [];
      let paramIndex = 1;

      // Add filters dynamically
      if (filters.id) {
        query += ` AND id = $${paramIndex++}`;
        values.push(filters.id);
      }

      if (filters.uat_key) {
        query += ` AND uat_key = $${paramIndex++}`;
        values.push(filters.uat_key);
      }

      if (filters.uat_code) {
        query += ` AND uat_code = $${paramIndex++}`;
        values.push(filters.uat_code);
      }

      if (filters.name) {
        query += ` AND name ILIKE $${paramIndex++}`;
        values.push(`%${filters.name}%`);
      }

      if (filters.county_code) {
        query += ` AND county_code = $${paramIndex++}`;
        values.push(filters.county_code);
      }

      if (filters.county_name) {
        query += ` AND county_name ILIKE $${paramIndex++}`;
        values.push(`%${filters.county_name}%`);
      }

      if (filters.region) {
        query += ` AND region = $${paramIndex++}`;
        values.push(filters.region);
      }

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
      console.error("Error fetching UATs:", error);
      throw error;
    }
  },

  async getById(id: number): Promise<UAT | null> {
    try {
      const result = await pool.query("SELECT * FROM UATs WHERE id = $1", [id]);
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error fetching UAT with ID: ${id}`, error);
      throw error;
    }
  },

  async count(filters: Partial<UAT> = {}): Promise<number> {
    try {
      // Start with base query
      let query = "SELECT COUNT(*) FROM UATs WHERE 1=1";
      const values: any[] = [];
      let paramIndex = 1;

      // Add filters dynamically
      if (filters.id) {
        query += ` AND id = $${paramIndex++}`;
        values.push(filters.id);
      }

      if (filters.uat_key) {
        query += ` AND uat_key = $${paramIndex++}`;
        values.push(filters.uat_key);
      }

      if (filters.uat_code) {
        query += ` AND uat_code = $${paramIndex++}`;
        values.push(filters.uat_code);
      }

      if (filters.name) {
        query += ` AND name ILIKE $${paramIndex++}`;
        values.push(`%${filters.name}%`);
      }

      if (filters.county_code) {
        query += ` AND county_code = $${paramIndex++}`;
        values.push(filters.county_code);
      }

      if (filters.county_name) {
        query += ` AND county_name ILIKE $${paramIndex++}`;
        values.push(`%${filters.county_name}%`);
      }

      if (filters.region) {
        query += ` AND region = $${paramIndex++}`;
        values.push(filters.region);
      }

      const result = await pool.query(query, values);
      return parseInt(result.rows[0].count);
    } catch (error) {
      console.error("Error counting UATs:", error);
      throw error;
    }
  },
};
