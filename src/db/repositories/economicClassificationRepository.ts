import pool from "../connection";
import { EconomicClassification } from "../models";

export const economicClassificationRepository = {
  async getAll(): Promise<EconomicClassification[]> {
    try {
      const result = await pool.query(
        "SELECT * FROM EconomicClassifications ORDER BY economic_code"
      );
      return result.rows;
    } catch (error) {
      console.error("Error fetching economic classifications:", error);
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
