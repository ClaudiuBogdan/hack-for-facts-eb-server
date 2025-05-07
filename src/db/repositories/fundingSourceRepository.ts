import pool from "../connection";
import { FundingSource } from "../models";

export const fundingSourceRepository = {
  async getAll(): Promise<FundingSource[]> {
    try {
      const result = await pool.query(
        "SELECT * FROM FundingSources ORDER BY source_id"
      );
      return result.rows;
    } catch (error) {
      console.error("Error fetching funding sources:", error);
      throw error;
    }
  },

  async getById(id: number): Promise<FundingSource | null> {
    try {
      const result = await pool.query(
        "SELECT * FROM FundingSources WHERE source_id = $1",
        [id]
      );
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(`Error fetching funding source with id: ${id}`, error);
      throw error;
    }
  },
};
