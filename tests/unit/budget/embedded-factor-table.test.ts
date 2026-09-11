/**
 * Pins the embedded compatibility factor table (`shell/repo/analytics.ts`) to the
 * promoted factor set 2, read from Chronos on 2026-09-11 into
 * `tests/unit/normalization/fixtures/factor-set-2.json` (review DP-11, plan WP6):
 *  - the fixture IS the set the native path pins (`NATIVE_FACTOR_SET_ID` / digest);
 *  - every (kind, year) of the table equals the set's value, no year missing, no
 *    year invented (the former 2026 estimates are gone);
 *  - the compatibility multipliers are decimal text equal to what the native path
 *    derives from the same set, for every year of the table;
 *  - `factorCaseExpr` binds that text, never a float.
 */
import { createHash } from 'node:crypto';

import { Decimal } from 'decimal.js';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { HUNDRED, legacyDecimal } from '@/modules/budget/core/legacy-analytics/decimal.js';
import {
  NATIVE_FACTOR_SET_DIGEST,
  NATIVE_FACTOR_SET_ID,
} from '@/modules/budget/shell/native/factors.js';
import {
  factorCaseExpr,
  FX_RON_PER_EUR,
  GDP_RON,
  yearMultiplier,
} from '@/modules/budget/shell/repo/analytics.js';
import { singleYearMoneyFactor } from '@/modules/budget/shell/repo/money-factor.js';

import fixture from '../normalization/fixtures/factor-set-2.json' with { type: 'json' };

import type { FactorKind, FactorSource } from '@/modules/budget/core/legacy-analytics/ports.js';

const promoted = (kind: FactorKind): ReadonlyMap<number, string> =>
  new Map(
    fixture.rows
      .filter((row) => row.kind === kind && row.frequency === 'YEAR')
      .map((row) => [Number(row.periodKey), row.value])
  );

const promotedSource: FactorSource = {
  yearly: async (kind) =>
    ok(new Map([...promoted(kind)].map(([year, value]) => [year, new Decimal(value)]))),
};

const years = (table: Readonly<Record<number, string>>): number[] =>
  Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);

const db = new Kysely<Record<string, never>>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (instance) => new PostgresIntrospector(instance),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('embedded compatibility factor table = promoted factor set 2', () => {
  it('the fixture is the promoted set the native path pins, unedited since the read', () => {
    expect(fixture.factorSetId).toBe(NATIVE_FACTOR_SET_ID);
    expect(fixture.digest).toBe(NATIVE_FACTOR_SET_DIGEST);
    expect(fixture.rows).toHaveLength(261);
    // Over the rows as read on 2026-09-11; the manifest digest above is self-declared.
    expect(createHash('sha256').update(JSON.stringify(fixture.rows)).digest('hex')).toBe(
      'a42aab76cc54dc580a7dca69653551988a44e882da659c493f2f07621c026165'
    );
  });

  it.each([
    ['ron_per_eur', FX_RON_PER_EUR],
    ['gdp_ron', GDP_RON],
  ] as const)('%s: every year of the set, the same value, nothing invented', (kind, table) => {
    const set = promoted(kind);
    expect(years(table)).toEqual([...set.keys()].sort((a, b) => a - b));
    for (const [year, value] of set) {
      expect(legacyDecimal(table[year]!).equals(legacyDecimal(value))).toBe(true);
    }
    expect(table[2026]).toBeUndefined();
  });

  it('table values are canonical decimal text (no exponent, no trailing zeros)', () => {
    for (const value of [...Object.values(FX_RON_PER_EUR), ...Object.values(GDP_RON)]) {
      expect(value).toMatch(/^[1-9]\d*(?:\.\d*[1-9])?$/u);
    }
  });

  it.each(['TOTAL_EURO', 'PER_CAPITA_EURO', 'PERCENT_GDP'] as const)(
    '%s: the compatibility multiplier equals the native derivation for every year',
    async (norm) => {
      const table = norm === 'PERCENT_GDP' ? GDP_RON : FX_RON_PER_EUR;
      for (const year of years(table)) {
        const native = (await singleYearMoneyFactor(promotedSource, norm, year))._unsafeUnwrap();
        const compat = (await singleYearMoneyFactor(undefined, norm, year))._unsafeUnwrap();
        expect(compat).toBe(native);
        expect(compat).toBe(yearMultiplier(norm, year));
      }
    }
  );

  it('2025 multipliers are the exact decimal quotients of the set-2 values', () => {
    expect(yearMultiplier('TOTAL_EURO', 2025)).toBe(legacyDecimal(1).div('5.0415').toFixed());
    expect(yearMultiplier('PERCENT_GDP', 2025)).toBe(HUNDRED.div('1916404900000').toFixed());
    expect(yearMultiplier('TOTAL', 2025)).toBe('1');
    expect(yearMultiplier('PER_CAPITA', 2025)).toBe('1');
  });

  it('a year past the set carries the last promoted year forward, a year before it the first', () => {
    expect(yearMultiplier('TOTAL_EURO', 2026)).toBe(yearMultiplier('TOTAL_EURO', 2025));
    expect(yearMultiplier('PERCENT_GDP', 2030)).toBe(yearMultiplier('PERCENT_GDP', 2025));
    expect(yearMultiplier('TOTAL_EURO', 2004)).toBe(yearMultiplier('TOTAL_EURO', 2005));
    expect(yearMultiplier('PERCENT_GDP', 1990)).toBe(yearMultiplier('PERCENT_GDP', 1995));
  });

  it('factorCaseExpr binds the multipliers as decimal text, years as integers', () => {
    const compiled = factorCaseExpr([2024, 2025], 'TOTAL_EURO').compile(db);
    expect(compiled.sql).toBe(
      '(case when mv.year = $1 then $2::numeric when mv.year = $3 then $4::numeric else 1::numeric end)'
    );
    expect(compiled.parameters).toEqual([
      2024,
      yearMultiplier('TOTAL_EURO', 2024),
      2025,
      yearMultiplier('TOTAL_EURO', 2025),
    ]);
    expect(factorCaseExpr([2025], 'TOTAL').compile(db).sql).toBe('1::numeric');
    expect(factorCaseExpr([], 'PERCENT_GDP').compile(db).sql).toBe('1::numeric');
  });
});
