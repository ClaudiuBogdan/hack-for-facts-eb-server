/**
 * Canonical common series SDL registered by the budget slice.
 *
 * `DataPoint` / `DataSeries` are dormant in `src/infra/graphql/common/types.ts`.
 * `DataSeries.frequency` uses `PeriodType`, which the budget slice carries, so
 * the two definitions are registered beside it and only when budget is
 * enabled; the kernel gets no unconditional reference to a budget-owned type.
 * They are sliced byte-for-byte from the canonical source text (parser `loc`),
 * not copied, so a drift in the common source is picked up, never duplicated.
 *
 * Registered by the budget slice (`src/modules/budget/index.ts`) together with
 * the national roots that consume it, so it disappears with budget excluded.
 */

import { Kind, parse } from 'graphql';

import { CommonTypes } from '@/infra/graphql/common/types.js';

export const SERIES_COMMON_TYPE_NAMES = ['DataPoint', 'DataSeries'] as const;

/** Provenance of the carried definitions (same shape as the legacy SDL map). */
export const BUDGET_SERIES_COMMON_SDL_PROVENANCE = {
  'src/infra/graphql/common/types.ts': ['type DataPoint', 'type DataSeries'],
} as const;

const extractCanonical = (): string => {
  const document = parse(CommonTypes);
  const texts = SERIES_COMMON_TYPE_NAMES.map((name) => {
    const definition = document.definitions.find(
      (def) => def.kind === Kind.OBJECT_TYPE_DEFINITION && def.name.value === name
    );
    if (definition?.loc === undefined) {
      throw new Error(`canonical common SDL has no 'type ${name}'`);
    }
    return definition.loc.source.body.slice(definition.loc.start, definition.loc.end);
  });
  return texts.join('\n\n');
};

/** `type DataPoint` and `type DataSeries`, exactly as the common source declares them. */
export const budgetSeriesCommonTypeDefs: string = extractCanonical();
