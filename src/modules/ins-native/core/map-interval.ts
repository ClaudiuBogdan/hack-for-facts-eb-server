/** Explicit temporal reduction; never conflates time with source classifications. */
import { Decimal } from 'decimal.js';
import { err, ok, type Result } from 'neverthrow';

import { periodTokenBounds } from './identity.js';
import {
  makeMapSeriesRequests,
  selectLatestMapSeries,
  type InsLatestMapRequest,
  type InsLatestMapResult,
} from './map-series.js';
import {
  MAX_OBSERVATION_LIMIT,
  type InsGeoPairs,
  type InsPeriodView,
  type InsSeriesResult,
} from './types.js';

import type { InsRepo } from './ports.js';
import type { ApiError } from '@/modules/shared/index.js';

// Source values have up to 15 integer digits and <=6 decimal places. At most 1,000
// periods add three integer digits. Sums are exact; recurring averages round
// to 40 significant decimal digits, half-up, without changing global Decimal.
const MapDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
const SOURCE_VALUE = /^-?\d{1,15}(?:\.\d{1,6})?$/u;
// Keep the prior maximum hydration capacity while short intervals share setup.
const MAX_HISTORY_ROWS_PER_READ = 40 * (MAX_OBSERVATION_LIMIT + 1);

export interface InsMapInterval {
  readonly operation: 'sum' | 'average' | 'latest';
  /** Canonical YEAR / YEAR-QN / YEAR-MM tokens, including noncontiguous selections. */
  readonly periodTokens: readonly string[];
}

export type InsIntervalMapCell =
  | { readonly status: 'VALUE'; readonly value: string }
  | { readonly status: 'NO_DATA' }
  | {
      readonly status: 'INCOMPLETE';
      readonly missingPeriodCount: number;
      readonly nullPeriodCount: number;
    }
  | { readonly status: 'AMBIGUOUS_GEOGRAPHY'; readonly witnesses: readonly InsGeoPairs[] };

export type InsIntervalMapResult =
  | ({ readonly operation: 'latest' } & InsLatestMapResult)
  | {
      readonly operation: 'sum' | 'average';
      readonly periodTokens: readonly string[];
      readonly currencyCode: string | null;
      readonly cells: ReadonlyMap<string, InsIntervalMapCell>;
    };

const invalid = (message: string): ApiError => ({ type: 'InvalidInput', field: 'period', message });
const inconsistent = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'INS interval publication is inconsistent',
});
const keyOf = (period: { periodicity: string; periodStart: string; periodEnd: string }): string =>
  JSON.stringify([period.periodicity, period.periodStart, period.periodEnd]);

export const readIntervalMapSeries = (
  outer: InsRepo,
  input: InsLatestMapRequest,
  selection: InsMapInterval
): Promise<Result<InsIntervalMapResult, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    if (!['sum', 'average', 'latest'].includes(selection.operation))
      return err(invalid('Choose an explicit INS interval operation: sum, average or latest'));
    if (
      selection.periodTokens.length === 0 ||
      selection.periodTokens.length > MAX_OBSERVATION_LIMIT
    )
      return err(invalid(`Choose between 1 and ${String(MAX_OBSERVATION_LIMIT)} INS periods`));
    const periods = new Map<string, { start: string; end: string }>();
    for (const token of selection.periodTokens) {
      const bounds = periodTokenBounds(token);
      if (
        bounds?.periodicity !== input.periodicity ||
        token !== token.trim() ||
        token.startsWith('0000')
      )
        return err(invalid('INS periods must be canonical tokens of the selected frequency'));
      const key = keyOf({
        periodicity: bounds.periodicity,
        periodStart: bounds.start,
        periodEnd: bounds.end,
      });
      if (periods.has(key)) return err(invalid('INS period tokens must be unique'));
      periods.set(key, bounds);
    }
    const requests = makeMapSeriesRequests(input);
    if (requests.isErr()) return err(requests.error);
    const filter = { periodicities: [input.periodicity], periodRanges: [...periods.values()] };
    const periodIds = new Map<string, number>();
    const periodsById = new Map<number, string>();
    const validatePeriod = (period: InsPeriodView): boolean => {
      const key = keyOf(period);
      if (
        !periods.has(key) ||
        (periodIds.has(key) && periodIds.get(key) !== period.periodId) ||
        (periodsById.has(period.periodId) && periodsById.get(period.periodId) !== key)
      )
        return false;
      periodIds.set(key, period.periodId);
      periodsById.set(period.periodId, key);
      return true;
    };

    if (selection.operation === 'latest') {
      const rows = await repo.readDefaultSeries(requests.value, 2, filter);
      if (rows.isErr()) return err(rows.error);
      if (
        rows.value.some((row) =>
          row.observations.some((observation) => !validatePeriod(observation.period))
        )
      )
        return err(inconsistent());
      const result = selectLatestMapSeries(requests.value, rows.value, input.periodicity);
      return result.isErr() ? err(result.error) : ok({ operation: 'latest', ...result.value });
    }

    const perSeries = periods.size + 1; // One overflow witness; never a partial success.
    const territoriesPerRead = Math.floor(MAX_HISTORY_ROWS_PER_READ / perSeries);
    const cells = new Map<string, InsIntervalMapCell>();
    let currencyCode: string | null | undefined;
    for (let offset = 0; offset < requests.value.length; offset += territoriesPerRead) {
      const chunk = requests.value.slice(offset, offset + territoriesPerRead);
      const rows = await repo.readDefaultSeries(chunk, perSeries, filter);
      if (rows.isErr()) return err(rows.error);
      const byKey = new Map<string, InsSeriesResult>(rows.value.map((row) => [row.seriesKey, row]));
      if (byKey.size !== chunk.length || byKey.size !== rows.value.length)
        return err(inconsistent());
      for (const request of chunk) {
        const row = byKey.get(request.key);
        if (row === undefined) return err(inconsistent());
        if (row.status === 'NO_DATA') {
          cells.set(request.key, { status: row.status });
          continue;
        }
        if (row.status === 'AMBIGUOUS_GEOGRAPHY') {
          cells.set(request.key, { status: row.status, witnesses: row.witnesses });
          continue;
        }
        if (row.observations.length > periods.size) return err(inconsistent());
        if (row.observations.length === 0) return err(inconsistent());
        const seen = new Set<string>();
        let total = new MapDecimal(0);
        let nullPeriodCount = 0;
        for (const observation of row.observations) {
          const key = keyOf(observation.period);
          if (
            !validatePeriod(observation.period) ||
            seen.has(key) ||
            observation.unit.nomItemId !== input.unitNomItemId
          )
            return err(inconsistent());
          seen.add(key);
          if (observation.value === null) {
            nullPeriodCount++;
            continue;
          }
          if (!SOURCE_VALUE.test(observation.value)) return err(inconsistent());
          if (observation.unit.unitKind === 'monetary' && observation.currencyCode === null)
            return err(invalid('INS monetary interval values require a known currency regime'));
          if (currencyCode !== undefined && currencyCode !== observation.currencyCode)
            return err(
              invalid(
                'Selected INS observations use different currency regimes; narrow the selection'
              )
            );
          currencyCode = observation.currencyCode;
          total = total.plus(observation.value);
        }
        const missingPeriodCount = periods.size - seen.size;
        cells.set(
          request.key,
          missingPeriodCount > 0 || nullPeriodCount > 0
            ? { status: 'INCOMPLETE', missingPeriodCount, nullPeriodCount }
            : {
                status: 'VALUE',
                value: (selection.operation === 'sum' ? total : total.div(periods.size)).toFixed(),
              }
        );
      }
    }
    return ok({
      operation: selection.operation,
      periodTokens: [...selection.periodTokens].sort(),
      currencyCode: currencyCode ?? null,
      cells,
    });
  });
