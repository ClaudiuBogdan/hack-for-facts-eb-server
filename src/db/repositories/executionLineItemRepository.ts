import pool from "../connection";
import { ExecutionLineItem } from "../models";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter, NormalizationMode, ReportPeriodInput, ReportPeriodType } from "../../types";
import { buildPeriodFilterSql, getEurRateMap } from "./utils";

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
  VW_BUDGET_SUMMARY: 'mv_summary_annual',
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
  'ytd_amount',
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

export interface PeriodFinancials {
  year: number;
  month?: number;
  quarter?: number;
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

  // ---------- CRITICAL: Order filters to match index ----------
  // Index: (is_yearly, is_quarterly, account_category, report_type, functional_code, economic_code, entity_cui)

  // 1. Period flags FIRST (is_yearly/is_quarterly) - matches index prefix
  if (!filters.report_period) {
    throw new Error("report_period is required for analytics.");
  }

  if (filters.report_period.type === 'YEAR') {
    conditions.push(`eli.is_yearly = true`);
  } else if (filters.report_period.type === 'QUARTER') {
    conditions.push(`eli.is_quarterly = true`);
  }

  // 2. Period filters (year/month/quarter) for partition pruning
  const periodSql = buildPeriodFilterSql(filters.report_period, paramIndex);
  if (periodSql.clause) {
    conditions.push(periodSql.clause);
    values.push(...periodSql.values);
    paramIndex = periodSql.nextParamIndex;
  }

  // 3. account_category (if present, comes next in index)
  if (filters.account_category) {
    conditions.push(`eli.account_category = $${paramIndex++}`);
    values.push(filters.account_category);
  }

  // 4. report_type (next in index)
  if (filters.report_type) {
    conditions.push(`eli.report_type = $${paramIndex++}`);
    values.push(String(filters.report_type));
  } else {
    throw new Error("report_type is required for analytics.");
  }

  if (filters.entity_cuis?.length) {
    conditions.push(`eli.entity_cui = ANY($${paramIndex++}::text[])`);
    values.push(filters.entity_cuis);
  }

  if (filters.main_creditor_cui) {
    conditions.push(`eli.main_creditor_cui = $${paramIndex++}`);
    values.push(filters.main_creditor_cui);
  }

  if (filters.report_ids?.length) {
    conditions.push(`eli.report_id = ANY($${paramIndex++}::text[])`);
    values.push(filters.report_ids);
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

  // ---------- Expense types ----------
  // Note: account_category is now handled earlier (line 122-125) to match index order

  if (filters.expense_types?.length) {
    conditions.push(`eli.expense_type = ANY($${paramIndex++}::text[])`);
    values.push(filters.expense_types);
  }

  // ---------- Amount range ----------
  if (filters.item_min_amount !== undefined && filters.item_min_amount !== null) {
    conditions.push(`eli.ytd_amount >= $${paramIndex++}`);
    values.push(filters.item_min_amount);
  }

  if (filters.item_max_amount !== undefined && filters.item_max_amount !== null) {
    conditions.push(`eli.ytd_amount <= $${paramIndex++}`);
    values.push(filters.item_max_amount);
  }

  // ---------- Program code ----------
  if (filters.program_codes?.length) {
    conditions.push(`eli.program_code = ANY($${paramIndex++}::text[])`);
    values.push(filters.program_codes);
  }

  // ---------- Exclusion rules on ELI fields ----------
  const { exclude } = filters;
  if (exclude) {
    if (exclude.report_ids && exclude.report_ids.length) {
      conditions.push(`NOT (eli.report_id = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.report_ids);
    }
    if (exclude.entity_cuis && exclude.entity_cuis.length) {
      conditions.push(`NOT (eli.entity_cui = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.entity_cuis);
    }
    if (exclude.main_creditor_cui) {
      conditions.push(`eli.main_creditor_cui <> $${paramIndex++}`);
      values.push(exclude.main_creditor_cui);
    }
    if (exclude.funding_source_ids && exclude.funding_source_ids.length) {
      conditions.push(`NOT (eli.funding_source_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.funding_source_ids);
    }
    if (exclude.budget_sector_ids && exclude.budget_sector_ids.length) {
      conditions.push(`NOT (eli.budget_sector_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.budget_sector_ids);
    }
    if (exclude.functional_codes && exclude.functional_codes.length) {
      conditions.push(`NOT (eli.functional_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.functional_codes);
    }
    if (exclude.functional_prefixes && exclude.functional_prefixes.length) {
      const patterns = exclude.functional_prefixes.map((p) => `${p}%`);
      conditions.push(`NOT (eli.functional_code LIKE ANY($${paramIndex++}::text[]))`);
      values.push(patterns);
    }
    if (exclude.economic_codes && exclude.economic_codes.length) {
      conditions.push(`NOT (eli.economic_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.economic_codes);
    }
    if (exclude.economic_prefixes && exclude.economic_prefixes.length) {
      const patterns = exclude.economic_prefixes.map((p) => `${p}%`);
      conditions.push(`NOT (eli.economic_code LIKE ANY($${paramIndex++}::text[]))`);
      values.push(patterns);
    }
    if (exclude.expense_types && exclude.expense_types.length) {
      conditions.push(`NOT (eli.expense_type = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.expense_types);
    }
    if (exclude.program_codes && exclude.program_codes.length) {
      conditions.push(`NOT (eli.program_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.program_codes);
    }
  }

  // ---------- Joined Filters (Entities, Reports, UATs) ----------

  // Grouped check for any filter requiring a JOIN on the Entities table
  if (
    filters.entity_types?.length ||
    filters.is_uat !== undefined ||
    (filters.county_codes && filters.county_codes.length > 0) ||
    filters.uat_ids?.length ||
    (exclude && (exclude.entity_types?.length || exclude.uat_ids?.length || exclude.county_codes?.length))
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

  // Exclusions that require joins
  if (exclude) {
    if (exclude.entity_types && exclude.entity_types.length) {
      conditions.push(`NOT (e.entity_type = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.entity_types);
    }
    if (exclude.uat_ids && exclude.uat_ids.length) {
      conditions.push(`NOT (e.uat_id = ANY($${paramIndex++}::int[]))`);
      values.push(exclude.uat_ids);
    }
    if (exclude.county_codes && exclude.county_codes.length) {
      ensureJoin("u", `JOIN ${TABLES.UATS} u ON e.uat_id = u.id`);
      conditions.push(`NOT (u.county_code = ANY($${paramIndex++}::text[]))`);
      values.push(exclude.county_codes);
    }
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
      const norm = (filters.normalization ?? 'total') as NormalizationMode;
      const cacheKey = getCacheKey({ method: 'getAll', filters, sort, limit, offset, normalization: norm });
      const cached = await executionLineItemCache.get(cacheKey);
      if (cached) {
        return cached;
      }
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
        orderByClause = 'ORDER BY eli.year DESC, eli.ytd_amount DESC';
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

      // Apply normalization if required
      if (norm !== 'total') {
        const needsPerCapita = norm === 'per_capita' || norm === 'per_capita_euro';
        const needsEuro = norm === 'total_euro' || norm === 'per_capita_euro';

        // Pre-compute population per entity when needed (using batch query to avoid N+1)
        let populationByEntity = new Map<string, number>();
        if (needsPerCapita) {
          const uniqueEntityCuis = Array.from(new Set(result.rows.map((r: any) => r.entity_cui).filter(Boolean)));
          populationByEntity = await getEntityPopulationBatch(uniqueEntityCuis);
        }
        const rateByYear = needsEuro ? getEurRateMap() : null;

        const normalized = result.rows.map((row: any) => {
          const entityPopulation = needsPerCapita ? (populationByEntity.get(row.entity_cui) ?? 0) : 0;
          const eurRate = needsEuro ? (rateByYear!.get(Number(row.year)) ?? 1) : 1;

          const normalizeValue = (value: any) => {
            let v = parseFloat(value ?? 0);
            if (needsPerCapita) {
              v = entityPopulation > 0 ? v / entityPopulation : 0;
            }
            if (needsEuro) {
              v = v / eurRate;
            }
            return v;
          };

          const ytd_amount = normalizeValue(row.ytd_amount);
          const monthly_amount = normalizeValue(row.monthly_amount);
          const quarterly_amount = row.quarterly_amount !== null && row.quarterly_amount !== undefined ? normalizeValue(row.quarterly_amount) : row.quarterly_amount;

          return {
            ...row,
            ytd_amount,
            monthly_amount,
            quarterly_amount,
          } as ExecutionLineItem;
        });

        await executionLineItemCache.set(cacheKey, normalized);
        return normalized;
      }

      await executionLineItemCache.set(cacheKey, result.rows);
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
      const cached = await countCache.get(cacheKey);
      if (cached) {
        return cached.count;
      }

      const result = await pool.query(finalQuery, values);
      const count = parseInt(result.rows[0].count, 10);
      await countCache.set(cacheKey, { count });
      return count;
    } catch (error) {
      console.error("Error counting execution line items:", error);
      throw error;
    }
  },

  // --- Functions for analytics ---
  async getPeriodSnapshotTotals(entityCui: string, period: ReportPeriodInput, reportType: string, normalization: NormalizationMode = 'total', main_creditor_cui?: string): Promise<{ totalIncome: number; totalExpenses: number; budgetBalance: number }> {
    const { viewName } = getPeriodViewInfo(period.type);

    const cacheKey = getCacheKey({ method: 'getPeriodSnapshotTotals', entityCui, period, reportType, normalization, main_creditor_cui });
    const cached = await analyticsCache.get(cacheKey);
    if (cached) {
      return cached as { totalIncome: number; totalExpenses: number; budgetBalance: number };
    }

    const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
    const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

    const periodSql = buildPeriodFilterSql(period, 3, 'v');
    let params: any[] = [entityCui, reportType, ...periodSql.values];
    let mainCreditorCondition = '';
    if (main_creditor_cui) {
      mainCreditorCondition = ` AND v.main_creditor_cui = $${params.length + 1}`;
      params.push(main_creditor_cui);
    }

    const query = (normalization === 'total')
      ? `
          SELECT 
            COALESCE(SUM(v.total_income), 0) AS "totalIncome",
            COALESCE(SUM(v.total_expense), 0) AS "totalExpenses",
            COALESCE(SUM(v.budget_balance), 0) AS "budgetBalance"
          FROM ${viewName} v
          WHERE v.entity_cui = $1 AND v.report_type = $2${periodSql.clause ? ` AND ${periodSql.clause}` : ''}${mainCreditorCondition};
        `
      : `
          SELECT 
            v.year,
            COALESCE(SUM(v.total_income), 0) AS "totalIncome",
            COALESCE(SUM(v.total_expense), 0) AS "totalExpenses",
            COALESCE(SUM(v.budget_balance), 0) AS "budgetBalance"
          FROM ${viewName} v
          WHERE v.entity_cui = $1 AND v.report_type = $2${periodSql.clause ? ` AND ${periodSql.clause}` : ''}${mainCreditorCondition}
          GROUP BY v.year;
        `;

    try {
      const result = await pool.query(query, params);

      if (normalization === 'total') {
        const row = result.rows[0] ?? { totalIncome: 0, totalExpenses: 0, budgetBalance: 0 };
        const value = {
          totalIncome: parseFloat(row.totalIncome ?? 0),
          totalExpenses: parseFloat(row.totalExpenses ?? 0),
          budgetBalance: parseFloat(row.budgetBalance ?? 0),
        };
        await analyticsCache.set(cacheKey, value);
        return value;
      }

      let population = 0;
      if (needsPerCapita) {
        population = await getEntityPopulation(entityCui);
      }
      const rateByYear = needsEuro ? getEurRateMap() : null;

      const totals = result.rows.reduce((acc, row) => {
        let { totalIncome, totalExpenses, budgetBalance } = row;
        totalIncome = parseFloat(totalIncome);
        totalExpenses = parseFloat(totalExpenses);
        budgetBalance = parseFloat(budgetBalance);
        const year = parseInt(row.year, 10);
        const rate = rateByYear?.get(year) ?? 1;

        if (needsPerCapita && population > 0) {
          totalIncome /= population;
          totalExpenses /= population;
          budgetBalance /= population;
        } else if (needsPerCapita) {
          totalIncome = 0;
          totalExpenses = 0;
          budgetBalance = 0;
        }

        if (needsEuro) {
          totalIncome /= rate;
          totalExpenses /= rate;
          budgetBalance /= rate;
        }

        acc.totalIncome += totalIncome;
        acc.totalExpenses += totalExpenses;
        acc.budgetBalance += budgetBalance;
        return acc;
      }, { totalIncome: 0, totalExpenses: 0, budgetBalance: 0 });

      await analyticsCache.set(cacheKey, totals);
      return totals;

    } catch (error) {
      console.error(`Error fetching period snapshot totals for entity ${entityCui}, period ${JSON.stringify(period)}:`, error);
      throw error;
    }
  },
  async getYearlySnapshotTotals(entityCui: string, year: number, reportType: string, main_creditor_cui?: string): Promise<{ totalIncome: number; totalExpenses: number }> {
    const params: any[] = [entityCui, year, reportType];
    let mainCreditorCondition = '';
    if (main_creditor_cui) {
      mainCreditorCondition = ` AND main_creditor_cui = $${params.length + 1}`;
      params.push(main_creditor_cui);
    }

    const query = `
      SELECT
        COALESCE(SUM(total_income), 0) AS "totalIncome",
        COALESCE(SUM(total_expense), 0) AS "totalExpenses"
      FROM ${TABLES.VW_BUDGET_SUMMARY}
      WHERE entity_cui = $1 AND year = $2 AND report_type = $3${mainCreditorCondition};
    `;
    try {
      const result = await pool.query(query, params);
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

  async getFinancialTrends(entityCui: string, reportType: string, period: ReportPeriodInput, normalization: NormalizationMode, main_creditor_cui?: string): Promise<PeriodFinancials[]> {
    const { type } = period;
    const { viewName, dateColumn, orderColumn } = getPeriodViewInfo(type);

    // Repository-level cache (L1/L2) using stable key like entityAnalyticsRepository
    const cacheKey = getCacheKey({ method: 'getFinancialTrends', entityCui, reportType, period, normalization, main_creditor_cui });
    const cached = await analyticsCache.get(cacheKey);
    if (cached) {
      return cached as PeriodFinancials[];
    }

    // Reuse shared builder to construct precise YEAR/MONTH/QUARTER filters against the view alias 'v'
    const periodSql = buildPeriodFilterSql(period, 3, 'v');
    const params: any[] = [entityCui, reportType, ...periodSql.values];
    let mainCreditorCondition = '';
    if (main_creditor_cui) {
      mainCreditorCondition = ` AND v.main_creditor_cui = $${params.length + 1}`;
      params.push(main_creditor_cui);
    }

    const query = `
      SELECT
        v.year,
        ${dateColumn ? `v.${dateColumn},` : ''}
        SUM(v.total_income) AS "totalIncome",
        SUM(v.total_expense) AS "totalExpenses",
        SUM(v.budget_balance) AS "budgetBalance"
      FROM ${viewName} v
      WHERE v.entity_cui = $1 AND v.report_type = $2${periodSql.clause ? ` AND ${periodSql.clause}` : ''}${mainCreditorCondition}
      GROUP BY v.year ${dateColumn ? `, v.${dateColumn}` : ''}
      ORDER BY v.year ASC${dateColumn ? `, v.${dateColumn} ASC` : ''};
    `;

    try {
      const result = await pool.query(query, params);

      const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
      const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';
      let population = 0;

      if (needsPerCapita) {
        population = await getEntityPopulation(entityCui);
      }

      const rateByYear = needsEuro ? getEurRateMap() : null;

      const mapped: PeriodFinancials[] = result.rows.map(row => {
        let { totalIncome, totalExpenses, budgetBalance } = row;
        totalIncome = parseFloat(totalIncome);
        totalExpenses = parseFloat(totalExpenses);
        budgetBalance = parseFloat(budgetBalance);
        const year = parseInt(row.year, 10);
        const rate = rateByYear?.get(year) ?? 1;

        if (needsPerCapita && population > 0) {
          totalIncome /= population;
          totalExpenses /= population;
          budgetBalance /= population;
        } else if (needsPerCapita) {
          totalIncome = 0;
          totalExpenses = 0;
          budgetBalance = 0;
        }

        if (needsEuro) {
          totalIncome /= rate;
          totalExpenses /= rate;
          budgetBalance /= rate;
        }

        return {
          ...row,
          totalIncome,
          totalExpenses,
          budgetBalance,
        } as PeriodFinancials;
      });

      await analyticsCache.set(cacheKey, mapped);
      return mapped;
    } catch (error) {
      console.error(`Error fetching financials for entity ${entityCui}, period ${JSON.stringify(period)}:`, error);
      throw error;
    }
  },

  /**
   * Returns a yearly time series of either:
   *  - raw totals (RON) when !needsPerCapita, or
   *  - per-capita values (RON/person) when needsPerCapita.
   *
   * Per-capita denominator rules:
   *  1) If any entity-like filter is present (entity_cuis, uat_ids, county_codes, is_uat, entity_types),
   *     the denominator equals the sum of the populations of the selected units, deduplicated by scope:
   *       - UAT entities → the UAT's population
   *       - County councils → the county's population (counted once)
   *       - Other entities → fall back to the country population
   *  2) If NO such filter is present, denominator is the country's population.
   *  3) The denominator is derived solely from filters (not from whether fiscal data exists).
   *
   * This mirrors UX: missing entity filters ⇒ country-wide per-capita.
   */
  async getYearlyTrend(filters: AnalyticsFilter): Promise<{ year: number; value: number }[]> {
    const cacheKey = getCacheKey({ method: 'getYearlyTrend', filters });
    const cachedValue = await analyticsCache.get(cacheKey);
    if (cachedValue) {
      return cachedValue;
    }

    validateAggregatedFilters(filters);
    const { joinClauses, whereClause, values } = buildExecutionLineItemFilterQuery(filters);

    const normalization = filters.normalization ?? 'total';
    const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
    const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

    let query: string;

    if (!needsPerCapita) {
      // Simple total by year
      query = `SELECT eli.year, COALESCE(SUM(eli.ytd_amount), 0) AS value
        FROM ${TABLES.EXECUTION_LINE_ITEMS} eli
        ${joinClauses ? " " + joinClauses : ""}
        ${whereClause}
        GROUP BY eli.year
        ORDER BY eli.year ASC`;
    } else {
      // ─────────────────────────────────────────────────────────────────────────────
      // Per-capita mode
      //
      // Goal: compute denominator from **filters**, not from fiscal line presence.
      //  • If entity-like filters exist → sum populations of the selected units
      //    (dedup UAT vs county vs country scopes).
      //  • If no such filter exists     → use full country population.
      //  • Keep the amounts aggregation separate and join by year at the end.
      // ─────────────────────────────────────────────────────────────────────────────

      // Do we have any entity-oriented selector that should shape the denominator?
      const hasEntityFilter = Boolean(
        (filters.entity_cuis && filters.entity_cuis.length) ||
        (filters.uat_ids && filters.uat_ids.length) ||
        (filters.county_codes && filters.county_codes.length) ||
        typeof filters.is_uat === "boolean" ||
        (filters.entity_types && filters.entity_types.length)
      );

      // Build an entity-only WHERE clause (and its parameter list) used **only**
      // to compute the population denominator. This must not depend on line items.
      let paramIndex = values.length + 1;
      const entityConds: string[] = [];
      const entityValues: any[] = [];

      if (filters.entity_cuis?.length) {
        entityConds.push(`e.cui = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.entity_cuis);
      }
      if (filters.entity_types?.length) {
        entityConds.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.entity_types);
      }
      if (filters.is_uat !== undefined) {
        entityConds.push(`e.is_uat = $${paramIndex++}`);
        entityValues.push(filters.is_uat);
      }
      if (filters.uat_ids?.length) {
        entityConds.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
        entityValues.push(filters.uat_ids);
      }
      // County filter applies on the UAT join, because a county is represented by its UAT rows.
      if (filters.county_codes?.length) {
        entityConds.push(`ul.county_code = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.county_codes);
      }

      const entityWhereClause = entityConds.length ? `WHERE ${entityConds.join(" AND ")}` : "";

      // Country population logic: sum one representative row per county.
      //  • For each county, use the county aggregate row where siruta_code == county_code
      //  • Special case: Bucharest → county_code 'B' with SIRUTA 179132
      const countryPopulationSql = `(
        SELECT SUM(pop_val) FROM (
          SELECT MAX(CASE
            WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
            WHEN u2.siruta_code = u2.county_code THEN u2.population
            ELSE 0
          END) AS pop_val
          FROM ${TABLES.UATS} u2
          GROUP BY u2.county_code
        ) cp
      )`;

      // CTE pipeline:
      //  1) amounts          → yearly sums of fiscal amounts (isolated from denominator logic)
      //  2) years            → distinct years to ensure we produce a row for each year present in amounts
      //  3) population_units → the set of unique population units implied by the filters
      //  4) denominator      → for each year, choose country pop if present, otherwise sum distinct unit pops
      query = `
        WITH amounts AS (
          -- (1) Sum amounts per year under the fiscal filters
          SELECT eli.year, COALESCE(SUM(eli.ytd_amount), 0) AS total_amount
          FROM ${TABLES.EXECUTION_LINE_ITEMS} eli
          ${joinClauses ? " " + joinClauses : ""}
          ${whereClause}
          GROUP BY eli.year
        ),
        years AS (
          -- (2) All years appearing in the amounts CTE
          SELECT DISTINCT year FROM amounts
        ),
        population_units AS (
          -- (3) Units contributing to the denominator
          ${hasEntityFilter
          ? `
          SELECT
            -- A stable key to deduplicate population units
            CASE
              WHEN e.is_uat THEN 'uat:' || ul.id::text
              WHEN e.entity_type = 'admin_county_council' THEN 'county:' || ul.county_code
              ELSE 'country:RO'
            END AS pop_unit_key,
            -- The numeric population value for the unit
            CASE
              WHEN e.is_uat THEN COALESCE(ul.population, 0)
              WHEN e.entity_type = 'admin_county_council' THEN (
                SELECT MAX(CASE
                  WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
                  WHEN u2.siruta_code = u2.county_code THEN u2.population
                  ELSE 0
                END)
                FROM ${TABLES.UATS} u2
                WHERE u2.county_code = ul.county_code
              )
              ELSE ${countryPopulationSql}
            END AS pop_value,
            -- Helpful for logic and diagnostics
            CASE
              WHEN e.is_uat THEN 'uat'
              WHEN e.entity_type = 'admin_county_council' THEN 'county'
              ELSE 'country'
            END AS scope
          FROM ${TABLES.ENTITIES} e
          LEFT JOIN ${TABLES.UATS} ul
            ON (ul.id = e.uat_id) OR (ul.uat_code = e.cui)
          ${entityWhereClause}
          `
          : `
          -- No entity filter: denominator is country population
          SELECT 'country:RO' AS pop_unit_key, ${countryPopulationSql} AS pop_value, 'country' AS scope
          `
        }
        ),
        denominator AS (
          -- (4) Choose denominator: country pop if present, else sum distinct units
          SELECT y.year,
                 CASE WHEN EXISTS (SELECT 1 FROM population_units pu WHERE pu.scope = 'country')
                      THEN (SELECT MAX(pop_value) FROM population_units pu WHERE pu.scope = 'country')
                      ELSE (
                        SELECT COALESCE(SUM(pop_value), 0)
                        FROM (SELECT DISTINCT pop_unit_key, pop_value FROM population_units) d
                      )
                 END AS population
          FROM years y
        )
        SELECT a.year,
               -- Final per-capita value with divide-by-zero protection
               COALESCE(a.total_amount / NULLIF(d.population, 0), 0) AS value
        FROM amounts a
        JOIN denominator d ON d.year = a.year
        ORDER BY a.year ASC
      `;

      // Append the entity-only filter values at the **end** so that SQL placeholders stay aligned
      values.push(...entityValues);
    }

    const result = await pool.query(query, values);
    let yearlyTrend = result.rows.map(row => ({ year: parseInt(row.year, 10), value: parseFloat(row.value) }));

    if (needsEuro) {
      const rateByYear = getEurRateMap();
      yearlyTrend = yearlyTrend.map(({ year, value }) => {
        const rate = rateByYear.get(year) ?? 1;
        return { year, value: value / rate };
      });
    }

    await analyticsCache.set(cacheKey, yearlyTrend);
    return yearlyTrend;
  },

  /**
   * Monthly trend using monthly_amount grouped by (year, month).
   * Applies the same per-capita denominator logic as yearly trend, and euro normalization by year.
   */
  async getMonthlyTrend(filters: AnalyticsFilter): Promise<{ year: number; month: number; value: number }[]> {
    const cacheKey = getCacheKey({ method: 'getMonthlyTrend', filters });
    const cachedValue = await analyticsCache.get(cacheKey);
    if (cachedValue) {
      return cachedValue as unknown as { year: number; month: number; value: number }[];
    }

    validateAggregatedFilters(filters);
    const { joinClauses, whereClause, values } = buildExecutionLineItemFilterQuery(filters);

    const normalization = filters.normalization ?? 'total';
    const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
    const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

    let query: string;

    if (!needsPerCapita) {
      // Simple total by year, month
      query = `SELECT eli.year, eli.month, COALESCE(SUM(eli.monthly_amount), 0) AS value
        FROM ${TABLES.EXECUTION_LINE_ITEMS} eli
        ${joinClauses ? " " + joinClauses : ""}
        ${whereClause}
        GROUP BY eli.year, eli.month
        ORDER BY eli.year ASC, eli.month ASC`;
    } else {
      const hasEntityFilter = Boolean(
        (filters.entity_cuis && filters.entity_cuis.length) ||
        (filters.uat_ids && filters.uat_ids.length) ||
        (filters.county_codes && filters.county_codes.length) ||
        typeof filters.is_uat === "boolean" ||
        (filters.entity_types && filters.entity_types.length)
      );

      let paramIndex = values.length + 1;
      const entityConds: string[] = [];
      const entityValues: any[] = [];

      if (filters.entity_cuis?.length) {
        entityConds.push(`e.cui = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.entity_cuis);
      }
      if (filters.entity_types?.length) {
        entityConds.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.entity_types);
      }
      if (filters.is_uat !== undefined) {
        entityConds.push(`e.is_uat = $${paramIndex++}`);
        entityValues.push(filters.is_uat);
      }
      if (filters.uat_ids?.length) {
        entityConds.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
        entityValues.push(filters.uat_ids);
      }
      if (filters.county_codes?.length) {
        entityConds.push(`ul.county_code = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.county_codes);
      }

      const entityWhereClause = entityConds.length ? `WHERE ${entityConds.join(" AND ")}` : "";

      const countryPopulationSql = `(
        SELECT SUM(pop_val) FROM (
          SELECT MAX(CASE
            WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
            WHEN u2.siruta_code = u2.county_code THEN u2.population
            ELSE 0
          END) AS pop_val
          FROM ${TABLES.UATS} u2
          GROUP BY u2.county_code
        ) cp
      )`;

      query = `
        WITH amounts AS (
          SELECT eli.year, eli.month, COALESCE(SUM(eli.monthly_amount), 0) AS total_amount
          FROM ${TABLES.EXECUTION_LINE_ITEMS} eli
          ${joinClauses ? " " + joinClauses : ""}
          ${whereClause}
          GROUP BY eli.year, eli.month
        ),
        months AS (
          SELECT DISTINCT year, month FROM amounts
        ),
        population_units AS (
          ${hasEntityFilter
          ? `
          SELECT
            CASE
              WHEN e.is_uat THEN 'uat:' || ul.id::text
              WHEN e.entity_type = 'admin_county_council' THEN 'county:' || ul.county_code
              ELSE 'country:RO'
            END AS pop_unit_key,
            CASE
              WHEN e.is_uat THEN COALESCE(ul.population, 0)
              WHEN e.entity_type = 'admin_county_council' THEN (
                SELECT MAX(CASE
                  WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
                  WHEN u2.siruta_code = u2.county_code THEN u2.population
                  ELSE 0
                END)
                FROM ${TABLES.UATS} u2
                WHERE u2.county_code = ul.county_code
              )
              ELSE ${countryPopulationSql}
            END AS pop_value,
            CASE
              WHEN e.is_uat THEN 'uat'
              WHEN e.entity_type = 'admin_county_council' THEN 'county'
              ELSE 'country'
            END AS scope
          FROM ${TABLES.ENTITIES} e
          LEFT JOIN ${TABLES.UATS} ul
            ON (ul.id = e.uat_id) OR (ul.uat_code = e.cui)
          ${entityWhereClause}
          `
          : `
          SELECT 'country:RO' AS pop_unit_key, ${countryPopulationSql} AS pop_value, 'country' AS scope
          `
        }
        ),
        denominator AS (
          SELECT m.year, m.month,
                 CASE WHEN EXISTS (SELECT 1 FROM population_units pu WHERE pu.scope = 'country')
                      THEN (SELECT MAX(pop_value) FROM population_units pu WHERE pu.scope = 'country')
                      ELSE (
                        SELECT COALESCE(SUM(pop_value), 0)
                        FROM (SELECT DISTINCT pop_unit_key, pop_value FROM population_units) d
                      )
                 END AS population
          FROM months m
        )
        SELECT a.year, a.month,
               COALESCE(a.total_amount / NULLIF(d.population, 0), 0) AS value
        FROM amounts a
        JOIN denominator d ON d.year = a.year AND d.month = a.month
        ORDER BY a.year ASC, a.month ASC
      `;

      values.push(...entityValues);
    }

    const result = await pool.query(query, values);
    let monthlyTrend: { year: number; month: number; value: number }[] = result.rows.map((row) => ({
      year: parseInt(row.year, 10),
      month: parseInt(row.month, 10),
      value: parseFloat(row.value),
    }));

    if (needsEuro) {
      const rateByYear = getEurRateMap();
      monthlyTrend = monthlyTrend.map(({ year, month, value }) => {
        const rate = rateByYear.get(year) ?? 1;
        return { year, month, value: value / rate };
      });
    }

    await analyticsCache.set(cacheKey, monthlyTrend as unknown as any);
    return monthlyTrend;
  },

  /**
   * Quarterly trend using quarterly_amount grouped by (year, quarter).
   * Relies on is_quarterly flag and precomputed quarterly_amount.
   * Applies per-capita denominator logic analogous to yearly trend, and euro normalization by year.
   */
  async getQuarterlyTrend(filters: AnalyticsFilter): Promise<{ year: number; quarter: number; value: number }[]> {
    const cacheKey = getCacheKey({ method: 'getQuarterlyTrend', filters });
    const cachedValue = await analyticsCache.get(cacheKey);
    if (cachedValue) {
      return cachedValue as unknown as { year: number; quarter: number; value: number }[];
    }

    validateAggregatedFilters(filters);
    const { joinClauses, whereClause, values } = buildExecutionLineItemFilterQuery(filters);

    const normalization = filters.normalization ?? 'total';
    const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
    const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

    let query: string;

    if (!needsPerCapita) {
      query = `SELECT eli.year, eli.quarter, COALESCE(SUM(eli.quarterly_amount), 0) AS value
        FROM ${TABLES.EXECUTION_LINE_ITEMS} eli
        ${joinClauses ? " " + joinClauses : ""}
        ${whereClause}
        GROUP BY eli.year, eli.quarter
        ORDER BY eli.year ASC, eli.quarter ASC`;
    } else {
      const hasEntityFilter = Boolean(
        (filters.entity_cuis && filters.entity_cuis.length) ||
        (filters.uat_ids && filters.uat_ids.length) ||
        (filters.county_codes && filters.county_codes.length) ||
        typeof filters.is_uat === "boolean" ||
        (filters.entity_types && filters.entity_types.length)
      );

      let paramIndex = values.length + 1;
      const entityConds: string[] = [];
      const entityValues: any[] = [];

      if (filters.entity_cuis?.length) {
        entityConds.push(`e.cui = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.entity_cuis);
      }
      if (filters.entity_types?.length) {
        entityConds.push(`e.entity_type = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.entity_types);
      }
      if (filters.is_uat !== undefined) {
        entityConds.push(`e.is_uat = $${paramIndex++}`);
        entityValues.push(filters.is_uat);
      }
      if (filters.uat_ids?.length) {
        entityConds.push(`e.uat_id = ANY($${paramIndex++}::int[])`);
        entityValues.push(filters.uat_ids);
      }
      if (filters.county_codes?.length) {
        entityConds.push(`ul.county_code = ANY($${paramIndex++}::text[])`);
        entityValues.push(filters.county_codes);
      }

      const entityWhereClause = entityConds.length ? `WHERE ${entityConds.join(" AND ")}` : "";

      const countryPopulationSql = `(
        SELECT SUM(pop_val) FROM (
          SELECT MAX(CASE
            WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
            WHEN u2.siruta_code = u2.county_code THEN u2.population
            ELSE 0
          END) AS pop_val
          FROM ${TABLES.UATS} u2
          GROUP BY u2.county_code
        ) cp
      )`;

      query = `
        WITH amounts AS (
          SELECT eli.year, eli.quarter, COALESCE(SUM(eli.quarterly_amount), 0) AS total_amount
          FROM ${TABLES.EXECUTION_LINE_ITEMS} eli
          ${joinClauses ? " " + joinClauses : ""}
          ${whereClause}
          GROUP BY eli.year, eli.quarter
        ),
        quarters AS (
          SELECT DISTINCT year, quarter FROM amounts
        ),
        population_units AS (
          ${hasEntityFilter
          ? `
          SELECT
            CASE
              WHEN e.is_uat THEN 'uat:' || ul.id::text
              WHEN e.entity_type = 'admin_county_council' THEN 'county:' || ul.county_code
              ELSE 'country:RO'
            END AS pop_unit_key,
            CASE
              WHEN e.is_uat THEN COALESCE(ul.population, 0)
              WHEN e.entity_type = 'admin_county_council' THEN (
                SELECT MAX(CASE
                  WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
                  WHEN u2.siruta_code = u2.county_code THEN u2.population
                  ELSE 0
                END)
                FROM ${TABLES.UATS} u2
                WHERE u2.county_code = ul.county_code
              )
              ELSE ${countryPopulationSql}
            END AS pop_value,
            CASE
              WHEN e.is_uat THEN 'uat'
              WHEN e.entity_type = 'admin_county_council' THEN 'county'
              ELSE 'country'
            END AS scope
          FROM ${TABLES.ENTITIES} e
          LEFT JOIN ${TABLES.UATS} ul
            ON (ul.id = e.uat_id) OR (ul.uat_code = e.cui)
          ${entityWhereClause}
          `
          : `
          SELECT 'country:RO' AS pop_unit_key, ${countryPopulationSql} AS pop_value, 'country' AS scope
          `
        }
        ),
        denominator AS (
          SELECT q.year, q.quarter,
                 CASE WHEN EXISTS (SELECT 1 FROM population_units pu WHERE pu.scope = 'country')
                      THEN (SELECT MAX(pop_value) FROM population_units pu WHERE pu.scope = 'country')
                      ELSE (
                        SELECT COALESCE(SUM(pop_value), 0)
                        FROM (SELECT DISTINCT pop_unit_key, pop_value FROM population_units) d
                      )
                 END AS population
          FROM quarters q
        )
        SELECT a.year, a.quarter,
               COALESCE(a.total_amount / NULLIF(d.population, 0), 0) AS value
        FROM amounts a
        JOIN denominator d ON d.year = a.year AND d.quarter = a.quarter
        ORDER BY a.year ASC, a.quarter ASC
      `;

      values.push(...entityValues);
    }

    const result = await pool.query(query, values);
    let quarterlyTrend: { year: number; quarter: number; value: number }[] = result.rows.map((row) => ({
      year: parseInt(row.year, 10),
      quarter: parseInt(row.quarter, 10),
      value: parseFloat(row.value),
    }));

    if (needsEuro) {
      const rateByYear = getEurRateMap();
      quarterlyTrend = quarterlyTrend.map(({ year, quarter, value }) => {
        const rate = rateByYear.get(year) ?? 1;
        return { year, quarter, value: value / rate };
      });
    }

    await analyticsCache.set(cacheKey, quarterlyTrend as unknown as any);
    return quarterlyTrend;
  },
};

function validateAggregatedFilters(filters: AnalyticsFilter) {
  if (!filters.account_category || !VALID_ACCOUNT_CATEGORIES.includes(filters.account_category)) {
    throw new Error(`getTotalAmount and getYearlyTrend require account_category of "ch" or "vn"`);
  }
}

function getPeriodViewInfo(periodType: ReportPeriodType): { viewName: string, dateColumn: string | null, orderColumn: string } {
  switch (periodType) {
    case 'YEAR':
      return { viewName: 'mv_summary_annual', dateColumn: null, orderColumn: 'year' };
    case 'QUARTER':
      return { viewName: 'mv_summary_quarterly', dateColumn: 'quarter', orderColumn: 'quarter' };
    case 'MONTH':
      return { viewName: 'mv_summary_monthly', dateColumn: 'month', orderColumn: 'month' };
    default:
      throw new Error(`Unsupported period type: ${periodType}`);
  }
}

async function getEntityPopulation(entityCui: string): Promise<number> {
  const populationQuery = `
    WITH e AS (
      SELECT cui, is_uat, entity_type, uat_id FROM ${TABLES.ENTITIES} WHERE cui = $1
    ), ul AS (
      SELECT u1.*
      FROM ${TABLES.UATS} u1
      JOIN e ON (u1.id = e.uat_id) OR (u1.uat_code = e.cui)
      ORDER BY CASE WHEN u1.id = (SELECT uat_id FROM e) THEN 0 ELSE 1 END
      LIMIT 1
    )
    SELECT CASE
      WHEN (SELECT is_uat FROM e) IS TRUE THEN COALESCE((SELECT population FROM ul), 0)
      WHEN (SELECT entity_type FROM e) = 'admin_county_council' THEN COALESCE((
        SELECT MAX(CASE
          WHEN u2.county_code = 'B' AND u2.siruta_code = '179132' THEN u2.population
          WHEN u2.siruta_code = u2.county_code THEN u2.population
          ELSE 0
        END)
        FROM ${TABLES.UATS} u2
        WHERE u2.county_code = (SELECT county_code FROM ul)
      ), 0)
      ELSE 0
    END AS population;
  `;
  const popRes = await pool.query(populationQuery, [entityCui]);
  return parseInt(popRes.rows[0]?.population ?? 0, 10) || 0;
}

/**
 * Batched version of getEntityPopulation to avoid N+1 queries.
 * Fetches populations for multiple entities in a single query.
 */
async function getEntityPopulationBatch(entityCuis: string[]): Promise<Map<string, number>> {
  if (entityCuis.length === 0) {
    return new Map();
  }

  const populationQuery = `
    WITH entities_batch AS (
      SELECT cui, is_uat, entity_type, uat_id
      FROM ${TABLES.ENTITIES}
      WHERE cui = ANY($1::text[])
    ),
    entity_uats AS (
      SELECT DISTINCT ON (e.cui)
        e.cui,
        e.is_uat,
        e.entity_type,
        u.population,
        u.county_code
      FROM entities_batch e
      LEFT JOIN ${TABLES.UATS} u ON (u.id = e.uat_id) OR (u.uat_code = e.cui)
      ORDER BY e.cui, CASE WHEN u.id = e.uat_id THEN 0 ELSE 1 END
    ),
    county_populations AS (
      SELECT
        county_code,
        MAX(CASE
          WHEN county_code = 'B' AND siruta_code = '179132' THEN population
          WHEN siruta_code = county_code THEN population
          ELSE 0
        END) AS county_population
      FROM ${TABLES.UATS}
      GROUP BY county_code
    )
    SELECT
      eu.cui,
      CASE
        WHEN eu.is_uat IS TRUE THEN COALESCE(eu.population, 0)
        WHEN eu.entity_type = 'admin_county_council' THEN COALESCE(cp.county_population, 0)
        ELSE 0
      END AS population
    FROM entity_uats eu
    LEFT JOIN county_populations cp ON eu.county_code = cp.county_code;
  `;

  const result = await pool.query(populationQuery, [entityCuis]);
  const populationMap = new Map<string, number>();

  for (const row of result.rows) {
    populationMap.set(row.cui, parseInt(row.population ?? 0, 10) || 0);
  }

  // Ensure all requested CUIs have an entry (default to 0 if not found)
  for (const cui of entityCuis) {
    if (!populationMap.has(cui)) {
      populationMap.set(cui, 0);
    }
  }

  return populationMap;
}

// --- Helpers ---
