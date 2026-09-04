import { err, ok } from 'neverthrow';

import { legacyDecimal } from '../../core/legacy-analytics/decimal.js';

import type { FactorSource } from '../../core/legacy-analytics/ports.js';
import type { FactorSetReader } from '@/modules/normalization/index.js';

/** Phase A/S1-5: an INTERNAL pin, independent of the current release pointer. */
export const LEGACY_FACTOR_SET_ID = '1';
export const LEGACY_FACTOR_SET_DIGEST =
  '69cc0473af19ffb406fe9f2ed3f82c7785a3aa4ea6df74dfd360220c92e41078';

export const makeFactorSetSource = (
  reader: Pick<FactorSetReader, 'load'>,
  setId: string,
  expectedDigest: string
): FactorSource => ({
  async yearly(kind) {
    const loaded = await reader.load(setId);
    if (loaded.isErr()) return err(loaded.error);
    if (loaded.value.factorSetId !== setId || loaded.value.manifestDigest !== expectedDigest) {
      return err({
        type: 'ServiceUnavailable',
        message: `Factor set ${setId} does not match its configured manifest`,
      });
    }
    const rows = loaded.value.rows.filter((row) => row.kind === kind && row.frequency === 'YEAR');
    if (rows.length === 0) {
      return err({
        type: 'ServiceUnavailable',
        message: `Factor set ${setId} has no yearly ${kind} series`,
      });
    }
    const years = rows.map((row) => Number(row.periodKey)).sort((a, b) => a - b);
    if (
      years.some((year, i) => {
        const previous = years[i - 1];
        return previous !== undefined && year !== previous + 1;
      })
    ) {
      return err({
        type: 'ServiceUnavailable',
        message: `Factor set ${setId} has a gap in yearly ${kind}`,
      });
    }
    // CPI is already the chain-linked price level. No rechaining or float conversion.
    return ok(new Map(rows.map((row) => [Number(row.periodKey), legacyDecimal(row.value)])));
  },
});
