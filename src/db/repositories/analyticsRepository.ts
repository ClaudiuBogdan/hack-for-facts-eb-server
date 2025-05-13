import pool from "../connection";

export interface HeatmapUATDataPoint {
  uat_id: number;
  uat_code: string;
  uat_name: string;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  aggregated_value: number; // Sum will be a number, maps to Float! in GQL
}

export interface HeatmapUATDataPoint_Repo {
  uat_id: number;
  uat_code: string;
  uat_name: string;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  aggregated_value: number; 
}

export interface HeatmapFilterInput {
  functional_codes?: string[] | null;
  economic_codes?: string[] | null;
  account_categories: string[]; // Mandatory, and array ensured by GQL to be non-null, items non-null
  years: number[];             // Mandatory, and array ensured by GQL to be non-null, items non-null
  min_amount?: number | null;
  max_amount?: number | null;
}

export const analyticsRepository = {
  async getHeatmapData(
    filter: HeatmapFilterInput
  ): Promise<HeatmapUATDataPoint_Repo[]> {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filter.account_categories.length === 0) {
      throw new Error("Account categories array cannot be empty for heatmap data.");
    }
    conditions.push(`eli.account_category = ANY($${paramIndex++})`);
    params.push(filter.account_categories);

    if (filter.years.length === 0) {
      throw new Error("Years array cannot be empty for heatmap data.");
    }
    conditions.push(`eli.year = ANY($${paramIndex++})`);
    params.push(filter.years);

    if (filter.functional_codes && filter.functional_codes.length > 0) {
      conditions.push(`eli.functional_code = ANY($${paramIndex++})`);
      params.push(filter.functional_codes);
    }

    if (filter.economic_codes && filter.economic_codes.length > 0) {
      conditions.push(`eli.economic_code = ANY($${paramIndex++})`);
      params.push(filter.economic_codes);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const havingConditions: string[] = [];
    if (filter.min_amount !== undefined && filter.min_amount !== null) {
      havingConditions.push(`SUM(eli.amount) >= $${paramIndex++}`);
      params.push(filter.min_amount);
    }

    if (filter.max_amount !== undefined && filter.max_amount !== null) {
      havingConditions.push(`SUM(eli.amount) <= $${paramIndex++}`);
      params.push(filter.max_amount);
    }
    const havingClause = havingConditions.length > 0 ? `HAVING ${havingConditions.join(" AND ")}` : "";

    const queryString = `
      SELECT
        u.id AS uat_id,
        u.uat_code,
        u.name AS uat_name,
        u.county_code,
        u.county_name,
        u.population,
        SUM(eli.amount) AS aggregated_value
      FROM ExecutionLineItems eli
      JOIN Entities e ON eli.entity_cui = e.cui
      JOIN UATs u ON e.uat_id = u.id
      ${whereClause}
      GROUP BY
        u.id,
        u.uat_code,
        u.name,
        u.county_code,
        u.county_name,
        u.population
      ${havingClause}
      ORDER BY
        u.id;
    `;

    try {
      const result = await pool.query(queryString, params);
      return result.rows.map((row): HeatmapUATDataPoint_Repo => ({
        uat_id: row.uat_id,
        uat_code: row.uat_code,
        uat_name: row.uat_name,
        county_code: row.county_code,
        county_name: row.county_name,
        population: row.population,
        aggregated_value: parseFloat(row.aggregated_value), // SUM can return as string from pg
      }));
    } catch (error) {
      console.error("Error fetching heatmap data:", error);
      // Consider re-throwing a more specific error or a custom error type
      throw new Error("Database error while fetching heatmap data.");
    }
  },
}; 