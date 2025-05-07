import pool from "../../db/connection"; // Assuming pool is your configured pg Pool
import {
  uatRepository,
  functionalClassificationRepository,
  economicClassificationRepository,
  fundingSourceRepository,
} from "../../db/repositories"; // Assuming repository exists

// Import the extracted utility functions
import {
  buildWhereClause,
  buildOrderByClause,
  allowedMetrics,
} from "../../db/utils/queryBuilder";

// --- Helper Functions (Ideally in a separate utils/queryBuilder.ts file) ---

/**
 * Builds a WHERE clause and parameter array from a filter object.
 * Handles basic equality, IN clauses for arrays, and range checks.
 * IMPORTANT: Does not prevent SQL injection for keys, assumes keys are safe.
 * Values are parameterized.
 */
const buildWhereClauseInternal = (
  filter: Record<string, any>,
  paramIndexStart: number = 1
): { clause: string; params: any[] } => {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = paramIndexStart;

  for (const key in filter) {
    const value = filter[key];
    if (value === undefined || value === null) continue;

    // --- Handle specific filter keys ---
    if (
      key.endsWith("_ids") ||
      key.endsWith("_codes") ||
      key.endsWith("_years") ||
      key.endsWith("_periods") ||
      key.endsWith("_names") ||
      key.endsWith("_regions")
    ) {
      // Handle array inputs for IN clause
      const actualKey = key.replace(
        /_(ids|codes|years|periods|names|regions)$/,
        ""
      );
      if (Array.isArray(value) && value.length > 0) {
        conditions.push(
          `"${actualKey}" = ANY($${paramIndex++})` // Use ANY for array comparison
        );
        params.push(value);
      }
    } else if (key === "min_population" || key === "min_amount") {
      const actualKey = key.startsWith("min_") ? key.substring(4) : key;
      conditions.push(`"${actualKey}" >= $${paramIndex++}`);
      params.push(value);
    } else if (key === "max_population" || key === "max_amount") {
      const actualKey = key.startsWith("max_") ? key.substring(4) : key;
      conditions.push(`"${actualKey}" <= $${paramIndex++}`);
      params.push(value);
    } else if (key === "report_date_start") {
      conditions.push(`"report_date" >= $${paramIndex++}`);
      params.push(value);
    } else if (key === "report_date_end") {
      conditions.push(`"report_date" <= $${paramIndex++}`);
      params.push(value);
    } else {
      // Default to equality
      conditions.push(`"${key}" = $${paramIndex++}`);
      params.push(value);
    }
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
};

/**
 * Builds an ORDER BY clause from a sortBy array.
 * IMPORTANT: Whitelists allowed metric names to prevent SQL injection.
 */
const buildOrderByClauseInternal = (
  sortBy: { metric: string; direction: "ASC" | "DESC" }[] | undefined,
  allowedMetrics: string[]
): string => {
  if (!sortBy || sortBy.length === 0) {
    return "";
  }

  const sortTerms = sortBy
    .map((sort) => {
      // Whitelist check
      if (!allowedMetrics.includes(sort.metric)) {
        console.warn(`Sorting by disallowed metric: ${sort.metric}`);
        return null; // Skip this sort term
      }
      // Ensure direction is valid
      const direction = sort.direction === "DESC" ? "DESC" : "ASC";
      // Quote the column name to handle potential reserved keywords or special chars
      return `"${sort.metric}" ${direction}`;
    })
    .filter((term) => term !== null); // Filter out any null terms

  return sortTerms.length > 0 ? `ORDER BY ${sortTerms.join(", ")}` : "";
};

// Allowed sortable metrics for each view (prevents SQL injection)
const allowedUatMetrics = [
  "reporting_year",
  "reporting_period",
  "uat_name",
  "county_name",
  "uat_region",
  "uat_population",
  "total_income",
  "total_expense",
  "budget_balance",
  "per_capita_income",
  "per_capita_expense",
];
const allowedCountyMetrics = [
  "reporting_year",
  "reporting_period",
  "county_name",
  "uat_region",
  "total_county_population",
  "total_income",
  "total_expense",
  "budget_balance",
  "per_capita_income",
  "per_capita_expense",
];
const allowedCategoryMetrics = [
  "reporting_year",
  "reporting_period",
  "account_category",
  "functional_name",
  "economic_name",
  "funding_source",
  "county_name",
  "uat_region",
  "total_amount",
  "contributing_entities_count",
];

// --- Resolver Implementation ---

export const analyticsResolver = {
  Query: {
    // Query for UAT Aggregated Metrics
    uatAggregatedMetrics: async (
      _: any,
      {
        filter = {},
        sortBy,
        limit = 20,
        offset = 0,
      }: {
        filter: any;
        sortBy?: { metric: string; direction: "ASC" | "DESC" }[];
        limit: number;
        offset: number;
      }
    ) => {
      try {
        // Build WHERE clause
        const { clause: whereClause, params: whereParams } = buildWhereClause(
          filter,
          1
        );

        // Build ORDER BY clause
        const orderByClause = buildOrderByClause(sortBy, allowedMetrics.uat);

        // --- Query for data nodes ---
        const dataQuery = `
          SELECT * FROM vw_UAT_Aggregated_Metrics
          ${whereClause}
          ${orderByClause}
          LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}
        `;
        const dataParams = [...whereParams, limit, offset];
        const dataResult = await pool.query(dataQuery, dataParams);

        // --- Query for total count ---
        const countQuery = `
          SELECT COUNT(*) FROM vw_UAT_Aggregated_Metrics
          ${whereClause}
        `;
        const countResult = await pool.query(countQuery, whereParams);
        const totalCount = parseInt(countResult.rows[0].count, 10);

        return {
          nodes: dataResult.rows,
          pageInfo: {
            totalCount,
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
          },
        };
      } catch (error) {
        console.error("Error fetching UAT aggregated metrics:", error);
        throw new Error("Failed to fetch UAT aggregated metrics");
      }
    },

    // Query for County Aggregated Metrics
    countyAggregatedMetrics: async (
      _: any,
      {
        filter = {},
        sortBy,
        limit = 20,
        offset = 0,
      }: {
        filter: any;
        sortBy?: { metric: string; direction: "ASC" | "DESC" }[];
        limit: number;
        offset: number;
      }
    ) => {
      try {
        const { clause: whereClause, params: whereParams } = buildWhereClause(
          filter,
          1
        );
        const orderByClause = buildOrderByClause(sortBy, allowedMetrics.county);

        const dataQuery = `
              SELECT * FROM vw_County_Aggregated_Metrics
              ${whereClause}
              ${orderByClause}
              LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}
            `;
        const dataParams = [...whereParams, limit, offset];
        const dataResult = await pool.query(dataQuery, dataParams);

        const countQuery = `
              SELECT COUNT(*) FROM vw_County_Aggregated_Metrics
              ${whereClause}
            `;
        const countResult = await pool.query(countQuery, whereParams);
        const totalCount = parseInt(countResult.rows[0].count, 10);

        return {
          nodes: dataResult.rows,
          pageInfo: {
            totalCount,
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
          },
        };
      } catch (error) {
        console.error("Error fetching County aggregated metrics:", error);
        throw new Error("Failed to fetch County aggregated metrics");
      }
    },

    // Query for Category Aggregated Metrics
    categoryAggregatedMetrics: async (
      _: any,
      {
        filter = {},
        sortBy,
        limit = 50,
        offset = 0,
      }: {
        filter: any;
        sortBy?: { metric: string; direction: "ASC" | "DESC" }[];
        limit: number;
        offset: number;
      }
    ) => {
      try {
        const { clause: whereClause, params: whereParams } = buildWhereClause(
          filter,
          1
        );
        const orderByClause = buildOrderByClause(
          sortBy,
          allowedMetrics.category
        );

        const dataQuery = `
              SELECT * FROM vw_Category_Aggregated_Metrics
              ${whereClause}
              ${orderByClause}
              LIMIT $${whereParams.length + 1} OFFSET $${whereParams.length + 2}
            `;
        const dataParams = [...whereParams, limit, offset];
        const dataResult = await pool.query(dataQuery, dataParams);

        const countQuery = `
              SELECT COUNT(*) FROM vw_Category_Aggregated_Metrics
              ${whereClause}
            `;
        const countResult = await pool.query(countQuery, whereParams);
        const totalCount = parseInt(countResult.rows[0].count, 10);

        return {
          nodes: dataResult.rows,
          pageInfo: {
            totalCount,
            hasNextPage: offset + limit < totalCount,
            hasPreviousPage: offset > 0,
          },
        };
      } catch (error) {
        console.error("Error fetching Category aggregated metrics:", error);
        throw new Error("Failed to fetch Category aggregated metrics");
      }
    },

    // Query for Time Series Data
    metricTimeSeries: async (
      _: any,
      {
        metric,
        groupBy,
        filter = {},
      }: {
        metric: string; // e.g., "total_expense", "per_capita_income"
        groupBy: string; // e.g., "year", "period"
        filter: any;
      }
    ) => {
      try {
        // Determine the source view and allowed metrics based on filter context
        let sourceView = "vw_UAT_Aggregated_Metrics"; // Default
        let metricWhitelist = allowedMetrics.uat;

        if (filter.county_code || filter.county_codes) {
          sourceView = "vw_County_Aggregated_Metrics";
          metricWhitelist = allowedMetrics.county;
        }

        // Whitelist the metric to prevent SQL injection
        if (!metricWhitelist.includes(metric)) {
          throw new Error(`Metric "${metric}" is not allowed for time series.`);
        }

        // Determine grouping columns
        let groupByCols: string[];
        if (groupBy === "period") {
          groupByCols = ["reporting_year", "reporting_period"];
        } else if (groupBy === "year") {
          groupByCols = ["reporting_year"];
        } else {
          throw new Error(
            `Invalid groupBy value: "${groupBy}". Use "year" or "period".`
          );
        }
        const groupByClause = `GROUP BY ${groupByCols
          .map((col) => `"${col}"`)
          .join(", ")}`;
        const orderByClause = `ORDER BY ${groupByCols
          .map((col) => `"${col}"`)
          .join(", ")}`;

        // Build WHERE clause
        const { clause: whereClause, params: whereParams } = buildWhereClause(
          filter,
          1
        );

        // Construct the aggregation query
        // Use SUM for totals, AVG for per_capita (assuming view already calculated per_capita correctly)
        const aggregateFunction = metric.startsWith("per_capita_")
          ? "AVG"
          : "SUM";

        const query = `
          SELECT
            ${groupByCols.map((col) => `"${col}"`).join(", ")},
            ${aggregateFunction}("${metric}") as value
          FROM ${sourceView}
          ${whereClause}
          ${groupByClause}
          ${orderByClause}
        `;

        const result = await pool.query(query, whereParams);

        // Map results to TimeSeriesDataPoint format
        return result.rows.map((row) => ({
          year: row.reporting_year,
          period: row.reporting_period || "Annual", // Provide default if grouping only by year
          value: parseFloat(row.value) || 0,
        }));
      } catch (error) {
        console.error("Error fetching metric time series:", error);
        throw new Error("Failed to fetch metric time series");
      }
    },

    // Query for Comparing Items
    compareItems: async (
      _: any,
      {
        itemType,
        itemIds,
        metrics,
        reporting_year,
        reporting_period,
      }: {
        itemType: string; // "UAT" or "Entity"
        itemIds: (string | number)[];
        metrics: string[];
        reporting_year: number;
        reporting_period: string;
      }
    ) => {
      try {
        let sourceView: string;
        let idColumn: string;
        let nameColumn: string;
        let metricWhitelist: string[];
        let baseFilter: Record<string, any> = {
          reporting_year,
          reporting_period,
        };

        if (itemType === "UAT") {
          sourceView = "vw_UAT_Aggregated_Metrics";
          idColumn = "uat_id";
          nameColumn = "uat_name";
          metricWhitelist = allowedMetrics.uat;
          baseFilter[idColumn] = itemIds; // Filter by uat_ids
        } else if (itemType === "Entity") {
          // Use vw_BudgetSummary_ByEntityPeriod for entity comparison
          sourceView = "vw_BudgetSummary_ByEntityPeriod";
          idColumn = "entity_cui";
          nameColumn = "entity_name";
          metricWhitelist = allowedMetrics.entity;
          baseFilter[idColumn] = itemIds; // Filter by entity_cuis
        } else {
          throw new Error(
            `Invalid itemType: "${itemType}". Use "UAT" or "Entity".`
          );
        }

        // Whitelist requested metrics
        const validMetrics = metrics.filter((m) => metricWhitelist.includes(m));
        if (validMetrics.length === 0) {
          throw new Error("No valid metrics requested for comparison.");
        }
        const selectMetrics = validMetrics.map((m) => `"${m}"`).join(", ");

        // Build WHERE clause including the itemIds filter
        const { clause: whereClause, params: whereParams } = buildWhereClause(
          baseFilter,
          1
        );

        const query = `
                SELECT
                    "${idColumn}" as id,
                    "${nameColumn}" as name,
                    ${selectMetrics}
                FROM ${sourceView}
                ${whereClause}
            `;

        const result = await pool.query(query, whereParams);

        // Transform the result into the ComparisonData structure
        const comparisonData: any[] = [];
        result.rows.forEach((row) => {
          validMetrics.forEach((metric) => {
            comparisonData.push({
              uat_id: parseInt(row.id),
              uat_name: row.name,
              metric_name: metric,
              value: parseFloat(row[metric]) || 0,
            });
          });
        });

        return comparisonData;
      } catch (error) {
        console.error("Error comparing items:", error);
        throw new Error("Failed to compare items");
      }
    },
  },

  // Nested Resolver for UATAggregatedMetrics.uat
  UATAggregatedMetrics: {
    uat: async (parent: { uat_id: number }) => {
      if (!parent.uat_id) return null;
      try {
        return uatRepository.getById(parent.uat_id);
      } catch (error) {
        console.error(`Error fetching UAT for uat_id ${parent.uat_id}:`, error);
        return null;
      }
    },
  },

  // Add nested resolvers for CategoryAggregatedMetrics relations
  CategoryAggregatedMetrics: {
    // Relationship to the functional classification
    functionalClassification: async (parent: { functional_code: string }) => {
      if (!parent.functional_code) return null;
      try {
        return functionalClassificationRepository.getByCode(
          parent.functional_code
        );
      } catch (error) {
        console.error(
          `Error fetching FunctionalClassification for code ${parent.functional_code}:`,
          error
        );
        return null;
      }
    },

    // Relationship to the economic classification (which may be null)
    economicClassification: async (parent: {
      economic_code: string | null;
    }) => {
      if (!parent.economic_code) return null;
      try {
        return economicClassificationRepository.getByCode(parent.economic_code);
      } catch (error) {
        console.error(
          `Error fetching EconomicClassification for code ${parent.economic_code}:`,
          error
        );
        return null;
      }
    },

    // Relationship to the funding source - name alignment with GQL schema (fundingSource, not fundingSourceInfo)
    fundingSource: async (parent: { funding_source_id: number }) => {
      if (!parent.funding_source_id) return null;
      try {
        return fundingSourceRepository.getById(parent.funding_source_id);
      } catch (error) {
        console.error(
          `Error fetching FundingSource for id ${parent.funding_source_id}:`,
          error
        );
        return null;
      }
    },
  },
};
