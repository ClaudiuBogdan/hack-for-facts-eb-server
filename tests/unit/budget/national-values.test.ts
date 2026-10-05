import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { legacyDecimal } from '@/modules/budget/core/legacy-analytics/decimal.js';
import { projectSeries } from '@/modules/budget/core/national/series.js';
import {
  parseSourceDecimal,
  projectLawAmount,
  toWireDataSeries,
  toWireDecimal,
} from '@/modules/budget/core/national/values.js';

import { EXECUTION_EVIDENCE, LAW_EVIDENCE } from '../../fixtures/national-budget/evidence.js';

const exact = (raw: string): Decimal => parseSourceDecimal(raw)._unsafeUnwrap();

describe('national exact values', () => {
  it('round-trips observed execution decimals unchanged, including long tails', () => {
    for (const raw of Object.values(EXECUTION_EVIDENCE)) {
      expect(toWireDecimal(exact(raw))).toBe(raw);
    }
  });

  it('canonicalises numeric text like trim_scale and never emits -0 or exponents', () => {
    expect(toWireDecimal(exact('1.50'))).toBe('1.5');
    expect(toWireDecimal(exact('100'))).toBe('100');
    expect(toWireDecimal(exact('-0.000'))).toBe('0');
    expect(toWireDecimal(exact('0.0000001'))).toBe('0.0000001');
    expect(toWireDecimal(exact('-12.340'))).toBe('-12.34');
  });

  it('refuses non-numeric source text instead of guessing', () => {
    for (const raw of ['', ' 1', '1e3', '+1', 'NaN', 'Infinity', '1.', '.5', '1,5']) {
      expect(parseSourceDecimal(raw)._unsafeUnwrapErr().kind).toBe('NOT_NUMERIC_TEXT');
    }
    expect(parseSourceDecimal('1'.repeat(901))._unsafeUnwrapErr().kind).toBe('TOO_MANY_DIGITS');
  });

  it('converts thousand lei to RON by exact multiplication by 1,000', () => {
    expect(toWireDecimal(projectLawAmount(exact(LAW_EVIDENCE.state5001Approved2025), 'RON'))).toBe(
      LAW_EVIDENCE.state5001Approved2025Ron
    );
    expect(
      toWireDecimal(projectLawAmount(exact(LAW_EVIDENCE.state5001Approved2025), 'THOUSAND_LEI'))
    ).toBe(LAW_EVIDENCE.state5001Approved2025);
    expect(toWireDecimal(projectLawAmount(exact(EXECUTION_EVIDENCE.largeTail), 'RON'))).toBe(
      '27546712048550.00178213231265544891357421875'
    );
  });

  it('documents why the legacy 40-digit policy is not used for the conversion', () => {
    const legacy = legacyDecimal(EXECUTION_EVIDENCE.largeTail).times(1000).toFixed();
    expect(legacy).not.toBe('27546712048550.00178213231265544891357421875');
    expect(projectLawAmount(legacyDecimal(EXECUTION_EVIDENCE.largeTail), 'RON').toFixed()).toBe(
      '27546712048550.00178213231265544891357421875'
    );
  });
});

describe('national series projection', () => {
  const plan = { type: 'QUARTER' as const, labels: ['2025-Q1', '2025-Q2', '2025-Q3'] };
  const period = (date: string, status: string) => ({ date, status });

  it('keeps every label in periods and only AVAILABLE values in DataSeries.data', () => {
    const envelope = projectSeries(plan, [
      { period: period('2025-Q1', 'AVAILABLE'), value: exact('1.5') },
      { period: period('2025-Q2', 'UNAVAILABLE'), value: null },
      { period: period('2025-Q3', 'AVAILABLE'), value: exact('0') },
    ])._unsafeUnwrap();
    expect(envelope.periods.map((p) => p.date)).toEqual(plan.labels);
    expect(toWireDataSeries(envelope.series)).toEqual({
      frequency: 'QUARTER',
      data: [
        { date: '2025-Q1', value: '1.5' },
        { date: '2025-Q3', value: '0' },
      ],
    });
    expect(envelope).not.toHaveProperty('series.series');
    for (const p of envelope.periods) expect(p).not.toHaveProperty('value');
  });

  it('refuses a status/value mismatch, a missing label or a reordered label', () => {
    expect(
      projectSeries(plan, [
        { period: period('2025-Q1', 'UNAVAILABLE'), value: exact('1') },
        { period: period('2025-Q2', 'UNAVAILABLE'), value: null },
        { period: period('2025-Q3', 'UNAVAILABLE'), value: null },
      ])._unsafeUnwrapErr().type
    ).toBe('ServiceUnavailable');
    expect(
      projectSeries(plan, [
        { period: period('2025-Q1', 'AVAILABLE'), value: null },
        { period: period('2025-Q2', 'UNAVAILABLE'), value: null },
        { period: period('2025-Q3', 'UNAVAILABLE'), value: null },
      ]).isErr()
    ).toBe(true);
    expect(
      projectSeries(plan, [{ period: period('2025-Q1', 'UNAVAILABLE'), value: null }]).isErr()
    ).toBe(true);
    expect(
      projectSeries(plan, [
        { period: period('2025-Q2', 'UNAVAILABLE'), value: null },
        { period: period('2025-Q1', 'UNAVAILABLE'), value: null },
        { period: period('2025-Q3', 'UNAVAILABLE'), value: null },
      ]).isErr()
    ).toBe(true);
  });

  it('holds values as Decimal internally (never a float)', () => {
    const envelope = projectSeries(plan, [
      { period: period('2025-Q1', 'AVAILABLE'), value: exact(EXECUTION_EVIDENCE.largeTail) },
      { period: period('2025-Q2', 'UNAVAILABLE'), value: null },
      { period: period('2025-Q3', 'UNAVAILABLE'), value: null },
    ])._unsafeUnwrap();
    expect(envelope.series.data[0]?.value).toBeInstanceOf(Decimal);
  });
});
