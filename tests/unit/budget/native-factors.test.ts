/**
 * The native money factors (`makeNativeBudgetFactors`, codebase plan §WP3,
 * T-13): the kernel build reads factor set 2 ONLY, admits it only under its
 * recorded manifest digest, and never asks the reader for a current pointer
 * (the port offered here throws on `current`). The mismatch and missing-kind
 * refusals are re-pinned through this wrapper; the finer set-source semantics
 * (yearly gaps, subannual rows) live in
 * `tests/unit/normalization/factor-set-reader.test.ts`.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  makeNativeBudgetFactors,
  NATIVE_FACTOR_SET_DIGEST,
  NATIVE_FACTOR_SET_ID,
} from '@/modules/budget/shell/native/factors.js';

import type {
  FactorSetReaderPort,
  FactorSetTable,
} from '@/modules/budget/core/legacy-analytics/factor-set-port.js';

const table = (over: Partial<FactorSetTable> = {}): FactorSetTable => ({
  factorSetId: NATIVE_FACTOR_SET_ID,
  manifestDigest: NATIVE_FACTOR_SET_DIGEST,
  rows: [2022, 2023, 2024].map((year) => ({
    kind: 'cpi_index',
    frequency: 'YEAR',
    periodKey: String(year),
    value: `${String(year - 1900)}.5`,
  })),
  ...over,
});

const reader = (load: FactorSetReaderPort['load']) => {
  const requested: string[] = [];
  const port: FactorSetReaderPort = {
    current: () => {
      throw new Error('the native factors must never read the current pointer');
    },
    load: (setId) => {
      requested.push(setId);
      return load(setId);
    },
  };
  return { requested, port };
};

describe('makeNativeBudgetFactors', () => {
  it('pins set 2 under its recorded digest', () => {
    expect(NATIVE_FACTOR_SET_ID).toBe('2');
    expect(NATIVE_FACTOR_SET_DIGEST).toBe(
      '5f2948ec1c350530b43d38b76dbad34bdf3251c9d451d255a41ca015067c3195'
    );
  });

  it('requests exactly set 2 and serves its yearly series as exact decimals', async () => {
    const { requested, port } = reader(() => Promise.resolve(ok(table())));
    const yearly = (await makeNativeBudgetFactors(port).yearly('cpi_index'))._unsafeUnwrap();
    expect(requested).toEqual(['2']);
    expect([...(yearly ?? [])].map(([year, value]) => [year, value.toString()])).toEqual([
      [2022, '122.5'],
      [2023, '123.5'],
      [2024, '124.5'],
    ]);
  });

  it('refuses the set under any other manifest digest or id', async () => {
    for (const over of [
      { manifestDigest: 'a'.repeat(64) },
      { manifestDigest: NATIVE_FACTOR_SET_DIGEST.toUpperCase() },
      { factorSetId: '1' },
    ]) {
      const { port } = reader(() => Promise.resolve(ok(table(over))));
      expect((await makeNativeBudgetFactors(port).yearly('cpi_index'))._unsafeUnwrapErr()).toEqual({
        type: 'ServiceUnavailable',
        message: 'Factor set 2 does not match its configured manifest',
      });
    }
  });

  it('propagates a reader failure and refuses a set without the requested yearly kind', async () => {
    const failing = reader(() =>
      Promise.resolve(err({ type: 'ServiceUnavailable', message: 'set 2 is not promoted' }))
    );
    expect(
      (await makeNativeBudgetFactors(failing.port).yearly('cpi_index'))._unsafeUnwrapErr()
    ).toEqual({ type: 'ServiceUnavailable', message: 'set 2 is not promoted' });

    const { port } = reader(() => Promise.resolve(ok(table())));
    expect((await makeNativeBudgetFactors(port).yearly('ron_per_eur'))._unsafeUnwrapErr()).toEqual({
      type: 'ServiceUnavailable',
      message: 'Factor set 2 has no yearly ron_per_eur series',
    });
  });
});
