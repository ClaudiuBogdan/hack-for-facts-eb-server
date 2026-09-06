/** Latest INS map values share one reference period; older values never fill gaps. */
import { err, ok, type Result } from 'neverthrow';

import type { InsRepo } from './ports.js';
import type {
  InsDefaultSeriesRequest,
  InsGeoPairs,
  InsObservationView,
  InsPeriodicity,
  InsPeriodView,
  InsSeriesResult,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';

/** Internal selection: source members and modern territory IDs are already resolved. */
export interface InsLatestMapRequest {
  readonly datasetCode: string;
  readonly nonGeographicPins: ReadonlyMap<number, number>;
  readonly unitNomItemId: number;
  readonly periodicity: InsPeriodicity;
  readonly territories: readonly { readonly code: string; readonly territoryId: number }[];
}

export type InsLatestMapCell =
  | { readonly status: 'OBSERVATION'; readonly observation: InsObservationView }
  | { readonly status: 'NO_DATA' | 'MISSING_REFERENCE_PERIOD' }
  | { readonly status: 'AMBIGUOUS_GEOGRAPHY'; readonly witnesses: readonly InsGeoPairs[] };

export interface InsLatestMapResult {
  /** Latest among uniquely resolved eligible series, including null-valued observations. */
  readonly referencePeriod: InsPeriodView | null;
  readonly cells: ReadonlyMap<string, InsLatestMapCell>;
}

const unavailable = (): ApiError => ({
  type: 'ServiceUnavailable',
  message: 'INS map series publication is inconsistent',
});
const periodKey = (period: InsPeriodView): string =>
  JSON.stringify([period.periodicity, period.periodStart, period.periodEnd]);
const comparePeriods = (left: InsPeriodView, right: InsPeriodView): number => {
  const end = left.periodEnd.localeCompare(right.periodEnd);
  return end !== 0 ? end : left.periodStart.localeCompare(right.periodStart);
};

export const makeMapSeriesRequests = (
  input: InsLatestMapRequest
): Result<InsDefaultSeriesRequest[], ApiError> => {
  const codes = new Set(input.territories.map((territory) => territory.code));
  if (
    codes.size !== input.territories.length ||
    codes.has('') ||
    new Set(input.territories.map((territory) => territory.territoryId)).size !== codes.size
  ) {
    return err({
      type: 'InvalidInput',
      field: 'territories',
      message: 'INS map territories must have unique codes and identities',
    });
  }
  return ok<InsDefaultSeriesRequest[], ApiError>(
    input.territories.map((territory) => ({
      key: territory.code,
      datasetCode: input.datasetCode,
      nonGeographicPins: input.nonGeographicPins,
      unitNomItemId: input.unitNomItemId,
      geoScope: { kind: 'modern', territoryIds: [territory.territoryId] },
    }))
  );
};

export const selectLatestMapSeries = (
  requests: readonly InsDefaultSeriesRequest[],
  rows: readonly InsSeriesResult[],
  periodicity: InsPeriodicity
): Result<InsLatestMapResult, ApiError> => {
  const codes = new Set(requests.map((request) => request.key));
  const results = new Map(rows.map((row) => [row.seriesKey, row]));
  if (
    results.size !== requests.length ||
    results.size !== rows.length ||
    [...results.keys()].some((key) => !codes.has(key))
  )
    return err(unavailable());

  let referencePeriod: InsPeriodView | null = null;
  const periodIds = new Map<string, number>();
  const periodsById = new Map<number, string>();
  for (const row of results.values()) {
    if (row.status !== 'SERIES') continue;
    const [head, second] = row.observations;
    if (head === undefined || row.observations.length > 2) return err(unavailable());
    for (const observation of row.observations) {
      const period = observation.period;
      const key = periodKey(period);
      const knownId = periodIds.get(key);
      const knownPeriod = periodsById.get(period.periodId);
      if (
        period.periodicity !== periodicity ||
        (knownId !== undefined && knownId !== period.periodId) ||
        (knownPeriod !== undefined && knownPeriod !== key)
      )
        return err(unavailable());
      periodIds.set(key, period.periodId);
      periodsById.set(period.periodId, key);
    }
    if (
      second !== undefined &&
      (periodKey(head.period) === periodKey(second.period) ||
        comparePeriods(head.period, second.period) < 0)
    )
      return err(unavailable());
    if (referencePeriod === null || comparePeriods(head.period, referencePeriod) > 0)
      referencePeriod = head.period;
  }

  const cells = new Map<string, InsLatestMapCell>();
  for (const request of requests) {
    const row = results.get(request.key);
    if (row === undefined) return err(unavailable());
    if (row.status === 'AMBIGUOUS_GEOGRAPHY') {
      cells.set(request.key, { status: row.status, witnesses: row.witnesses });
    } else if (row.status === 'NO_DATA') {
      cells.set(request.key, { status: row.status });
    } else {
      const head = row.observations[0];
      if (head === undefined || referencePeriod === null) return err(unavailable());
      cells.set(
        request.key,
        periodKey(head.period) === periodKey(referencePeriod)
          ? { status: 'OBSERVATION', observation: head }
          : { status: 'MISSING_REFERENCE_PERIOD' }
      );
    }
  }
  return ok({ referencePeriod, cells });
};

/** Use the operation's read-session repository to retain its deadline. */
export const readLatestMapSeries = (
  outer: InsRepo,
  input: InsLatestMapRequest
): Promise<Result<InsLatestMapResult, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    const requests = makeMapSeriesRequests(input);
    if (requests.isErr()) return err(requests.error);
    // Full-source ambiguity precedes the two newest observations. The second
    // exposes competing time identities; it is not a history to aggregate.
    const rows = await repo.readDefaultSeries(requests.value, 2, {
      periodicities: [input.periodicity],
    });
    return rows.isErr()
      ? err(rows.error)
      : selectLatestMapSeries(requests.value, rows.value, input.periodicity);
  });
