import pool from "../connection";
import { ExecutionLineItem } from "../models";

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

type SortableField = typeof SORTABLE_FIELDS[number];

// Interface for specifying sort order with enhanced type safety
export interface SortOrderOption {
  by: SortableField;
  order: 'ASC' | 'DESC';
}

// --- Filter and Model Interfaces ---
export interface ExecutionLineItemFilter {
  report_id?: string;
  report_ids?: string[];
  entity_cuis?: string[];
  funding_source_id?: number;
  functional_codes?: string[];
  economic_codes?: string[];
  account_categories?: ("vn" | "ch")[];
  min_amount?: number;
  max_amount?: number;
  program_code?: string;
  reporting_year?: number;
  county_code?: string;
  uat_ids?: number[];
  year?: number;
  years?: number[];
  start_year?: number;
  end_year?: number;
  entity_type?: string;
  is_uat?: boolean;
  is_main_creditor?: boolean;
  functional_prefixes?: string[];
  economic_prefixes?: string[];
  budget_sector_id?: number;
  budget_sector_ids?: number[];
  expense_types?: string[];
}

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
  filters: ExecutionLineItemFilter,
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

  if (filters.report_id) {
    conditions.push(`eli.report_id = $${paramIndex++}`);
    values.push(filters.report_id);
  }

  if (filters.report_ids?.length) {
    conditions.push(`eli.report_id = ANY($${paramIndex++}::int[])`);
    values.push(filters.report_ids);
  }

  if (filters.funding_source_id) {
    conditions.push(`eli.funding_source_id = $${paramIndex++}`);
    values.push(filters.funding_source_id);
  }

  if (filters.budget_sector_id) {
    conditions.push(`eli.budget_sector_id = $${paramIndex++}`);
    values.push(filters.budget_sector_id);
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
  if (filters.account_categories?.length) {
    conditions.push(`eli.account_category = ANY($${paramIndex++}::text[])`);
    values.push(filters.account_categories);
  }

  if (filters.expense_types?.length) {
    conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
    values.push(filters.expense_types);
  }

  // ---------- Amount range ----------
  if (filters.min_amount !== undefined) {
    conditions.push(`eli.amount >= $${paramIndex++}`);
    values.push(filters.min_amount);
  }

  if (filters.max_amount !== undefined) {
    conditions.push(`eli.amount <= $${paramIndex++}`);
    values.push(filters.max_amount);
  }

  // ---------- Program code ----------
  if (filters.program_code) {
    conditions.push(`eli.program_code = $${paramIndex++}`);
    values.push(filters.program_code);
  }

  // ---------- Year filters ----------
  if (filters.year !== undefined) {
    conditions.push(`eli.year = $${paramIndex++}`);
    values.push(filters.year);
  }

  if (filters.years?.length) {
    conditions.push(`eli.year = ANY($${paramIndex++}::int[])`);
    values.push(filters.years);
  }

  if (filters.start_year !== undefined) {
    conditions.push(`eli.year >= $${paramIndex++}`);
    values.push(filters.start_year);
  }

  if (filters.end_year !== undefined) {
    conditions.push(`eli.year <= $${paramIndex++}`);
    values.push(filters.end_year);
  }

  // ---------- Joined Filters (Entities, Reports, UATs) ----------

  // Grouped check for any filter requiring a JOIN on the Entities table
  if (
    filters.entity_type !== undefined ||
    filters.is_uat !== undefined ||
    filters.is_main_creditor !== undefined ||
    filters.county_code ||
    filters.uat_ids?.length
  ) {
    ensureJoin("e", `JOIN ${TABLES.ENTITIES} e ON eli.entity_cui = e.cui`);
  }

  if (filters.entity_type) {
    conditions.push(`e.entity_type = $${paramIndex++}`);
    values.push(filters.entity_type);
  }

  if (filters.is_uat !== undefined) {
    conditions.push(`e.is_uat = $${paramIndex++}`);
    values.push(filters.is_uat);
  }

  if (filters.is_main_creditor !== undefined) {
    conditions.push(`e.is_main_creditor = $${paramIndex++}`);
    values.push(filters.is_main_creditor);
  }

  if (filters.uat_ids?.length) {
    conditions.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
    values.push(filters.uat_ids);
  }

  if (filters.county_code) {
    ensureJoin("u", `JOIN ${TABLES.UATS} u ON e.uat_id = u.id`);
    conditions.push(`u.county_code = $${paramIndex++}`);
    values.push(filters.county_code);
  }

  if (filters.reporting_year !== undefined) {
    ensureJoin("r", `JOIN ${TABLES.REPORTS} r ON eli.report_id = r.report_id`);
    conditions.push(`r.reporting_year = $${paramIndex++}`);
    values.push(filters.reporting_year);
  }

  // ---------- Finalise query pieces ----------
  const joinClauses = Array.from(joinsMap.values()).join(" ");
  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

  return { joinClauses, whereClause, values, nextParamIndex: paramIndex };
};

export const executionLineItemRepository = {
  async getAll(
    filters: ExecutionLineItemFilter,
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

      const result = await pool.query(finalQuery, values);
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
    filters: Partial<ExecutionLineItemFilter> = {}
  ): Promise<number> {
    try {
      const querySelect = "SELECT COUNT(eli.line_item_id) as count";
      const queryFrom = ` FROM ${TABLES.EXECUTION_LINE_ITEMS} eli`;

      const { joinClauses, whereClause, values } = buildExecutionLineItemFilterQuery(
        filters as ExecutionLineItemFilter
      );

      const finalQuery =
        querySelect +
        queryFrom +
        (joinClauses ? " " + joinClauses : "") +
        whereClause;

      const result = await pool.query(finalQuery, values);
      return parseInt(result.rows[0].count);
    } catch (error) {
      console.error("Error counting execution line items:", error);
      throw error;
    }
  },

  // --- Functions for analytics ---

  async getTotalsByCategory(
    reportId: string
  ): Promise<{ account_category: "vn" | "ch"; total: number }[]> {
    try {
      const query = `
        SELECT account_category, SUM(amount) as total
        FROM ${TABLES.EXECUTION_LINE_ITEMS}
        WHERE report_id = $1
        GROUP BY account_category
      `;
      const result = await pool.query(query, [reportId]);
      return result.rows;
    } catch (error) {
      console.error(
        `Error calculating totals for report ID: ${reportId}`,
        error
      );
      throw error;
    }
  },

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
};
