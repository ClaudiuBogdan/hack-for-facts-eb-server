/**
 * The `legacy` normalization policy (program D2), exact and float-free.
 *
 * Ported line-for-line from `execution-analytics/core/usecases/get-analytics-series.ts`
 * (`NormalizationService`, `getResultAxis`, `getXAxisMetadata`) and
 * `normalization/core/cpi-adjustment-factors.ts`, with three deliberate changes:
 *
 *  1. Every arithmetic step is decimal.js under the slice's pinned policy
 *     (`decimal.ts`: precision 40, ROUND_HALF_EVEN) — legacy multiplied JS
 *     doubles per point (`get-analytics-series.ts:87`); equal at 2 dp, a
 *     rounding-class delta. `y` is converted to a `number` only at the GraphQL
 *     boundary.
 *  2. CPI base year = the LATEST year present in the CPI series (user decision
 *     2026-09-02, program §7.4) instead of the hard-coded 2024
 *     (`get-analytics-series.ts:137`). The yAxis unit reports the base actually
 *     used: `RON (real 2024)`.
 *  3. The CPI input is the program-D2 `cpi_index` — a chain-linked price LEVEL
 *     (`level(y) = 100 × Π yoy(t)/100`, anchor = the year before the first
 *     observed index) — NOT the YoY index legacy chained per request
 *     (`cpi-adjustment-factors.ts:46-60`). The adapter chain-links the YAML YoY
 *     series into that level once (`shell/factors/cpi-level.ts`); this module
 *     only takes RATIOS of levels, which are anchor-invariant, so a D2 adapter
 *     returning the stored level is a drop-in.
 *
 * Kept verbatim: annual factors broadcast to monthly/quarterly points; factor
 * carry-forward past the dataset horizon; missing factor ⇒ unadjusted;
 * `percent_gdp` exclusive (no CPI / FX / per-capita); composites override the
 * currency to EUR; one filter-wide population; growth runs LAST on the
 * normalized values with 0 for the first / missing / zero predecessor.
 */

import { HUNDRED, ZERO, legacyDecimal } from './decimal.js';
import { previousPeriodLabel } from './period.js';

import type {
  LegacyAnalyticsFilter,
  LegacyAxis,
  LegacyFrequency,
  LegacySeriesPoint,
  NormalizationPlan,
  YearlySeries,
} from './types.js';
import type { Decimal } from 'decimal.js';

/** A nominal-RON point with the year pre-parsed for factor lookups. */
export interface NominalPoint {
  readonly x: string;
  readonly year: number;
  readonly y: Decimal;
}

/** The loaded reference data one series needs (each optional = unavailable). */
export interface NormalizationContext {
  /** Program-D2 `cpi_index`: the chain-linked price LEVEL per year (not YoY). */
  readonly cpiIndex?: YearlySeries;
  readonly fxRate?: YearlySeries;
  readonly gdp?: YearlySeries;
  /** The ONE filter-wide population (legacy policy); absent/zero ⇒ unadjusted. */
  readonly population?: Decimal | null;
}

/** Composite legacy values → strict mode + currency (legacy `getAnalyticsSeries`). */
export const resolveNormalizationPlan = (filter: LegacyAnalyticsFilter): NormalizationPlan => {
  const requested = filter.normalization ?? undefined;
  let mode: NormalizationPlan['mode'];
  let currency = filter.currency ?? 'RON';
  if (requested === 'total_euro') {
    mode = 'total';
    currency = 'EUR';
  } else if (requested === 'per_capita_euro') {
    mode = 'per_capita';
    currency = 'EUR';
  } else if (requested === 'per_capita' || requested === 'percent_gdp') {
    mode = requested;
  } else {
    mode = 'total';
  }
  return {
    mode,
    currency,
    inflationAdjusted: filter.inflation_adjusted === true,
    showPeriodGrowth: filter.show_period_growth === true,
  };
};

/**
 * Exact-year value, else the value of the LATEST earlier year (legacy
 * `getDatasetValue` carry-forward). `null` when nothing precedes the year.
 * The value is re-wrapped under the slice's decimal policy.
 */
export const carryForward = (series: YearlySeries, year: number): Decimal | null => {
  const exact = series.get(year);
  if (exact !== undefined) return legacyDecimal(exact);
  let bestYear: number | null = null;
  let best: Decimal | null = null;
  for (const [y, v] of series) {
    if (y < year && (bestYear === null || y > bestYear)) {
      bestYear = y;
      best = v;
    }
  }
  return best === null ? null : legacyDecimal(best);
};

export interface CpiFactors {
  /** year → multiplier (`real = nominal × factor`); the base year maps to 1. */
  readonly factors: ReadonlyMap<number, Decimal>;
  readonly baseYear: number;
  readonly lastYear: number;
}

/**
 * `level[base] / level[year]` per year from the chain-linked price LEVEL
 * series (legacy `computeCpiAdjustmentFactorMap` :62-71, minus the chaining it
 * did at :46-60 — the adapter did that once), with base = the latest year
 * present. A non-positive level is skipped (legacy `continue`; that year stays
 * unadjusted). `null` when the series is unusable.
 */
export const computeCpiFactors = (cpiLevel: YearlySeries): CpiFactors | null => {
  const years = [...cpiLevel.keys()].sort((a, b) => a - b);
  const last = years.at(-1);
  if (last === undefined) return null;

  const baseLevelRaw = cpiLevel.get(last);
  if (baseLevelRaw === undefined) return null;
  const baseLevel = legacyDecimal(baseLevelRaw);
  if (!baseLevel.isFinite() || baseLevel.lte(0)) return null;

  const factors = new Map<number, Decimal>();
  for (const year of years) {
    const raw = cpiLevel.get(year);
    if (raw === undefined) continue;
    const level = legacyDecimal(raw);
    if (!level.isFinite() || level.lte(0)) continue;
    factors.set(year, baseLevel.div(level));
  }
  return { factors, baseYear: last, lastYear: last };
};

const applyPercentGdp = (points: readonly NominalPoint[], gdp: YearlySeries): NominalPoint[] =>
  points.map((p) => {
    const g = carryForward(gdp, p.year);
    if (g === null || g.isZero()) return { ...p, y: ZERO };
    return { ...p, y: p.y.div(g).mul(HUNDRED) };
  });

const applyInflation = (points: readonly NominalPoint[], cpi: CpiFactors): NominalPoint[] =>
  points.map((p) => {
    const direct = cpi.factors.get(p.year);
    if (direct !== undefined) return { ...p, y: p.y.mul(direct) };
    // Carry-forward for years beyond the dataset horizon; earlier years stay
    // unadjusted (legacy).
    if (p.year > cpi.lastYear) {
      const fallback = cpi.factors.get(cpi.lastYear);
      if (fallback !== undefined) return { ...p, y: p.y.mul(fallback) };
    }
    return p;
  });

const applyCurrency = (points: readonly NominalPoint[], fx: YearlySeries): NominalPoint[] =>
  points.map((p) => {
    const rate = carryForward(fx, p.year);
    if (rate === null || rate.isZero()) return p;
    return { ...p, y: p.y.div(rate) };
  });

const applyPerCapita = (
  points: readonly NominalPoint[],
  population: Decimal | null | undefined
): NominalPoint[] => {
  if (population === undefined || population === null || population.isZero()) {
    return [...points];
  }
  const pop = legacyDecimal(population);
  return points.map((p) => ({ ...p, y: p.y.div(pop) }));
};

const applyGrowth = (
  points: readonly NominalPoint[],
  frequency: LegacyFrequency
): NominalPoint[] => {
  const lookup = new Map(points.map((p) => [p.x, p.y]));
  return points.map((curr) => {
    const prevKey = previousPeriodLabel(curr.x, frequency);
    if (prevKey === null) return { ...curr, y: ZERO };
    const prev = lookup.get(prevKey);
    if (prev === undefined || prev.isZero()) return { ...curr, y: ZERO };
    return { ...curr, y: curr.y.minus(prev).div(prev).mul(HUNDRED) };
  });
};

/**
 * The legacy transform pipeline (`NormalizationService.transform`), exact.
 * Returns the points sorted by label (legacy sorted by `x.localeCompare`).
 * Input `y` values are re-wrapped under the slice's decimal policy.
 */
export const normalizePoints = (
  points: readonly NominalPoint[],
  plan: NormalizationPlan,
  ctx: NormalizationContext,
  frequency: LegacyFrequency
): { readonly points: readonly LegacySeriesPoint[]; readonly cpiBaseYear: number | null } => {
  let data: NominalPoint[] = points.map((p) => ({ ...p, y: legacyDecimal(p.y) }));
  let cpiBaseYear: number | null = null;

  if (plan.mode === 'percent_gdp') {
    if (ctx.gdp !== undefined) data = applyPercentGdp(data, ctx.gdp);
  } else {
    if (plan.inflationAdjusted && ctx.cpiIndex !== undefined) {
      const cpi = computeCpiFactors(ctx.cpiIndex);
      if (cpi !== null) {
        cpiBaseYear = cpi.baseYear;
        data = applyInflation(data, cpi);
      }
    }
    if (plan.currency !== 'RON' && ctx.fxRate !== undefined) {
      data = applyCurrency(data, ctx.fxRate);
    }
    if (plan.mode === 'per_capita') {
      data = applyPerCapita(data, ctx.population);
    }
  }

  if (plan.showPeriodGrowth) data = applyGrowth(data, frequency);

  data.sort((a, b) => a.x.localeCompare(b.x));
  return { points: data.map((p) => ({ x: p.x, y: p.y })), cpiBaseYear };
};

/** yAxis precedence: growth → % GDP → currency / per-capita / real (legacy `getResultAxis`). */
export const resultAxis = (plan: NormalizationPlan, cpiBaseYear: number | null): LegacyAxis => {
  if (plan.showPeriodGrowth) return { name: 'Growth', type: 'FLOAT', unit: '%' };
  if (plan.mode === 'percent_gdp') return { name: 'Share of GDP', type: 'FLOAT', unit: '% of GDP' };
  const realSuffix = plan.inflationAdjusted
    ? cpiBaseYear === null
      ? ' (real)'
      : ` (real ${String(cpiBaseYear)})`
    : '';
  const capitaSuffix = plan.mode === 'per_capita' ? '/capita' : '';
  return { name: 'Amount', type: 'FLOAT', unit: `${plan.currency}${capitaSuffix}${realSuffix}` };
};

/** xAxis per PeriodType (legacy `getXAxisMetadata`). */
export const periodAxis = (frequency: LegacyFrequency): LegacyAxis => {
  switch (frequency) {
    case 'YEAR':
      return { name: 'Year', type: 'INTEGER', unit: 'year' };
    case 'QUARTER':
      return { name: 'Quarter', type: 'STRING', unit: 'quarter' };
    case 'MONTH':
      return { name: 'Month', type: 'STRING', unit: 'month' };
  }
};
