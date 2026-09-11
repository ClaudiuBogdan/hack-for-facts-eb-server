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
 * COMPATIBILITY PATH ONLY — composed by no server at this revision. Both
 * entrypoints (`redesign-api.js` and the `api.js` embedding) run the default
 * composition, which has carried `ins-native` since X/F6, so `makeBudgetModule`
 * always receives `native` and every read family takes the promoted-set route
 * (`shell/native/factors.ts`, `BudgetRepoOptions.moneyFactors`). The embedded
 * table below is reached only by `makeBudgetRepo(db)` WITHOUT `moneyFactors`,
 * i.e. a `makeBudgetModule` call without `native` — today only
 * `tests/integration/kernel-legacy-roots.test.ts`. The frozen Phoenix dev
 * (`phoenix-last-full`, 36b4e998) still serves the pre-X/F6 float table from
 * its own code. Deprecated in prose rather than with `@deprecated`
 * (`no-deprecated` would flag the live caller, `money-factor.ts`; the same
 * choice as `cpi-level.ts`). Deleted with the legacy entrypoint (review N/N1,
 * DP-11).
 *
 * The table is a COPY of factor set 2 (`core.normalization_factors`, digest
 * `NATIVE_FACTOR_SET_DIGEST`, promoted 2026-09-08, run 23230), as decimal
 * strings — no float arithmetic anywhere on this path. Every value and year is
 * pinned against the fixture read from that set
 * (`tests/unit/budget/embedded-factor-table.test.ts`); the former 2026 estimates
 * are gone (owner rule: embedded estimates must not outlive the promoted set),
 * so a year past the table carries the last promoted year forward, exactly as
 * any other year past the table did. `TOTAL` is the identity (multiplier=1) —
 * the common path — and never touches the factor table.
 */

import { sql, type RawBuilder } from 'kysely';

import { HUNDRED, legacyDecimal } from '../../core/legacy-analytics/decimal.js';

import type { BudgetNormalization } from '../../core/constants.js';

/**
 * Average RON→EUR rate per year (divide RON by this for EUR) — factor set 2
 * `ron_per_eur`, every year the set carries.
 * Deprecated (prose, not tool-visible, like `cpi-level.ts`): compatibility path
 * only, see the header.
 */
export const FX_RON_PER_EUR: Readonly<Record<number, string>> = {
  2005: '3.6234',
  2006: '3.5245',
  2007: '3.3373',
  2008: '3.6827',
  2009: '4.2373',
  2010: '4.2099',
  2011: '4.2379',
  2012: '4.456',
  2013: '4.419',
  2014: '4.4446',
  2015: '4.445',
  2016: '4.4908',
  2017: '4.5681',
  2018: '4.6535',
  2019: '4.7452',
  2020: '4.8371',
  2021: '4.9204',
  2022: '4.9315',
  2023: '4.9465',
  2024: '4.9746',
  2025: '5.0415',
};

/**
 * Nominal GDP (RON) per year, for percent-of-GDP (amount * 100 / gdp) — factor
 * set 2 `gdp_ron`, every year the set carries.
 * Deprecated (prose, not tool-visible, like `cpi-level.ts`): compatibility path
 * only, see the header.
 */
export const GDP_RON: Readonly<Record<number, string>> = {
  1995: '7610600000',
  1996: '11387700000',
  1997: '25500100000',
  1998: '37007700000',
  1999: '55126400000',
  2000: '80873100000',
  2001: '117391400000',
  2002: '152271500000',
  2003: '191917600000',
  2004: '244688300000',
  2005: '286861900000',
  2006: '342762600000',
  2007: '425691100000',
  2008: '539831400000',
  2009: '530919600000',
  2010: '540447500000',
  2011: '587235000000',
  2012: '621214700000',
  2013: '631634000000',
  2014: '668905000000',
  2015: '712548600000',
  2016: '752129100000',
  2017: '851620600000',
  2018: '953049200000',
  2019: '1059822100000',
  2020: '1063650700000',
  2021: '1186015400000',
  2022: '1384597800000',
  2023: '1590749400000',
  2024: '1759183300000',
  2025: '1916404900000',
};

const lastKnown = (table: Readonly<Record<number, string>>, year: number): string => {
  const exact = table[year];
  if (exact !== undefined) return exact;
  const years = Object.keys(table).map(Number);
  const max = Math.max(...years);
  const min = Math.min(...years);
  return table[year > max ? max : min] ?? '1';
};

/**
 * The multiplier applied to a year's MV sum for a given normalization, as decimal
 * text under the slice's decimal policy (`legacy-analytics/decimal.ts`) — the same
 * arithmetic the native path runs in `exactYearMoneyMultipliers`. For
 * PER_CAPITA / PER_CAPITA_EURO the per-capita division happens per-entity in SQL
 * (the factor here is just the money normalization; population is divided later).
 * Deprecated (prose, not tool-visible): compatibility path only, see the header.
 */
export const yearMultiplier = (norm: BudgetNormalization, year: number): string => {
  switch (norm) {
    case 'TOTAL':
      return '1';
    case 'TOTAL_EURO':
      return legacyDecimal(1).div(lastKnown(FX_RON_PER_EUR, year)).toFixed();
    case 'PER_CAPITA':
      return '1'; // money stays RON; divided by population in SQL
    case 'PER_CAPITA_EURO':
      return legacyDecimal(1).div(lastKnown(FX_RON_PER_EUR, year)).toFixed();
    case 'PERCENT_GDP':
      // Nominal amount as a % of that year's nominal GDP (no CPI deflation —
      // both numerator and denominator are same-year nominal RON).
      return HUNDRED.div(lastKnown(GDP_RON, year)).toFixed();
    default:
      return '1';
  }
};

/** True when the normalization divides the per-year sum by entity population. */
export const isPerCapita = (norm: BudgetNormalization): boolean =>
  norm === 'PER_CAPITA' || norm === 'PER_CAPITA_EURO';

/**
 * A `CASE mv.year WHEN $y THEN $mult … ELSE 1 END::numeric` expression that maps
 * each requested year to its normalization multiplier inline — so the per-year
 * factor multiplies the MV sum in SQL with `numeric` precision (the multiplier is
 * bound as decimal text, never a JS float). For `TOTAL` every multiplier is 1, so
 * the expression is the identity. Years/multipliers are bound parameters (no
 * string concatenation).
 * Deprecated (prose, not tool-visible): compatibility path only, see the header.
 */
export const factorCaseExpr = (
  years: readonly number[],
  norm: BudgetNormalization
): RawBuilder<unknown> => {
  if (years.length === 0 || norm === 'TOTAL' || norm === 'PER_CAPITA') return sql`1::numeric`;
  const whens = years.map((y) => sql`when mv.year = ${y} then ${yearMultiplier(norm, y)}::numeric`);
  return sql`(case ${sql.join(whens, sql` `)} else 1::numeric end)`;
};
