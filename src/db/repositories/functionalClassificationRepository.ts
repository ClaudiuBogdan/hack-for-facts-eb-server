import pool from "../connection";
import { FunctionalClassification } from "../models";

export interface FunctionalClassificationFilter {
  search?: string;
}

export const functionalClassificationRepository = {
  async getAll(
    filter?: FunctionalClassificationFilter,
    limit?: number,
    offset?: number
  ): Promise<FunctionalClassification[]> {
    try {
      let query = "SELECT * FROM FunctionalClassifications";
      const queryParams: any[] = [];
      let paramIndex = 1;

      if (filter && filter.search) {
        query += ` WHERE functional_name ILIKE $${paramIndex++}`;
        queryParams.push(`%${filter.search}%`);
      }

      query += " ORDER BY functional_code";

      if (limit !== undefined && offset !== undefined) {
        query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        queryParams.push(limit, offset);
      }

      const result = await pool.query(query, queryParams);
      return result.rows;
    } catch (error) {
      console.error("Error fetching functional classifications:", error);
      throw error;
    }
  },

  async count(filter?: FunctionalClassificationFilter): Promise<number> {
    try {
      let query = "SELECT COUNT(*) FROM FunctionalClassifications";
      const queryParams: any[] = [];
      let paramIndex = 1;

      if (filter && filter.search) {
        query += ` WHERE functional_name ILIKE $${paramIndex++}`;
        queryParams.push(`%${filter.search}%`);
      }

      const result = await pool.query(query, queryParams);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting functional classifications:", error);
      throw error;
    }
  },

  async getByCode(code: string): Promise<FunctionalClassification | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM FunctionalClassifications WHERE functional_code = $1",
        [code]
      );
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(
        `Error fetching functional classification with code: ${code}`,
        error
      );
      throw error;
    }
  },
};
