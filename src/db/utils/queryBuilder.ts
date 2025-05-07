/**
 * Builds a WHERE clause and parameter array from a filter object.
 * Handles basic equality, IN clauses for arrays, and range checks.
 * IMPORTANT: Does not prevent SQL injection for keys, assumes keys are safe.
 * Values are parameterized.
 */
export const buildWhereClause = (
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
export const buildOrderByClause = (
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

// Whitelist definitions for allowed metrics in different views
export const allowedMetrics = {
  uat: [
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
  ],
  county: [
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
  ],
  category: [
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
  ],
  entity: ["entity_name", "total_income", "total_expense", "budget_balance"],
};
