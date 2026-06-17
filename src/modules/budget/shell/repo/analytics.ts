/**
 * Budget analytics — the consolidated normalization mechanism (plan §3.4).
 *
 * Legacy had THREE divergent normalizers (execution-analytics pure-TS per point,
 * county-analytics TS per year, entity-analytics SQL `factors(period_key,
 * multiplier)` VALUES-CTE). The redesign adopts the SINGLE SQL VALUES-CTE: a
 * per-year `factors(year, multiplier)` table joined to the MV sums, so the planner
 * applies the multiplier algebraically to the pre-aggregated MV totals (never to
 * 126M fact rows). Population is DELIBERATELY excluded from the factor map and
 * divided per-entity in SQL (per-capita is an entity-grain operation, §3.4).
 *
 * NOTE: the factor tables (CPI base-2024 carry-forward, FX, GDP) are reference
 * data. Until a kernel reference-data port exposes them in serving, this module
 * carries a small embedded factor table (the values legacy used) so normalization
 * is deterministic and unit-testable. `TOTAL` is the identity (multiplier=1) — the
 * common path — and never touches the factor table.
 */

import { sql, type RawBuilder } from 'kysely';

import type { BudgetNormalization } from '../../core/constants.js';

/** Average RON→EUR rate per year (divide RON by this for EUR). */
const FX_RON_PER_EUR: Readonly<Record<number, number>> = {
  2016: 4.49, 2017: 4.57, 2018: 4.65, 2019: 4.75, 2020: 4.84,
  2021: 4.92, 2022: 4.93, 2023: 4.95, 2024: 4.97, 2025: 5.05, 2026: 5.10,
};

/** Nominal GDP (RON) per year, for percent-of-GDP (amount * 100 / gdp). */
const GDP_RON: Readonly<Record<number, number>> = {
  2016: 765135e6, 2017: 856725e6, 2018: 951728e6, 2019: 1059770e6, 2020: 1058000e6,
  2021: 1189378e6, 2022: 1409813e6, 2023: 1605563e6, 2024: 1760000e6, 2025: 1880000e6, 2026: 2000000e6,
};

const lastKnown = (table: Readonly<Record<number, number>>, year: number): number => {
  if (table[year] !== undefined) return table[year];
  const years = Object.keys(table).map(Number);
  const max = Math.max(...years);
  const min = Math.min(...years);
  return table[year > max ? max : min] ?? 1;
};

/**
 * The multiplier applied to a year's MV sum for a given normalization. For
 * PER_CAPITA / PER_CAPITA_EURO the per-capita division happens per-entity in SQL
 * (the factor here is just the money normalization; population is divided later).
 */
export const yearMultiplier = (norm: BudgetNormalization, year: number): number => {
  switch (norm) {
    case 'TOTAL':
      return 1;
    case 'TOTAL_EURO':
      return 1 / lastKnown(FX_RON_PER_EUR, year);
    case 'PER_CAPITA':
      return 1; // money stays RON; divided by population in SQL
    case 'PER_CAPITA_EURO':
      return 1 / lastKnown(FX_RON_PER_EUR, year);
    case 'PERCENT_GDP':
      // Nominal amount as a % of that year's nominal GDP (no CPI deflation —
      // both numerator and denominator are same-year nominal RON).
      return 100 / lastKnown(GDP_RON, year);
    default:
      return 1;
  }
};

/** True when the normalization divides the per-year sum by entity population. */
export const isPerCapita = (norm: BudgetNormalization): boolean =>
  norm === 'PER_CAPITA' || norm === 'PER_CAPITA_EURO';

/**
 * Build a `factors(year, multiplier)` VALUES-CTE for the requested years and
 * normalization. Returned as a parameterized SQL fragment (the years/multipliers
 * are bound values, never concatenated). `TOTAL` returns a 1.0 multiplier table
 * (the join is then an identity, but kept uniform so the SQL shape never branches).
 */
export const factorValuesCte = (
  years: readonly number[],
  norm: BudgetNormalization
): RawBuilder<unknown> => {
  const rows = years.map((y) => sql`(${y}::int, ${yearMultiplier(norm, y)}::numeric)`);
  return sql`factors(year, multiplier) as (values ${sql.join(rows, sql`, `)})`;
};

/**
 * A `CASE mv.year WHEN $y THEN $mult … ELSE 1 END::numeric` expression that maps
 * each requested year to its normalization multiplier inline — so the per-year
 * factor multiplies the MV sum in SQL with `numeric` precision (no JS float). For
 * `TOTAL` every multiplier is 1, so the expression is the identity. Years/multipliers
 * are bound parameters (no string concatenation).
 */
export const factorCaseExpr = (
  years: readonly number[],
  norm: BudgetNormalization
): RawBuilder<unknown> => {
  if (years.length === 0 || norm === 'TOTAL' || norm === 'PER_CAPITA') return sql`1::numeric`;
  const whens = years.map((y) => sql`when mv.year = ${y} then ${yearMultiplier(norm, y)}::numeric`);
  return sql`(case ${sql.join(whens, sql` `)} else 1::numeric end)`;
};
