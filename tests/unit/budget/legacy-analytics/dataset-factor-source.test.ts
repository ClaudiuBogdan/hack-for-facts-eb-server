/**
 * The YAML `FactorSource` adapter: dataset ids, the D2 representation of
 * `cpi_index` (chain-linked level, 12 dp, anchor 100), pass-through for the
 * observed kinds, and the error policy (NotFound → null + ONE warning per
 * kind; any other failure → `Upstream`; an un-chain-linkable CPI → `Upstream`).
 */

import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  chainLinkCpiLevels,
  CpiChainError,
} from '../../../../src/modules/budget/shell/factors/cpi-level.js';
import {
  FACTOR_DATASET_IDS,
  makeDatasetFactorSource,
  type DatasetReader,
} from '../../../../src/modules/budget/shell/factors/dataset-factor-source.js';

import type { Logger } from '../../../../src/modules/shared/index.js';

const points = (entries: Record<string, string>): { x: string; y: Decimal }[] =>
  Object.entries(entries).map(([x, y]) => ({ x, y: new Decimal(y) }));

const reader = (
  datasets: Record<string, { x: string; y: Decimal }[] | { type: string; message: string }>
): { reader: DatasetReader; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    reader: {
      getById: (id) => {
        asked.push(id);
        const d = datasets[id];
        if (d === undefined) return Promise.resolve(err({ type: 'NotFound', message: `no ${id}` }));
        if (Array.isArray(d)) return Promise.resolve(ok({ points: d }));
        return Promise.resolve(err(d));
      },
    },
  };
};

const logger = (): { logger: Logger; warnings: unknown[] } => {
  const warnings: unknown[] = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (obj) => warnings.push(obj),
      error: () => undefined,
      debug: () => undefined,
    },
  };
};

describe('makeDatasetFactorSource', () => {
  it('maps every factor kind to the legacy NORMALIZATION_DATASETS id', () => {
    expect(FACTOR_DATASET_IDS).toEqual({
      cpi_index: 'ro.economics.cpi.yearly',
      ron_per_eur: 'ro.economics.exchange.ron_eur.yearly',
      ron_per_usd: 'ro.economics.exchange.ron_usd.yearly',
      gdp_ron: 'ro.economics.gdp.yearly',
      population_ro: 'ro.demographics.population.yearly',
    });
  });

  it('cpi_index is the D2 chain-linked LEVEL (anchor 100 the year before the first index, 12 dp), not the YoY index', async () => {
    const { reader: r } = reader({
      'ro.economics.cpi.yearly': points({ '2022': '113.80', '2023': '110.40', '2024': '105.59' }),
    });
    const series = (await makeDatasetFactorSource(r).yearly('cpi_index'))._unsafeUnwrap()!;
    expect(series.get(2022)?.toString()).toBe('113.8'); // 100 × 1.138
    expect(series.get(2023)?.toString()).toBe('125.6352'); // × 1.104
    expect(series.get(2024)?.toString()).toBe('132.65820768'); // × 1.0559
    // A ratio of levels is the legacy YoY multiplier, exactly.
    expect(series.get(2024)!.div(series.get(2023)!).toString()).toBe('1.0559');
  });

  it('the chain is exact rational arithmetic rounded half-up ONCE per year to 12 dp (D2 `chainLinkLevels`)', () => {
    const levels = chainLinkCpiLevels(
      new Map([
        [2001, new Decimal('103.3')],
        [2002, new Decimal('101.07')],
        [2003, new Decimal('100.1')],
      ])
    );
    expect(levels.get(2001)).toBe('103.300000000000');
    // 103.3 × 1.0107 = 104.40531 exactly.
    expect(levels.get(2002)).toBe('104.405310000000');
    // × 1.001 = 104.50971531 exactly.
    expect(levels.get(2003)).toBe('104.509715310000');
  });

  it('the observed kinds pass through unchanged; non-year labels are dropped', async () => {
    const { reader: r } = reader({
      'ro.economics.exchange.ron_eur.yearly': [
        ...points({ '2023': '4.9465', '2024': '4.9746' }),
        { x: '2024-01', y: new Decimal('5') },
      ],
    });
    const series = (await makeDatasetFactorSource(r).yearly('ron_per_eur'))._unsafeUnwrap()!;
    expect([...series].map(([y, v]) => [y, v.toString()])).toEqual([
      [2023, '4.9465'],
      [2024, '4.9746'],
    ]);
  });

  it('NotFound → null (legacy: unadjusted) and ONE warning per kind, never silent', async () => {
    const { reader: r } = reader({});
    const log = logger();
    const source = makeDatasetFactorSource(r, log.logger);
    expect((await source.yearly('gdp_ron'))._unsafeUnwrap()).toBeNull();
    expect((await source.yearly('gdp_ron'))._unsafeUnwrap()).toBeNull();
    expect((await source.yearly('population_ro'))._unsafeUnwrap()).toBeNull();
    expect(log.warnings).toHaveLength(2);
    expect(log.warnings[0]).toMatchObject({
      factorKind: 'gdp_ron',
      datasetId: 'ro.economics.gdp.yearly',
    });
  });

  it('DELTA: any other dataset failure is Upstream (legacy get-analytics-series.ts:301-316 swallowed every error kind)', async () => {
    for (const type of ['ReadError', 'ParseError', 'SchemaValidationError', 'IdMismatch']) {
      const { reader: r } = reader({
        'ro.economics.cpi.yearly': { type, message: `${type} boom` },
      });
      const res = await makeDatasetFactorSource(r).yearly('cpi_index');
      expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'Upstream', service: 'datasets' });
      expect(res._unsafeUnwrapErr().message).toContain(`${type} boom`);
    }
  });

  it('DELTA: a non-positive or gapped CPI series cannot be chain-linked → Upstream (legacy skipped the point)', async () => {
    const zero = reader({
      'ro.economics.cpi.yearly': points({ '2022': '113.80', '2023': '0', '2024': '105.59' }),
    });
    const res = await makeDatasetFactorSource(zero.reader).yearly('cpi_index');
    expect(res._unsafeUnwrapErr()).toMatchObject({ type: 'Upstream' });
    expect(res._unsafeUnwrapErr().message).toContain('must be positive');

    const gap = reader({
      'ro.economics.cpi.yearly': points({ '2022': '113.80', '2024': '105.59' }),
    });
    const res2 = await makeDatasetFactorSource(gap.reader).yearly('cpi_index');
    expect(res2._unsafeUnwrapErr()).toMatchObject({ type: 'Upstream' });
    expect(res2._unsafeUnwrapErr().message).toContain('gap');

    expect(() => chainLinkCpiLevels(new Map([[2022, new Decimal('-1')]]))).toThrow(CpiChainError);
  });
});
