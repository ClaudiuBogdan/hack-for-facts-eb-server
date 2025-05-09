import pool from "../connection";
import { EconomicClassification } from "../models";

export interface EconomicClassificationFilter {
  economic_name_contains?: string;
}

export const economicClassificationRepository = {
  async getAll(
    filter?: EconomicClassificationFilter,
    limit?: number,
    offset?: number
  ): Promise<EconomicClassification[]> {
    try {
      let query = "SELECT * FROM EconomicClassifications";
      const queryParams: any[] = [];
      let paramIndex = 1;

      if (filter && filter.economic_name_contains) {
        query += ` WHERE economic_name ILIKE $${paramIndex++}`;
        queryParams.push(`%${filter.economic_name_contains}%`);
      }

      query += " ORDER BY economic_code";

      if (limit !== undefined && offset !== undefined) {
        query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
        queryParams.push(limit, offset);
      }

      const result = await pool.query(query, queryParams);
      return result.rows;
    } catch (error) {
      console.error("Error fetching economic classifications:", error);
      throw error;
    }
  },

  async count(filter?: EconomicClassificationFilter): Promise<number> {
    try {
      let query = "SELECT COUNT(*) FROM EconomicClassifications";
      const queryParams: any[] = [];
      let paramIndex = 1;

      if (filter && filter.economic_name_contains) {
        query += ` WHERE economic_name ILIKE $${paramIndex++}`;
        queryParams.push(`%${filter.economic_name_contains}%`);
      }

      const result = await pool.query(query, queryParams);
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      console.error("Error counting economic classifications:", error);
      throw error;
    }
  },

  async getByCode(code: string): Promise<EconomicClassification | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM EconomicClassifications WHERE economic_code = $1",
        [code]
      );
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(
        `Error fetching economic classification with code: ${code}`,
        error
      );
      throw error;
    }
  },
};
