import pool from "../connection";
import { FunctionalClassification } from "../models";

export const functionalClassificationRepository = {
  async getAll(): Promise<FunctionalClassification[]> {
    try {
      const result = await pool.query(
        "SELECT * FROM FunctionalClassifications ORDER BY functional_code"
      );
      return result.rows;
    } catch (error) {
      console.error("Error fetching functional classifications:", error);
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
