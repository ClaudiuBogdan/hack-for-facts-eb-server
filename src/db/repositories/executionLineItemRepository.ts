import pool from "../connection";
import { Entity, ExecutionLineItem } from "../models";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter } from "../../types";

const analyticsCache = createCache({
  name: 'executionLineItemAnalytics',
  maxSize: 150 * 1024 * 1024, // analytics scalars & trends fit in smaller cache
  maxItems: 20000,
});

const executionLineItemCache = createCache<ExecutionLineItem[]>({
  name: 'executionLineItem',
  maxSize: 100 * 1024 * 1024,
  maxItems: 10000,
});
const countCache = createCache<{ count: number }>({
  name: 'executionLineItemCount',
  maxSize: 20 * 1024 * 1024,
  maxItems: 20000,
});

// --- Constants for Table and View Names ---
const TABLES = {
  EXECUTION_LINE_ITEMS: 'ExecutionLineItems',
  ENTITIES: 'Entities',
  REPORTS: 'Reports',
  UATS: 'UATs',
  VW_BUDGET_SUMMARY: 'vw_BudgetSummary_ByEntityPeriod',
} as const;

// --- Type-Safe Sorting Definitions ---
const SORTABLE_FIELDS = [
  'line_item_id',
  'report_id',
  'entity_cui',
  'funding_source_id',
  'functional_code',
  'economic_code',
  'account_category',
  'amount',
  'program_code',
  'year',
] as const;

const VALID_ACCOUNT_CATEGORIES = ['vn', 'ch'] as const;
const VALID_REPORT_TYPES = [
  'Executie bugetara agregata la nivel de ordonator principal',
  'Executie bugetara detaliata'
];

type SortableField = typeof SORTABLE_FIELDS[number];

// Interface for specifying sort order with enhanced type safety
export interface SortOrderOption {
  by: SortableField;
  order: 'ASC' | 'DESC';
}

// --- Filter and Model Interfaces ---
// Use unified AnalyticsFilter

export interface YearlyFinancials {
  year: number;
  totalIncome: number;
  totalExpenses: number;
  budgetBalance: number;
}

/**
 * Builds JOIN & WHERE clauses plus the parameters array for ExecutionLineItems queries.
 * Returns the constructed clauses, collected parameter values and the next positional
 * parameter index so that callers can continue adding placeholders (e.g. for LIMIT/OFFSET).
 */
const buildExecutionLineItemFilterQuery = (
  filters: Partial<AnalyticsFilter>,
  initialParamIndex: number = 1
): {
  joinClauses: string;
  whereClause: string;
  values: any[];
  nextParamIndex: number;
} => {
  const joinsMap = new Map<string, string>();
  const conditions: string[] = [];
  const values: any[] = [];
  let paramIndex = initialParamIndex;

  const ensureJoin = (alias: string, joinStatement: string) => {
    if (!joinsMap.has(alias)) {
      joinsMap.set(alias, joinStatement);
    }
  };

  // ---------- Basic column filters on ExecutionLineItems (eli) ----------
  if (filters.entity_cuis?.length) {
    conditions.push(`eli.entity_cui = ANY($${paramIndex++}::text[])`);
    values.push(filters.entity_cuis);
  }

  if (filters.report_ids?.length) {
    conditions.push(`eli.report_id = ANY($${paramIndex++}::text[])`);
    values.push(filters.report_ids);
  }

  if (filters.report_type) {
    conditions.push(`eli.report_type = $${paramIndex++}`);
    values.push(String(filters.report_type));
  }

  if (filters.funding_source_ids?.length) {
    conditions.push(`eli.funding_source_id = ANY($${paramIndex++}::int[])`);
    values.push(filters.funding_source_ids);
  }

  if (filters.budget_sector_ids?.length) {
    conditions.push(`eli.budget_sector_id = ANY($${paramIndex++}::int[])`);
    values.push(filters.budget_sector_ids);
  }

  // ---------- Functional & economic codes ----------
  if (filters.functional_codes?.length) {
    conditions.push(`eli.functional_code = ANY($${paramIndex++}::text[])`);
    values.push(filters.functional_codes);
  }

  if (filters.functional_prefixes?.length) {
    const patterns = filters.functional_prefixes.map((p) => `${p}%`);
    conditions.push(`eli.functional_code LIKE ANY($${paramIndex++}::text[])`);
    values.push(patterns);
  }

  if (filters.economic_codes?.length) {
    conditions.push(`eli.economic_code = ANY($${paramIndex++}::text[])`);
    values.push(filters.economic_codes);
  }

  if (filters.economic_prefixes?.length) {
    const patterns = filters.economic_prefixes.map((p) => `${p}%`);
    conditions.push(`eli.economic_code LIKE ANY($${paramIndex++}::text[])`);
    values.push(patterns);
  }

  // ---------- Account categories & expense types ----------
  if (filters.account_category) {
    conditions.push(`eli.account_category = $${paramIndex++}`);
    values.push(filters.account_category);
  }

  if (filters.expense_types?.length) {
    conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
    values.push(filters.expense_types);
  }

  // ---------- Amount range ----------
  if (filters.item_min_amount !== undefined && filters.item_min_amount !== null) {
    conditions.push(`eli.amount >= $${paramIndex++}`);
    values.push(filters.item_min_amount);
  }

  if (filters.item_max_amount !== undefined && filters.item_max_amount !== null) {
    conditions.push(`eli.amount <= $${paramIndex++}`);
    values.push(filters.item_max_amount);
  }

  // ---------- Program code ----------
  if (filters.program_codes?.length) {
    conditions.push(`eli.program_code = ANY($${paramIndex++}::text[])`);
    values.push(filters.program_codes);
  }

  // ---------- Year filters ----------
  if (filters.years?.length) {
    conditions.push(`eli.year = ANY($${paramIndex++}::int[])`);
    values.push(filters.years);
  }

  // ---------- Joined Filters (Entities, Reports, UATs) ----------

  // Grouped check for any filter requiring a JOIN on the Entities table
  if (
    filters.entity_types?.length ||
    filters.is_uat !== undefined ||
    (filters.county_codes && filters.county_codes.length > 0) ||
    filters.uat_ids?.length
  ) {
    ensureJoin("e", `JOIN ${TABLES.ENTITIES} e ON eli.entity_cui = e.cui`);
  }

  if (filters.entity_types?.length) {
    conditions.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
    values.push(filters.entity_types);
  }

  if (filters.is_uat !== undefined) {
    conditions.push(`e.is_uat = $${paramIndex++}`);
    values.push(filters.is_uat);
  }

  if (filters.uat_ids?.length) {
    conditions.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
    values.push(filters.uat_ids);
  }

  if (filters.county_codes?.length) {
    ensureJoin("u", `JOIN ${TABLES.UATS} u ON e.uat_id = u.id`);
    conditions.push(`u.county_code = ANY($${paramIndex++}::text[])`);
    values.push(filters.county_codes);
  }

  if (filters.reporting_years?.length) {
    ensureJoin("r", `JOIN ${TABLES.REPORTS} r ON eli.report_id = r.report_id`);
    conditions.push(`r.reporting_year = ANY($${paramIndex++}::int[])`);
    values.push(filters.reporting_years);
  }

  // ---------- Finalise query pieces ----------
  const joinClauses = Array.from(joinsMap.values()).join(" ");
  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  return { joinClauses, whereClause, values, nextParamIndex: paramIndex };
};

export const executionLineItemRepository = {
  async getAll(
    filters: Partial<AnalyticsFilter>,
    sort?: SortOrderOption,
    limit?: number,
    offset?: number
  ): Promise<ExecutionLineItem[]> {
    try {
      let querySelect = "SELECT eli.*";
      let queryFrom = ` FROM ${TABLES.EXECUTION_LINE_ITEMS} eli`;

      const {
        joinClauses,
        whereClause,
        values,
        nextParamIndex,
      } = buildExecutionLineItemFilterQuery(filters);

      let paramIndex = nextParamIndex;

      let finalQuery =
        querySelect +
        queryFrom +
        (joinClauses ? " " + joinClauses : "") +
        whereClause;

      // Determine sort order using type-safe fields
      let orderByClause: string;
      if (sort && SORTABLE_FIELDS.includes(sort.by)) {
        // The 'order' property is guaranteed to be 'ASC' or 'DESC' by the type
        orderByClause = `ORDER BY eli.${sort.by} ${sort.order}`;
      } else {
        orderByClause = 'ORDER BY eli.year DESC, eli.amount DESC';
      }
      finalQuery += ` ${orderByClause}`;

      if (limit !== undefined) {
        finalQuery += ` LIMIT $${paramIndex++}`;
        values.push(limit);
      }

      if (offset !== undefined) {
        finalQuery += ` OFFSET $${paramIndex++}`;
        values.push(offset);
      }

      const cacheKey = `getAll:${finalQuery}:${JSON.stringify(values)}`;
      const cached = executionLineItemCache.get(cacheKey);
      if (cached) {
        return cached;
      }

      const result = await pool.query(finalQuery, values);
      executionLineItemCache.set(cacheKey, result.rows);
      return result.rows;
    } catch (error) {
      console.error("Error fetching execution line items:", error);
      throw error;
    }
  },

  async getById(lineItemId: number): Promise<ExecutionLineItem | null> {
    try {
      const result = await pool.query(
        `SELECT * FROM ${TABLES.EXECUTION_LINE_ITEMS} WHERE line_item_id = $1`,
        [lineItemId]
      );
      return result.rows.length ? result.rows[0] : null;
    } catch (error) {
      console.error(
        `Error fetching execution line item with ID: ${lineItemId}`,
        error
      );
      throw error;
    }
  },

  async getByReportId(reportId: string): Promise<ExecutionLineItem[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM ${TABLES.EXECUTION_LINE_ITEMS} WHERE report_id = $1`,
        [reportId]
      );
      return result.rows;
    } catch (error) {
      console.error(
        `Error fetching execution line items for report ID: ${reportId}`,
        error
      );
      throw error;
    }
  },

  async count(
    filters: Partial<AnalyticsFilter> = {}
  ): Promise<number> {
    try {
      const querySelect = "SELECT COUNT(eli.line_item_id) as count";
      const queryFrom = ` FROM ${TABLES.EXECUTION_LINE_ITEMS} eli`;

      const { joinClauses, whereClause, values } = buildExecutionLineItemFilterQuery(
        filters as AnalyticsFilter
      );

      const finalQuery =
        querySelect +
        queryFrom +
        (joinClauses ? " " + joinClauses : "") +
        whereClause;

      const cacheKey = `count:${finalQuery}:${JSON.stringify(values)}`;
      const cached = countCache.get(cacheKey);
      if (cached) {
        return cached.count;
      }

      const result = await pool.query(finalQuery, values);
      const count = parseInt(result.rows[0].count, 10);
      countCache.set(cacheKey, { count });
      return count;
    } catch (error) {
      console.error("Error counting execution line items:", error);
      throw error;
    }
  },

  // --- Functions for analytics ---
  async getYearlySnapshotTotals(entityCui: string, year: number): Promise<{ totalIncome: number; totalExpenses: number }> {
    const query = `
      SELECT 
        COALESCE(SUM(total_income), 0) AS "totalIncome",
        COALESCE(SUM(total_expense), 0) AS "totalExpenses"
      FROM ${TABLES.VW_BUDGET_SUMMARY}
      WHERE entity_cui = $1 AND reporting_year = $2;
    `;
    try {
      const result = await pool.query(query, [entityCui, year]);
      if (result.rows.length > 0) {
        return {
          totalIncome: parseFloat(result.rows[0].totalIncome),
          totalExpenses: parseFloat(result.rows[0].totalExpenses),
        };
      }
      return { totalIncome: 0, totalExpenses: 0 };
    } catch (error) {
      console.error(
        `Error fetching yearly snapshot totals for entity ${entityCui}, year ${year}:`,
        error
      );
      throw error;
    }
  },

  async getYearlyFinancialTrends(
    entityCui: string,
    startYear: number,
    endYear: number
  ): Promise<YearlyFinancials[]> {
    const query = `
      SELECT 
        reporting_year AS year,
        COALESCE(SUM(total_income), 0) AS "totalIncome",
        COALESCE(SUM(total_expense), 0) AS "totalExpenses",
        COALESCE(SUM(budget_balance), 0) AS "budgetBalance"
      FROM ${TABLES.VW_BUDGET_SUMMARY}
      WHERE entity_cui = $1 
        AND reporting_year BETWEEN $2 AND $3
      GROUP BY reporting_year
      ORDER BY reporting_year ASC;
    `;
    try {
      const result = await pool.query(query, [entityCui, startYear, endYear]);
      return result.rows.map(row => ({
        year: parseInt(row.year, 10),
        totalIncome: parseFloat(row.totalIncome),
        totalExpenses: parseFloat(row.totalExpenses),
        budgetBalance: parseFloat(row.budgetBalance),
      }));
    } catch (error) {
      console.error(
        `Error fetching yearly financial trends for entity ${entityCui} (${startYear}-${endYear}):`,
        error
      );
      throw error;
    }
  },

  async getYearlyTrend(filters: AnalyticsFilter): Promise<{ year: number; value: number }[]> {
    const cacheKey = getCacheKey(filters);
    const cachedValue = analyticsCache.get(cacheKey);
    if (cachedValue) {
      return cachedValue;
    }

    validateAggregatedFilters(filters);
    const { joinClauses, whereClause, values } = buildExecutionLineItemFilterQuery(filters);
    const query = `SELECT eli.year, COALESCE(SUM(eli.amount), 0) AS total_amount FROM ${TABLES.EXECUTION_LINE_ITEMS} eli ${joinClauses} ${whereClause} GROUP BY eli.year ORDER BY eli.year ASC`;
    const result = await pool.query(query, values);
    const yearlyTrend = result.rows.map(row => ({ year: parseInt(row.year, 10), value: parseFloat(row.total_amount) }));

    analyticsCache.set(cacheKey, yearlyTrend);
    return yearlyTrend;
  },
};

function validateAggregatedFilters(filters: AnalyticsFilter) {
  if (!filters.account_category || !VALID_ACCOUNT_CATEGORIES.includes(filters.account_category)) {
    throw new Error(`getTotalAmount and getYearlyTrend require account_category of "ch" or "vn"`);
  }
}
