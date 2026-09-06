/** One publication snapshot for catalog selection and the complete map read. */
import { err, ok, type Result } from 'neverthrow';

import {
  readIntervalMapSeries,
  type InsMapInterval,
  type InsIntervalMapResult,
} from './map-interval.js';
import {
  prepareInsMapSelection,
  type InsMapSelection,
  type InsMapSelectionInput,
} from './map-selection.js';
import { readLatestMapSeries, type InsLatestMapResult } from './map-series.js';

import type { InsRepo } from './ports.js';
import type { ApiError } from '@/modules/shared/index.js';

export interface InsMapDataInput extends InsMapSelectionInput {
  /** Omitted means latest available. Every interval has an explicit operation. */
  readonly interval?: InsMapInterval;
}

export interface InsMapData {
  readonly selection: InsMapSelection;
  readonly series: InsIntervalMapResult | ({ readonly operation: 'latest' } & InsLatestMapResult);
}

/** The caller supplies its operation read-session repo to retain the deadline. */
export const readInsMapData = (
  outer: InsRepo,
  input: InsMapDataInput
): Promise<Result<InsMapData, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    const selection = await prepareInsMapSelection(repo, input);
    if (selection.isErr()) return err(selection.error);
    const series =
      input.interval === undefined
        ? (await readLatestMapSeries(repo, selection.value.request)).map((value) => ({
            operation: 'latest' as const,
            ...value,
          }))
        : await readIntervalMapSeries(repo, selection.value.request, input.interval);
    return series.isErr()
      ? err(series.error)
      : ok({ selection: selection.value, series: series.value });
  });
