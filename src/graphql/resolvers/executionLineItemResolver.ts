import {
  executionLineItemRepository,
  reportRepository,
} from "../../db/repositories";
import pool from "../../db/connection";

export const executionLineItemResolver = {
  Query: {
    executionLineItem: async (_: any, { id }: { id: number }) => {
      return executionLineItemRepository.getById(id);
    },
    executionLineItems: async (
      _: any,
      {
        filter = {},
        limit = 100,
        offset = 0,
      }: {
        filter: any;
        limit: number;
        offset: number;
      }
    ) => {
      const [lineItems, totalCount] = await Promise.all([
        executionLineItemRepository.getAll(filter, limit, offset),
        executionLineItemRepository.count(filter),
      ]);

      return {
        nodes: lineItems,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
    spendingAnomalies: async (
      _: any,
      {
        year,
        period,
        minDeviationPercentage = 50,
        limit = 10,
      }: {
        year: number;
        period?: string;
        minDeviationPercentage: number;
        limit: number;
      }
    ) => {
      try {
        // This is a more complex query, so we'll write raw SQL for this case
        // In a production app, you might want to create a proper repository method instead
        let query = `
          WITH report_averages AS (
            -- Calculate average spending for each functional code across entities in the same period
            SELECT 
              r.reporting_year,
              r.reporting_period,
              eli.functional_code,
              fc.functional_name,
              eli.economic_code,
              ec.economic_name,
              AVG(eli.amount) as average_amount
            FROM 
              ExecutionLineItems eli
              JOIN Reports r ON eli.report_id = r.report_id
              JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
              LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code
            WHERE 
              r.reporting_year = $1
              ${period ? "AND r.reporting_period = $2" : ""}
              AND eli.account_category = 'ch'
            GROUP BY 
              r.reporting_year,
              r.reporting_period,
              eli.functional_code,
              fc.functional_name,
              eli.economic_code,
              ec.economic_name
          ),
          anomalies AS (
            -- Find line items that deviate significantly from the average
            SELECT 
              e.cui as entity_cui,
              e.name as entity_name,
              r.report_id,
              r.report_date,
              r.reporting_period,
              eli.functional_code,
              fc.functional_name,
              eli.economic_code,
              ec.economic_name,
              eli.amount,
              ra.average_amount,
              CASE 
                WHEN ra.average_amount > 0 THEN ((eli.amount - ra.average_amount) / ra.average_amount) * 100
                ELSE 0 
              END as deviation_percentage,
              -- Calculate an anomaly score based on deviation and amount
              CASE 
                WHEN ra.average_amount > 0 THEN 
                  ABS((eli.amount - ra.average_amount) / ra.average_amount) * LOG(GREATEST(eli.amount, 1))
                ELSE 0 
              END as score
            FROM 
              ExecutionLineItems eli
              JOIN Reports r ON eli.report_id = r.report_id
              JOIN Entities e ON eli.entity_cui = e.cui
              JOIN FunctionalClassifications fc ON eli.functional_code = fc.functional_code
              LEFT JOIN EconomicClassifications ec ON eli.economic_code = ec.economic_code
              JOIN report_averages ra ON 
                r.reporting_year = ra.reporting_year
                AND r.reporting_period = ra.reporting_period
                AND eli.functional_code = ra.functional_code
                AND (eli.economic_code = ra.economic_code OR (eli.economic_code IS NULL AND ra.economic_code IS NULL))
            WHERE 
              r.reporting_year = $1
              ${period ? "AND r.reporting_period = $2" : ""}
              AND eli.account_category = 'ch'
              AND eli.amount > 0
              AND ra.average_amount > 0
              AND ABS((eli.amount - ra.average_amount) / ra.average_amount) * 100 >= $${
                period ? "3" : "2"
              }
          )
          SELECT * FROM anomalies
          ORDER BY score DESC
          LIMIT $${period ? "4" : "3"}
        `;

        const params = period
          ? [year, period, minDeviationPercentage, limit]
          : [year, minDeviationPercentage, limit];

        const result = await pool.query(query, params);

        return result.rows.map((row) => ({
          ...row,
          deviation_percentage: parseFloat(row.deviation_percentage),
          amount: parseFloat(row.amount),
          average_amount: parseFloat(row.average_amount),
          score: parseFloat(row.score),
        }));
      } catch (error) {
        console.error("Error detecting spending anomalies:", error);
        throw error;
      }
    },
  },
  ExecutionLineItem: {
    report: async (parent: any) => {
      return reportRepository.getById(parent.report_id);
    },
    entity: async (parent: any) => {
      if (!parent.entity_cui) return null;
      const { entityRepository } = await import("../../db/repositories");
      return entityRepository.getById(parent.entity_cui);
    },
    fundingSource: async (parent: any) => {
      const result = await pool.query(
        "SELECT * FROM FundingSources WHERE source_id = $1",
        [parent.funding_source_id]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    functionalClassification: async (parent: any) => {
      const result = await pool.query(
        "SELECT * FROM FunctionalClassifications WHERE functional_code = $1",
        [parent.functional_code]
      );
      return result.rows.length ? result.rows[0] : null;
    },
    economicClassification: async (parent: any) => {
      if (!parent.economic_code) return null;

      const result = await pool.query(
        "SELECT * FROM EconomicClassifications WHERE economic_code = $1",
        [parent.economic_code]
      );
      return result.rows.length ? result.rows[0] : null;
    },
  },
};
