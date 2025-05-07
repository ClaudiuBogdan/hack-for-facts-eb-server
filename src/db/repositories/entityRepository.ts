import pool from "../connection";
import { Entity } from "../models";

export const entityRepository = {
  async getAll(
    filters: Partial<Entity> = {},
    limit?: number,
    offset?: number
  ): Promise<Entity[]> {
    try {
      // Start with base query
      let query = "SELECT * FROM Entities WHERE 1=1";
      const values: any[] = [];
      let paramIndex = 1;

      // Add filters dynamically
      if (filters.cui) {
        query += ` AND cui = $${paramIndex++}`;
        values.push(filters.cui);
      }

      if (filters.name) {
        query += ` AND name ILIKE $${paramIndex++}`;
        values.push(`%${filters.name}%`);
      }

      if (filters.sector_type) {
        query += ` AND sector_type = $${paramIndex++}`;
        values.push(filters.sector_type);
      }

      if (filters.uat_id) {
        query += ` AND uat_id = $${paramIndex++}`;
        values.push(filters.uat_id);
      }

      if (filters.address) {
        query += ` AND address ILIKE $${paramIndex++}`;
        values.push(`%${filters.address}%`);
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
      console.error("Error fetching entities:", error);
      throw error;
    }
  },

  async getById(cui: string): Promise<Entity | null> {
    try {
      const result = await pool.query("SELECT * FROM Entities WHERE cui = $1", [
        cui,
      ]);
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error fetching entity with CUI: ${cui}`, error);
      throw error;
    }
  },

  async count(filters: Partial<Entity> = {}): Promise<number> {
    try {
      // Start with base query
      let query = "SELECT COUNT(*) FROM Entities WHERE 1=1";
      const values: any[] = [];
      let paramIndex = 1;

      // Add filters dynamically
      if (filters.cui) {
        query += ` AND cui = $${paramIndex++}`;
        values.push(filters.cui);
      }

      if (filters.name) {
        query += ` AND name ILIKE $${paramIndex++}`;
        values.push(`%${filters.name}%`);
      }

      if (filters.sector_type) {
        query += ` AND sector_type = $${paramIndex++}`;
        values.push(filters.sector_type);
      }

      if (filters.uat_id) {
        query += ` AND uat_id = $${paramIndex++}`;
        values.push(filters.uat_id);
      }

      if (filters.address) {
        query += ` AND address ILIKE $${paramIndex++}`;
        values.push(`%${filters.address}%`);
      }

      const result = await pool.query(query, values);
      return parseInt(result.rows[0].count);
    } catch (error) {
      console.error("Error counting entities:", error);
      throw error;
    }
  },
};
