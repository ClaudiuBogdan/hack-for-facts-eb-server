import pool from "../connection";
import { Entity, ExecutionLineItem } from "../models";
import { createCache, getCacheKey } from "../../utils/cache";
import { AnalyticsFilter, NormalizationMode } from "../../types";
import { datasetRepository } from "./datasetRepository";

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
    endYear: number,
    normalization: NormalizationMode
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

      const needsPerCapita = normalization === 'per_capita' || normalization === 'per_capita_euro';
      const needsEuro = normalization === 'total_euro' || normalization === 'per_capita_euro';

      let population = 0;
      if (needsPerCapita) {
        // Compute population for the entity using the same rules as entity analytics
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
        population = parseInt(popRes.rows[0]?.population ?? 0, 10) || 0;
      }

      const rateByYear = needsEuro ? getEurRateMap() : null;

      return result.rows.map(row => {
        const year = parseInt(row.year, 10);
        let totalIncome = parseFloat(row.totalIncome);
        let totalExpenses = parseFloat(row.totalExpenses);
        let budgetBalance = parseFloat(row.budgetBalance);

        if (needsPerCapita) {
          if (population > 0) {
            totalIncome = totalIncome / population;
            totalExpenses = totalExpenses / population;
            budgetBalance = budgetBalance / population;
          } else {
            totalIncome = 0;
            totalExpenses = 0;
            budgetBalance = 0;
          }
        }

        if (needsEuro && rateByYear) {
          const rate = rateByYear.get(year) ?? 1;
          totalIncome = totalIncome / rate;
          totalExpenses = totalExpenses / rate;
          budgetBalance = budgetBalance / rate;
        }

        return { year, totalIncome, totalExpenses, budgetBalance };
      });
    } catch (error) {
      console.error(
        `Error fetching yearly financial trends for entity ${entityCui} (${startYear}-${endYear}):`,
        error
      );
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
    const cacheKey = getCacheKey(filters);
    const cachedValue = analyticsCache.get(cacheKey);
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
      query = `SELECT eli.year, COALESCE(SUM(eli.amount), 0) AS value
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
          SELECT eli.year, COALESCE(SUM(eli.amount), 0) AS total_amount
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

    analyticsCache.set(cacheKey, yearlyTrend);
    return yearlyTrend;
  },
};

function validateAggregatedFilters(filters: AnalyticsFilter) {
  if (!filters.account_category || !VALID_ACCOUNT_CATEGORIES.includes(filters.account_category)) {
    throw new Error(`getTotalAmount and getYearlyTrend require account_category of "ch" or "vn"`);
  }
}

// --- Helpers ---
let eurRateByYear: Map<number, number> | null = null;
function getEurRateMap(): Map<number, number> {
  if (!eurRateByYear) {
    const [exchange] = datasetRepository.getByIds(['exchange-rate-eur-ron']);
    eurRateByYear = new Map<number, number>();
    if (exchange && Array.isArray(exchange.yearlyTrend)) {
      for (const point of exchange.yearlyTrend) {
        eurRateByYear.set(point.year, point.value);
      }
    }
  }
  return eurRateByYear;
}


/**
 * How this per-capita filter works (in plain English)
  •	Amounts (numerator): We sum fiscal amounts per year using your normal joins and whereClause (whatever the user picked in the UI for money data).
  •	Population (denominator):
  •	If the user did select entities (by CUIs, UAT ids, county codes, is_uat, or entity types), we compute the population from the filter only:
  •	UAT entities contribute their UAT population.
  •	County councils contribute their county population once.
  •	Any other entity type falls back to country population (so they still get a sensible per-capita denominator).
  •	We deduplicate units (uat:ID / county:CODE / country:RO) before summing.
  •	If the user did not select any entities, the denominator is the whole country population.
  •	The denominator is not affected by whether there are fiscal line items — it reflects the filter intent, not data availability.
  •	Final join: We divide the yearly total_amount by that year’s denominator (which is the same per year) and protect against divide-by-zero.

⸻

Quick test cases you can run
  1.	No entity filters at all → per-capita uses country population.
  2.	One UAT selected (e.g., a city hall) → denominator is that UAT population.
  3.	Two UATs selected (same county) → denominator is the sum of both UAT populations (no double count).
  4.	One county council selected → denominator is that county population (counted once).
  5.	UAT + county council for the same county → denominator is UAT pop + county pop only if the UAT is outside that county council scope; if the UAT is inside the same county, you’ll still count them separately because they are different scopes (UAT vs county). This is intentional — a county council and a municipality represent different population “units”. If you prefer county to dominate, we can change the rule to “if any county council is present, ignore UATs from that county” (easy tweak).

⸻

Notes on maintainability
  •	The SQL now has clear WITH CTEs and inline comments explaining each step.
  •	The countryPopulationSql is centralized and documented (including the Bucharest special case).
  •	Placeholder ordering is stable by pushing entityValues at the end.
  •	The boolean hasEntityFilter is the single switch that drives “country vs filtered units”.
 */