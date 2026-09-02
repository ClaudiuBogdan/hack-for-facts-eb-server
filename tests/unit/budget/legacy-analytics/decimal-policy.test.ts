/**
 * The slice's pinned decimal policy (codex 2026-09-02 finding 5; orchestrator
 * decision: precision 40, ROUND_HALF_EVEN, Decimal end to end — never the
 * legacy float arithmetic): the clone is isolated from the global constructor,
 * the boundary cases of every normalization step (FX, CPI, per-capita, growth)
 * behave — zero population, zero base, negative values, huge sums; no NaN, no
 * Infinity, no float, exact where exact — and a FLOAT REPLICA of the legacy
 * chain (`get-analytics-series.ts` `NormalizationService`, doubles per point)
 * fed the same inputs agrees at 2 dp for 1e3 … 1e12 RON, per-capita, %GDP and
 * growth (the "rounding" delta class, 13 §6 / §7 delta 6).
 */

import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import {
  LEGACY_DECIMAL_PRECISION,
  LEGACY_DECIMAL_ROUNDING,
  LegacyDecimal,
  legacyDecimal,
} from '../../../../src/modules/budget/core/legacy-analytics/decimal.js';
import {
  computeCpiFactors,
  normalizePoints,
  type NominalPoint,
} from '../../../../src/modules/budget/core/legacy-analytics/normalize.js';

import type {
  LegacyFrequency,
  NormalizationPlan,
} from '../../../../src/modules/budget/core/legacy-analytics/types.js';

const pt = (x: string, y: string): NominalPoint => ({
  x,
  year: Number.parseInt(x.substring(0, 4), 10),
  y: new Decimal(y),
});
const yearly = (entries: Record<number, string>): Map<number, Decimal> =>
  new Map(Object.entries(entries).map(([y, v]) => [Number(y), new Decimal(v)]));
const plan = (over: Partial<NormalizationPlan>): NormalizationPlan => ({
  mode: 'total',
  currency: 'RON',
  inflationAdjusted: false,
  showPeriodGrowth: false,
  ...over,
});
const run = (
  points: NominalPoint[],
  p: NormalizationPlan,
  ctx: Parameters<typeof normalizePoints>[2],
  frequency: LegacyFrequency = 'YEAR'
): string[] => normalizePoints(points, p, ctx, frequency).points.map((q) => q.y.toString());

describe('the pinned policy', () => {
  it("is precision 40, ROUND_HALF_EVEN (banker's), pinned by name", () => {
    expect(LEGACY_DECIMAL_PRECISION).toBe(40);
    expect(LEGACY_DECIMAL_ROUNDING).toBe(Decimal.ROUND_HALF_EVEN);
    expect(LegacyDecimal.precision).toBe(40);
    expect(LegacyDecimal.rounding).toBe(Decimal.ROUND_HALF_EVEN);
    // Half-even, observable: 1 ÷ 3 at 40 digits; a tie rounds to the even digit.
    expect(legacyDecimal(1).div(3).sd()).toBe(40);
    expect(legacyDecimal('2.5').toDecimalPlaces(0, LEGACY_DECIMAL_ROUNDING).toString()).toBe('2');
    expect(legacyDecimal('3.5').toDecimalPlaces(0, LEGACY_DECIMAL_ROUNDING).toString()).toBe('4');
  });

  it('is isolated: a global Decimal.set does not reach the clone, and re-wrapped values carry the clone', () => {
    const before = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 5, rounding: Decimal.ROUND_DOWN });
      const global = new Decimal(1).div(3);
      expect(global.toString()).toBe('0.33333');
      expect(legacyDecimal(1).div(3).toString()).toBe(`0.${'3'.repeat(40)}`);
      // A foreign-constructor operand re-wrapped under the clone uses the clone's config.
      const foreign = new Decimal('2');
      expect(legacyDecimal(foreign).div(3).toString()).toBe(`0.${'6'.repeat(39)}7`);
      // …and the pipeline itself is unaffected by the global change.
      expect(
        run([pt('2024', '1')], plan({ mode: 'per_capita' }), { population: new Decimal(3) })
      ).toEqual([`0.${'3'.repeat(40)}`]);
    } finally {
      Decimal.set(before);
    }
  });

  it('constructs exactly from numeric::text at any magnitude (no float on the way in)', () => {
    expect(legacyDecimal('123456789012345678.91').toString()).toBe('123456789012345678.91');
    expect(legacyDecimal('-0.01').toString()).toBe('-0.01');
  });
});

describe('boundaries — FX', () => {
  it('a zero or missing rate leaves the point unadjusted; a huge sum stays exact to 40 significant digits', () => {
    const fx = yearly({ 2023: '0', 2024: '4.9746' });
    expect(
      run([pt('2023', '1000'), pt('2024', '1000')], plan({ currency: 'EUR' }), { fxRate: fx })
    ).toEqual(['1000', legacyDecimal('1000').div('4.9746').toString()]);
    // 1e15 RON with cents = 18 significant digits, far under the 40-digit policy.
    const huge = run([pt('2024', '1000000000000000.01')], plan({ currency: 'EUR' }), {
      fxRate: fx,
    });
    expect(huge[0]).toBe(legacyDecimal('1000000000000000.01').div('4.9746').toString());
    expect(new Decimal(huge[0]!).sd()).toBeLessThanOrEqual(40);
    expect(new Decimal(huge[0]!).gt('2e14')).toBe(true);
    // Negative amounts (corrections) divide like any other.
    expect(run([pt('2024', '-49.746')], plan({ currency: 'EUR' }), { fxRate: fx })).toEqual([
      '-10',
    ]);
  });
});

describe('boundaries — CPI', () => {
  it('a zero base level disables the adjustment; a zero intermediate level leaves only that year unadjusted', () => {
    const zeroBase = computeCpiFactors(yearly({ 2023: '100', 2024: '0' }));
    expect(zeroBase).toBeNull();
    const cpi = yearly({ 2022: '0', 2023: '100', 2024: '110' });
    expect(
      run(
        [pt('2022', '10'), pt('2023', '10'), pt('2024', '10')],
        plan({ inflationAdjusted: true }),
        {
          cpiIndex: cpi,
        }
      )
    ).toEqual(['10', '11', '10']);
  });

  it('a negative or huge nominal is scaled, never NaN', () => {
    const cpi = yearly({ 2023: '100', 2024: '110' });
    expect(run([pt('2023', '-100')], plan({ inflationAdjusted: true }), { cpiIndex: cpi })).toEqual(
      ['-110']
    );
    expect(run([pt('2023', '1e15')], plan({ inflationAdjusted: true }), { cpiIndex: cpi })).toEqual(
      ['1100000000000000']
    );
  });
});

describe('boundaries — per capita', () => {
  it('zero, null and absent population leave the value unadjusted; a negative value divides', () => {
    const p = plan({ mode: 'per_capita' });
    expect(run([pt('2024', '100')], p, { population: new Decimal(0) })).toEqual(['100']);
    expect(run([pt('2024', '100')], p, { population: null })).toEqual(['100']);
    expect(run([pt('2024', '100')], p, {})).toEqual(['100']);
    expect(run([pt('2024', '-100')], p, { population: new Decimal(4) })).toEqual(['-25']);
    // 1e12 RON over the national population: 40 significant digits, half-even.
    expect(run([pt('2024', '1000000000000')], p, { population: new Decimal('19053815') })).toEqual([
      legacyDecimal('1000000000000').div('19053815').toString(),
    ]);
  });
});

describe('boundaries — growth', () => {
  it('zero base → 0; negative base and negative current follow the legacy formula; huge values stay exact', () => {
    const p = plan({ showPeriodGrowth: true });
    expect(run([pt('2023', '0'), pt('2024', '50')], p, {})).toEqual(['0', '0']);
    // (−50 − 100) / 100 × 100 = −150 ; (100 − (−50)) / (−50) × 100 = −300 (legacy arithmetic kept).
    expect(run([pt('2023', '100'), pt('2024', '-50'), pt('2025', '100')], p, {})).toEqual([
      '0',
      '-150',
      '-300',
    ]);
    expect(run([pt('2023', '1e15'), pt('2024', '1.5e15')], p, {})).toEqual(['0', '50']);
    // Growth over a normalized (EUR) series divides normalized values, not nominal.
    const fx = yearly({ 2023: '5', 2024: '4' });
    expect(
      run(
        [pt('2023', '100'), pt('2024', '100')],
        plan({ currency: 'EUR', showPeriodGrowth: true }),
        { fxRate: fx }
      )
    ).toEqual(['0', '25']);
  });
});

// ── the float replica of the legacy chain ─────────────────────────────────────
//
// `execution-analytics/core/usecases/get-analytics-series.ts` `NormalizationService`:
// every point `toNumber()` (:87), then doubles: `p.y * factor` (:132),
// `p.y / gdp * 100` (:129), `p.y / rate` (:148), `p.y / pop` (:168),
// `((curr - prev) / prev) * 100` (:181). The CPI factor came from decimal.js
// (defaults) and was `.toNumber()`ed. Reproduced here verbatim in doubles.

interface FloatPoint {
  x: string;
  year: number;
  y: number;
}

const legacyFloatChain = (
  points: readonly NominalPoint[],
  p: NormalizationPlan,
  ctx: {
    cpiFactors?: ReadonlyMap<number, Decimal>;
    fx?: Map<number, Decimal>;
    gdp?: Map<number, Decimal>;
    population?: Decimal;
  },
  frequency: LegacyFrequency
): FloatPoint[] => {
  let data: FloatPoint[] = points.map((q) => ({ x: q.x, year: q.year, y: q.y.toNumber() }));
  const carry = (series: Map<number, Decimal>, year: number): Decimal | null => {
    const exact = series.get(year);
    if (exact !== undefined) return exact;
    let best: [number, Decimal] | null = null;
    for (const [y, v] of series) if (y < year && (best === null || y > best[0])) best = [y, v];
    return best === null ? null : best[1];
  };
  if (p.mode === 'percent_gdp') {
    if (ctx.gdp !== undefined) {
      const gdp = ctx.gdp;
      data = data.map((q) => {
        const g = carry(gdp, q.year);
        if (g === null || g.isZero()) return { ...q, y: 0 };
        return { ...q, y: (q.y / g.toNumber()) * 100 };
      });
    }
  } else {
    if (p.inflationAdjusted && ctx.cpiFactors !== undefined) {
      const factors = ctx.cpiFactors;
      data = data.map((q) => {
        const f = factors.get(q.year);
        return f === undefined ? q : { ...q, y: q.y * f.toNumber() };
      });
    }
    if (p.currency !== 'RON' && ctx.fx !== undefined) {
      const fx = ctx.fx;
      data = data.map((q) => {
        const r = carry(fx, q.year);
        return r === null || r.isZero() ? q : { ...q, y: q.y / r.toNumber() };
      });
    }
    if (p.mode === 'per_capita' && ctx.population !== undefined && !ctx.population.isZero()) {
      const pop = ctx.population.toNumber();
      data = data.map((q) => ({ ...q, y: q.y / pop }));
    }
  }
  if (p.showPeriodGrowth) {
    const lookup = new Map(data.map((q) => [q.x, q.y]));
    data = data.map((curr) => {
      const prevKey = frequency === 'YEAR' ? String(Number.parseInt(curr.x, 10) - 1) : null;
      if (prevKey === null) return { ...curr, y: 0 };
      const prev = lookup.get(prevKey);
      if (prev === undefined || prev === 0) return { ...curr, y: 0 };
      return { ...curr, y: ((curr.y - prev) / prev) * 100 };
    });
  }
  return data.sort((a, b) => a.x.localeCompare(b.x));
};

describe('rounding-class delta: the decimal pipeline equals the legacy float chain at 2 dp', () => {
  // Real-shaped reference data: CPI level (chain-linked YoY tail), FX, GDP, population.
  const cpiLevel = yearly({
    2020: '1000',
    2021: '1050.5',
    2022: '1195.469',
    2023: '1319.797776',
    2024: '1393.574471',
  });
  const cpi = computeCpiFactors(cpiLevel)!;
  const fx = yearly({
    2020: '4.8371',
    2021: '4.9204',
    2022: '4.9315',
    2023: '4.9465',
    2024: '4.9746',
  });
  const gdp = yearly({
    2020: '1066781000000',
    2021: '1189090000000',
    2022: '1409000000000',
    2023: '1598576000000',
    2024: '1766068000000',
  });
  const population = new Decimal('19053815');
  const magnitudes = ['1234.56', '987654.32', '123456789.01', '9876543210.99', '1000000000000.01'];
  const points = (m: string): NominalPoint[] =>
    [2020, 2021, 2022, 2023, 2024].map((year, i) =>
      pt(String(year), new Decimal(m).mul(1 + i * 0.0731).toFixed(2))
    );
  const agreeAt2dp = (decimal: readonly string[], float: readonly FloatPoint[]): void => {
    expect(decimal.length).toBe(float.length);
    for (let i = 0; i < decimal.length; i += 1) {
      const a = new Decimal(decimal[i]!);
      const b = new Decimal(float[i]!.y);
      expect(a.toFixed(2), `${float[i]!.x}: ${a.toString()} vs ${String(float[i]!.y)}`).toBe(
        b.toFixed(2)
      );
      if (!b.isZero()) expect(a.minus(b).abs().div(b.abs()).lt('1e-9')).toBe(true);
    }
  };

  for (const m of magnitudes) {
    it(`inflation + EUR + per-capita at ${m} RON`, () => {
      const p = plan({ mode: 'per_capita', currency: 'EUR', inflationAdjusted: true });
      const decimal = run(points(m), p, { cpiIndex: cpiLevel, fxRate: fx, population });
      const float = legacyFloatChain(
        points(m),
        p,
        { cpiFactors: cpi.factors, fx, population },
        'YEAR'
      );
      agreeAt2dp(decimal, float);
    });
    it(`total EUR and real RON at ${m} RON`, () => {
      const pEur = plan({ currency: 'EUR' });
      agreeAt2dp(
        run(points(m), pEur, { fxRate: fx }),
        legacyFloatChain(points(m), pEur, { fx }, 'YEAR')
      );
      const pReal = plan({ inflationAdjusted: true });
      agreeAt2dp(
        run(points(m), pReal, { cpiIndex: cpiLevel }),
        legacyFloatChain(points(m), pReal, { cpiFactors: cpi.factors }, 'YEAR')
      );
    });
    it(`percent of GDP at ${m} RON`, () => {
      const p = plan({ mode: 'percent_gdp' });
      agreeAt2dp(run(points(m), p, { gdp }), legacyFloatChain(points(m), p, { gdp }, 'YEAR'));
    });
    it(`growth over EUR-normalized values at ${m} RON`, () => {
      const p = plan({ currency: 'EUR', showPeriodGrowth: true });
      agreeAt2dp(run(points(m), p, { fxRate: fx }), legacyFloatChain(points(m), p, { fx }, 'YEAR'));
    });
  }
});
