/**
 * The `legacy` normalization policy, exact: composites, percent_gdp
 * exclusivity, CPI base = latest year + carry-forward over the D2 price LEVEL,
 * FX carry-forward, per-capita by one population, growth after normalization
 * (0 cases), axes. Expected values are hand-computed with decimal.js in the
 * test itself.
 *
 * The CPI representation proof (codex 2026-09-02 finding 4): the factors from
 * the chain-linked LEVEL (what the port carries) equal the factors legacy got
 * by chaining the YoY index per request — on the unit fixture exactly, and on
 * the real YAML series to the cent at a 1e12 RON national total.
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { legacyDecimal } from '../../../../src/modules/budget/core/legacy-analytics/decimal.js';
import {
  carryForward,
  computeCpiFactors,
  normalizePoints,
  periodAxis,
  resolveNormalizationPlan,
  resultAxis,
  type NominalPoint,
} from '../../../../src/modules/budget/core/legacy-analytics/normalize.js';
import {
  chainLinkCpiLevels,
  toLevelSeries,
} from '../../../../src/modules/budget/shell/factors/cpi-level.js';
import { createDatasetRepo } from '../../../../src/modules/datasets/index.js';

import type { LegacyAnalyticsFilter } from '../../../../src/modules/budget/core/legacy-analytics/types.js';

const baseFilter: LegacyAnalyticsFilter = {
  account_category: 'ch',
  report_period: { type: 'YEAR', selection: { interval: { start: '2022', end: '2024' } } },
};

const pt = (x: string, y: string): NominalPoint => ({
  x,
  year: Number.parseInt(x.substring(0, 4), 10),
  y: legacyDecimal(y),
});

const yearly = (entries: Record<number, string>): Map<number, Decimal> =>
  new Map(Object.entries(entries).map(([y, v]) => [Number(y), legacyDecimal(v)]));

// Expected values below are computed under the SAME pinned policy the pipeline
// uses (`legacyDecimal`, precision 40 / half-even); `legacyChainedFactors` keeps
// the default constructor because it replicates the legacy code verbatim.
// The real CPI YoY series tail (datasets/yaml/economics/ro.economics.cpi.yearly.yaml)
// and its D2 chain-linked LEVEL (what the port carries).
const CPI_YOY = yearly({ 2021: '105.05', 2022: '113.80', 2023: '110.40', 2024: '105.59' });
const CPI = toLevelSeries(chainLinkCpiLevels(CPI_YOY), (t) => legacyDecimal(t));
const FX_EUR = yearly({ 2022: '4.9315', 2023: '4.9465', 2024: '4.9746' });
const GDP = yearly({ 2022: '1409000000000', 2023: '1598576000000' });

/** Legacy `computeCpiAdjustmentFactorMap` (cpi-adjustment-factors.ts:20-74), verbatim. */
const legacyChainedFactors = (
  cpiYoY: ReadonlyMap<number, Decimal>,
  referenceYear: number
): Map<number, Decimal> => {
  const years = [...cpiYoY.keys()].sort((a, b) => a - b);
  const maxYear = years.at(-1)!;
  const effectiveReferenceYear = cpiYoY.has(referenceYear) ? referenceYear : maxYear;
  const levelByYear = new Map<number, Decimal>();
  levelByYear.set(years[0]!, new Decimal(1));
  for (let i = 1; i < years.length; i++) {
    const year = years[i]!;
    const prevLevel = levelByYear.get(years[i - 1]!)!;
    const yoyIndex = cpiYoY.get(year)!;
    levelByYear.set(year, prevLevel.mul(yoyIndex.div(100)));
  }
  const referenceLevel = levelByYear.get(effectiveReferenceYear)!;
  const factors = new Map<number, Decimal>();
  for (const year of years) factors.set(year, referenceLevel.div(levelByYear.get(year)!));
  return factors;
};

describe('resolveNormalizationPlan (composites)', () => {
  it('total_euro → total + EUR, overriding an explicit currency', () => {
    expect(
      resolveNormalizationPlan({ ...baseFilter, normalization: 'total_euro', currency: 'USD' })
    ).toEqual({
      mode: 'total',
      currency: 'EUR',
      inflationAdjusted: false,
      showPeriodGrowth: false,
    });
  });
  it('per_capita_euro → per_capita + EUR', () => {
    expect(
      resolveNormalizationPlan({ ...baseFilter, normalization: 'per_capita_euro' }).currency
    ).toBe('EUR');
    expect(resolveNormalizationPlan({ ...baseFilter, normalization: 'per_capita_euro' }).mode).toBe(
      'per_capita'
    );
  });
  it('absent / null normalization behaves as total; currency defaults to RON', () => {
    expect(resolveNormalizationPlan({ ...baseFilter, normalization: null })).toEqual({
      mode: 'total',
      currency: 'RON',
      inflationAdjusted: false,
      showPeriodGrowth: false,
    });
  });
});

describe('computeCpiFactors — base = latest year available, ratios of the D2 level', () => {
  it('base year factor is 1 and earlier years are inflated by the level ratio', () => {
    const cpi = computeCpiFactors(CPI);
    expect(cpi?.baseYear).toBe(2024);
    expect(cpi?.factors.get(2024)?.toString()).toBe('1');
    // level2021 = 105.05; level2022 = ×1.138; level2023 = ×1.104; level2024 = ×1.0559
    const level2022 = legacyDecimal('105.05').mul('1.138');
    const level2023 = level2022.mul('1.104');
    const level2024 = level2023.mul('1.0559');
    expect(cpi?.factors.get(2022)?.toFixed(12)).toBe(level2024.div(level2022).toFixed(12));
    expect(cpi?.factors.get(2021)?.toFixed(12)).toBe(level2024.div('105.05').toFixed(12));
  });

  it('PROOF (unit fixture): level-ratio factors == the legacy per-request YoY chain, digit for digit at 19 sig.', () => {
    const fromLevel = computeCpiFactors(CPI)!.factors;
    const legacy = legacyChainedFactors(CPI_YOY, 2024);
    for (const year of [2021, 2022, 2023, 2024]) {
      expect(fromLevel.get(year)?.toSignificantDigits(19).toString()).toBe(
        legacy.get(year)?.toSignificantDigits(19).toString()
      );
    }
  });

  it('PROOF (real YAML 1971–2024): 1e12 RON deflated through the level agrees with the legacy chain to the cent; the anchor is D2 (2024 → 969828.98084407 at 8 dp)', async () => {
    const repo = createDatasetRepo({ rootDir: './datasets/yaml' });
    const dataset = (await repo.getById('ro.economics.cpi.yearly'))._unsafeUnwrap();
    const yoy = new Map(dataset.points.map((p) => [Number.parseInt(p.x, 10), p.y]));
    const levels = chainLinkCpiLevels(yoy);
    expect(legacyDecimal(levels.get(2024)!).toFixed(8)).toBe('969828.98084407');
    expect(legacyDecimal(levels.get(2023)!).toFixed(8)).toBe('918485.63390858');
    expect(levels.get(1971)).toBe('100.600000000000');

    const fromLevel = computeCpiFactors(toLevelSeries(levels, (t) => legacyDecimal(t)))!;
    expect(fromLevel.baseYear).toBe(2024);
    const legacy = legacyChainedFactors(yoy, 2024);
    const nominal = legacyDecimal('1000000000000'); // 1e12 RON: a national annual total
    let maxDiff = legacyDecimal(0);
    // Every year the facts cover (2016–2025; 2025 carries the 2024 factor forward).
    for (const year of [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024]) {
      const a = nominal.mul(fromLevel.factors.get(year)!);
      const b = nominal.mul(legacy.get(year)!);
      const diff = a.minus(b).abs();
      if (diff.gt(maxDiff)) maxDiff = diff;
      expect(diff.lt('0.005'), `${String(year)}: |${a.toFixed(6)} − ${b.toFixed(6)}|`).toBe(true);
    }
    // Measured: the 12-dp rounding of the stored level (≈7e5–9.7e5 for these
    // years, so ≤ 7e-19 relative) moves 1e12 RON by far less than a cent.
    expect(maxDiff.lt('0.00001'), `max |Δ| = ${maxDiff.toFixed(12)} RON`).toBe(true);
    // The rounding is visible only where no facts exist: 1990's level is 156.69,
    // so the SAME 12-dp rounding is 3e-15 relative — 1e12 RON becomes 6.19e15
    // in 2024 prices and the two representations differ by ~18 RON there.
    const a1990 = nominal.mul(fromLevel.factors.get(1990)!);
    const b1990 = nominal.mul(legacy.get(1990)!);
    expect(a1990.minus(b1990).abs().div(a1990).lt('1e-14')).toBe(true);
  });

  it('returns null on an empty series; skips a non-positive level (that year stays unadjusted)', () => {
    expect(computeCpiFactors(new Map())).toBeNull();
    const withZero = computeCpiFactors(yearly({ 2022: '0', 2023: '110', 2024: '120' }))!;
    expect(withZero.factors.has(2022)).toBe(false);
    expect(withZero.factors.get(2023)?.toString()).toBe(legacyDecimal(120).div(110).toString());
    expect(computeCpiFactors(yearly({ 2024: '0' }))).toBeNull();
  });
});

describe('carryForward', () => {
  it('exact year, else the latest earlier year, else null', () => {
    expect(carryForward(FX_EUR, 2023)?.toString()).toBe('4.9465');
    expect(carryForward(FX_EUR, 2030)?.toString()).toBe('4.9746');
    expect(carryForward(FX_EUR, 2000)).toBeNull();
  });
});

describe('normalizePoints — the legacy pipeline', () => {
  const points = [pt('2022', '1000'), pt('2023', '1100'), pt('2024', '1210'), pt('2025', '1000')];

  it('total / RON leaves values unchanged and sorts by label', () => {
    const out = normalizePoints(
      [points[2]!, points[0]!, points[1]!],
      resolveNormalizationPlan(baseFilter),
      {},
      'YEAR'
    );
    expect(out.points.map((p) => p.x)).toEqual(['2022', '2023', '2024']);
    expect(out.points.map((p) => p.y.toString())).toEqual(['1000', '1100', '1210']);
    expect(out.cpiBaseYear).toBeNull();
  });

  it('inflation_adjusted multiplies by the CPI factor and carries the last factor forward', () => {
    const plan = resolveNormalizationPlan({ ...baseFilter, inflation_adjusted: true });
    const out = normalizePoints(points, plan, { cpiIndex: CPI }, 'YEAR');
    const cpi = computeCpiFactors(CPI)!;
    expect(out.cpiBaseYear).toBe(2024);
    expect(out.points[0]?.y.toString()).toBe(
      legacyDecimal('1000').mul(cpi.factors.get(2022)!).toString()
    );
    // 2023 → × 1.0559 exactly (short chain, no rounding in the 12-dp level).
    expect(out.points[1]?.y.toString()).toBe(legacyDecimal('1100').mul('1.0559').toString());
    expect(out.points[2]?.y.toString()).toBe('1210'); // base year: factor 1
    // 2025 is past the horizon → the 2024 factor (1) carries forward.
    expect(out.points[3]?.y.toString()).toBe('1000');
  });

  it('EUR divides by the carried-forward rate; a missing rate leaves the point unadjusted', () => {
    const plan = resolveNormalizationPlan({ ...baseFilter, normalization: 'total_euro' });
    const out = normalizePoints(
      [pt('2021', '500'), pt('2023', '1100'), pt('2026', '1000')],
      plan,
      { fxRate: FX_EUR },
      'YEAR'
    );
    expect(out.points[0]?.y.toString()).toBe('500'); // before the first FX year → unchanged
    expect(out.points[1]?.y.toString()).toBe(legacyDecimal('1100').div('4.9465').toString());
    expect(out.points[2]?.y.toString()).toBe(legacyDecimal('1000').div('4.9746').toString());
  });

  it('per_capita divides every point by the ONE filter-wide population; zero/absent leaves it', () => {
    const plan = resolveNormalizationPlan({ ...baseFilter, normalization: 'per_capita' });
    const out = normalizePoints(points, plan, { population: legacyDecimal('19050000') }, 'YEAR');
    expect(out.points[0]?.y.toString()).toBe(legacyDecimal('1000').div('19050000').toString());
    const none = normalizePoints(points, plan, { population: null }, 'YEAR');
    expect(none.points[0]?.y.toString()).toBe('1000');
    const zero = normalizePoints(points, plan, { population: legacyDecimal(0) }, 'YEAR');
    expect(zero.points[0]?.y.toString()).toBe('1000');
  });

  it('CPI then FX then per-capita compose in that order', () => {
    const plan = resolveNormalizationPlan({
      ...baseFilter,
      normalization: 'per_capita_euro',
      inflation_adjusted: true,
    });
    const out = normalizePoints(
      [pt('2023', '1100')],
      plan,
      {
        cpiIndex: CPI,
        fxRate: FX_EUR,
        population: legacyDecimal('100'),
      },
      'YEAR'
    );
    const cpi = computeCpiFactors(CPI)!;
    const expected = legacyDecimal('1100').mul(cpi.factors.get(2023)!).div('4.9465').div('100');
    expect(out.points[0]?.y.toString()).toBe(expected.toString());
  });

  it('percent_gdp is exclusive: no CPI, no FX, no per-capita; missing GDP → 0', () => {
    const plan = resolveNormalizationPlan({
      ...baseFilter,
      normalization: 'percent_gdp',
      inflation_adjusted: true,
      currency: 'EUR',
    });
    const out = normalizePoints(
      [pt('2022', '14090000000'), pt('2025', '1')],
      plan,
      {
        gdp: GDP,
        cpiIndex: CPI,
        fxRate: FX_EUR,
        population: legacyDecimal('7'),
      },
      'YEAR'
    );
    expect(out.points[0]?.y.toString()).toBe('1'); // 14.09e9 / 1409e9 * 100 = 1 %
    // 2025 carries the 2023 GDP forward (legacy getDatasetValue), so it is not 0.
    expect(out.points[1]?.y.toString()).toBe(
      legacyDecimal('1').div('1598576000000').mul(100).toString()
    );
    const noGdp = normalizePoints([pt('2022', '5')], plan, {}, 'YEAR');
    expect(noGdp.points[0]?.y.toString()).toBe('5'); // dataset absent → unadjusted (legacy)
    const gdpGap = normalizePoints([pt('2000', '5')], plan, { gdp: GDP }, 'YEAR');
    expect(gdpGap.points[0]?.y.toString()).toBe('0'); // no GDP before the first year → 0
  });

  it('growth runs AFTER normalization: 0 for the first, missing and zero predecessor', () => {
    const plan = resolveNormalizationPlan({ ...baseFilter, show_period_growth: true });
    const out = normalizePoints(
      [pt('2020', '100'), pt('2021', '0'), pt('2022', '150'), pt('2024', '300')],
      plan,
      {},
      'YEAR'
    );
    expect(out.points.map((p) => [p.x, p.y.toString()])).toEqual([
      ['2020', '0'], // first point
      ['2021', '-100'], // (0-100)/100*100
      ['2022', '0'], // predecessor is zero
      ['2024', '0'], // 2023 missing (sparse) → 0
    ]);
    const monthly = normalizePoints(
      [pt('2023-12', '200'), pt('2024-01', '250')],
      plan,
      {},
      'MONTH'
    );
    expect(monthly.points[1]?.y.toString()).toBe('25');
    const quarterly = normalizePoints(
      [pt('2023-Q4', '200'), pt('2024-Q1', '100')],
      plan,
      {},
      'QUARTER'
    );
    expect(quarterly.points[1]?.y.toString()).toBe('-50');
  });

  it('growth composes with normalization (EUR-normalized growth)', () => {
    const plan = resolveNormalizationPlan({
      ...baseFilter,
      normalization: 'total_euro',
      show_period_growth: true,
    });
    const out = normalizePoints(
      [pt('2022', '1000'), pt('2023', '1100')],
      plan,
      { fxRate: FX_EUR },
      'YEAR'
    );
    const a = legacyDecimal('1000').div('4.9315');
    const b = legacyDecimal('1100').div('4.9465');
    expect(out.points[1]?.y.toString()).toBe(b.minus(a).div(a).mul(100).toString());
  });
});

describe('axes', () => {
  it('xAxis per PeriodType', () => {
    expect(periodAxis('YEAR')).toEqual({ name: 'Year', type: 'INTEGER', unit: 'year' });
    expect(periodAxis('QUARTER')).toEqual({ name: 'Quarter', type: 'STRING', unit: 'quarter' });
    expect(periodAxis('MONTH')).toEqual({ name: 'Month', type: 'STRING', unit: 'month' });
  });

  it('yAxis precedence: growth → % GDP → currency/per-capita/real', () => {
    expect(
      resultAxis(
        resolveNormalizationPlan({
          ...baseFilter,
          show_period_growth: true,
          normalization: 'percent_gdp',
        }),
        null
      )
    ).toEqual({ name: 'Growth', type: 'FLOAT', unit: '%' });
    expect(
      resultAxis(
        resolveNormalizationPlan({ ...baseFilter, normalization: 'percent_gdp', currency: 'EUR' }),
        null
      )
    ).toEqual({ name: 'Share of GDP', type: 'FLOAT', unit: '% of GDP' });
    expect(resultAxis(resolveNormalizationPlan(baseFilter), null).unit).toBe('RON');
    expect(
      resultAxis(
        resolveNormalizationPlan({ ...baseFilter, normalization: 'per_capita_euro' }),
        null
      ).unit
    ).toBe('EUR/capita');
    expect(
      resultAxis(resolveNormalizationPlan({ ...baseFilter, inflation_adjusted: true }), 2024).unit
    ).toBe('RON (real 2024)');
    expect(
      resultAxis(
        resolveNormalizationPlan({
          ...baseFilter,
          normalization: 'per_capita',
          inflation_adjusted: true,
          currency: 'USD',
        }),
        2025
      ).unit
    ).toBe('USD/capita (real 2025)');
  });
});
