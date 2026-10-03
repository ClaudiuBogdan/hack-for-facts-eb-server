/**
 * National budget — validated execution (MF bulletin) root inputs, plus the
 * page-size and `expectedSnapshot` arguments shared with the law roots.
 */

import { err, ok, type Result } from 'neverthrow';

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import {
  boundedInt,
  declaredOrder,
  enumValue,
  idValue,
  isPresent,
  objectWithKeys,
  oneOfMember,
  optionalList,
  requiredList,
  textValue,
  uuidValue,
} from './input-rules.js';
import { validateReportPeriod, type PeriodPlan } from './periods.js';
import {
  EXECUTION_INPUTS,
  EXECUTION_MEASURES,
  EXECUTION_SECTIONS,
  OBSERVATION_DISPOSITIONS,
  PERIOD_ROLES,
  SERIES_BASES,
  type ExecutionInput,
  type ExecutionMeasure,
  type ExecutionSection,
  type ObservationDisposition,
  type PeriodRole,
  type PeriodType,
  type SeriesBasis,
} from './vocabulary.js';

export const MAX_RELEASE_MONTHS = 100;
export const MAX_REVISIONS_PER_MONTH = 20;
export const MAX_RELEASE_CELLS = 300;
export const MAX_OBSERVATION_MONTHS = 300;
export const MAX_SELECTION_IDS = 24;
export const MAX_COMPONENTS = 20;
export const MAX_LINE_ITEMS = 50;
export const MAX_SERIES_ITEMS = 12;
export const MAX_SERIES_LABELS = 300;
/** Not bounded by the design table; a list guard sized to the catalog scale. */
export const MAX_OBSERVATION_ITEM_IDS = 100;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

const componentValue = textValue(100);
const lineItemValue = textValue(200);
const snapshotValue = textValue(128, /^[A-Za-z0-9_.:-]+$/u);

// ── shared arguments ─────────────────────────────────────────────────────────

/** `first`: 1–100, SDL default 50. */
export const validateFirst = (raw: unknown): Result<number, ApiError> =>
  boundedInt(raw, 'first', { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE });

/** Optional cross-call precondition; checked against the lane in the read transaction. */
export const validateExpectedSnapshot = (raw: unknown): Result<string | null, ApiError> =>
  isPresent(raw) ? snapshotValue(raw, 'expectedSnapshot') : ok(null);

/** Optional `after` cursor: bounded opaque text, decoded by the cursor wrapper. */
export const validateAfter = (raw: unknown): Result<string | null, ApiError> =>
  isPresent(raw) ? textValue(2048, /^[A-Za-z0-9_-]+$/u)(raw, 'after') : ok(null);

// ── budgetExecutionReleases ──────────────────────────────────────────────────

export interface ExecutionReleasesQuery {
  readonly months: PeriodPlan;
  readonly revisionsPerMonth: number;
}

export const validateExecutionReleasesInput = (
  raw: unknown
): Result<ExecutionReleasesQuery, ApiError> => {
  const input = objectWithKeys(raw, 'input', ['months', 'revisionsPerMonth']);
  if (input.isErr()) return err(input.error);
  const months = validateReportPeriod(input.value['months'], 'input.months', {
    allowedTypes: ['MONTH'],
    maxLabels: MAX_RELEASE_MONTHS,
  });
  if (months.isErr()) return err(months.error);
  const revisions = boundedInt(input.value['revisionsPerMonth'], 'input.revisionsPerMonth', {
    min: 1,
    max: MAX_REVISIONS_PER_MONTH,
    fallback: 1,
  });
  if (revisions.isErr()) return err(revisions.error);
  if (months.value.labels.length * revisions.value > MAX_RELEASE_CELLS) {
    return err(
      invalidInput(
        `months × revisionsPerMonth must not exceed ${String(MAX_RELEASE_CELLS)}`,
        'input.revisionsPerMonth'
      )
    );
  }
  return ok({ months: months.value, revisionsPerMonth: revisions.value });
};

// ── budgetExecutionObservations ──────────────────────────────────────────────

export type ObservationSource =
  | { readonly kind: 'MONTHS'; readonly months: PeriodPlan }
  | { readonly kind: 'SELECTIONS'; readonly selectionIds: readonly string[] };

export interface ExecutionObservationsQuery {
  readonly source: ObservationSource;
  readonly inputs: readonly ExecutionInput[] | null;
  readonly components: readonly string[] | null;
  readonly sections: readonly ExecutionSection[] | null;
  readonly lineItems: readonly string[] | null;
  /** Known-item check is a catalog fact, applied by the usecase. */
  readonly itemIds: readonly string[] | null;
  readonly measures: readonly ExecutionMeasure[] | null;
  readonly periodRoles: readonly PeriodRole[] | null;
  /** SDL default `[FACT]` when omitted. */
  readonly dispositions: readonly ObservationDisposition[];
  /**
   * True when a non-FACT disposition is requested: the source must then resolve
   * to exactly one selection (checked statically here, finally by the usecase).
   */
  readonly requiresSingleSelection: boolean;
}

const validateObservationSource = (raw: unknown): Result<ObservationSource, ApiError> => {
  const member = oneOfMember(raw, 'input.source', ['months', 'selectionIds'] as const);
  if (member.isErr()) return err(member.error);
  if (member.value.key === 'months') {
    return validateReportPeriod(member.value.value, 'input.source.months', {
      allowedTypes: ['MONTH'],
      maxLabels: MAX_OBSERVATION_MONTHS,
    }).map((months) => ({ kind: 'MONTHS' as const, months }));
  }
  // UUIDs are canonicalised to lowercase before the duplicate check and sort,
  // so filters, filter hashes and pins agree whatever case the caller used.
  return requiredList(member.value.value, 'input.source.selectionIds', {
    max: MAX_SELECTION_IDS,
    item: uuidValue,
    sortKey: (id: string) => id,
  }).map((selectionIds) => ({ kind: 'SELECTIONS' as const, selectionIds }));
};

export const validateExecutionObservationsInput = (
  raw: unknown
): Result<ExecutionObservationsQuery, ApiError> => {
  const input = objectWithKeys(raw, 'input', [
    'source',
    'inputs',
    'components',
    'sections',
    'lineItems',
    'itemIds',
    'measures',
    'periodRoles',
    'dispositions',
  ]);
  if (input.isErr()) return err(input.error);
  const v = input.value;

  const source = validateObservationSource(v['source']);
  if (source.isErr()) return err(source.error);
  const inputs = optionalList(v['inputs'], 'input.inputs', {
    max: EXECUTION_INPUTS.length,
    item: enumValue(EXECUTION_INPUTS),
    sortKey: declaredOrder(EXECUTION_INPUTS),
  });
  if (inputs.isErr()) return err(inputs.error);
  const components = optionalList(v['components'], 'input.components', {
    max: MAX_COMPONENTS,
    item: componentValue,
    sortKey: (s: string) => s,
  });
  if (components.isErr()) return err(components.error);
  const sections = optionalList(v['sections'], 'input.sections', {
    max: EXECUTION_SECTIONS.length,
    item: enumValue(EXECUTION_SECTIONS),
    sortKey: declaredOrder(EXECUTION_SECTIONS),
  });
  if (sections.isErr()) return err(sections.error);
  const lineItems = optionalList(v['lineItems'], 'input.lineItems', {
    max: MAX_LINE_ITEMS,
    item: lineItemValue,
    sortKey: (s: string) => s,
  });
  if (lineItems.isErr()) return err(lineItems.error);
  const itemIds = optionalList(v['itemIds'], 'input.itemIds', {
    max: MAX_OBSERVATION_ITEM_IDS,
    item: idValue,
    sortKey: (s: string) => s,
  });
  if (itemIds.isErr()) return err(itemIds.error);
  if (itemIds.value !== null && inputs.value !== null && !inputs.value.includes('BGC')) {
    return err(
      invalidInput(
        'input.itemIds match BGC observations only; include BGC in input.inputs',
        'input.itemIds'
      )
    );
  }
  const measures = optionalList(v['measures'], 'input.measures', {
    max: EXECUTION_MEASURES.length,
    item: enumValue(EXECUTION_MEASURES),
    sortKey: declaredOrder(EXECUTION_MEASURES),
  });
  if (measures.isErr()) return err(measures.error);
  const periodRoles = optionalList(v['periodRoles'], 'input.periodRoles', {
    max: PERIOD_ROLES.length,
    item: enumValue(PERIOD_ROLES),
    sortKey: declaredOrder(PERIOD_ROLES),
  });
  if (periodRoles.isErr()) return err(periodRoles.error);
  const dispositions = optionalList(v['dispositions'], 'input.dispositions', {
    max: OBSERVATION_DISPOSITIONS.length,
    item: enumValue(OBSERVATION_DISPOSITIONS),
    sortKey: declaredOrder(OBSERVATION_DISPOSITIONS),
  });
  if (dispositions.isErr()) return err(dispositions.error);
  const chosen = dispositions.value ?? (['FACT'] as const);

  const requiresSingleSelection = chosen.some((disposition) => disposition !== 'FACT');
  if (requiresSingleSelection) {
    const single =
      source.value.kind === 'SELECTIONS'
        ? source.value.selectionIds.length === 1
        : source.value.months.labels.length === 1;
    if (!single) {
      return err(
        invalidInput(
          'BLANK, UNRESOLVED and NONFINANCIAL require exactly one selection (one selectionId or one month)',
          'input.dispositions'
        )
      );
    }
  }

  return ok({
    source: source.value,
    inputs: inputs.value,
    components: components.value,
    sections: sections.value,
    lineItems: lineItems.value,
    itemIds: itemIds.value,
    measures: measures.value,
    periodRoles: periodRoles.value,
    dispositions: chosen,
    requiresSingleSelection,
  });
};

// ── budgetNationalExecutionSeries ────────────────────────────────────────────

/** The five reviewed frequency × basis grids. */
export const SERIES_GRIDS: Readonly<Record<SeriesBasis, readonly PeriodType[]>> = {
  YTD: ['MONTH', 'QUARTER'],
  PERIOD_DIFFERENCE: ['MONTH', 'QUARTER'],
  FULL_YEAR: ['YEAR'],
};

export interface NationalExecutionSeriesQuery {
  /**
   * Caller order, kept for the result array (chart/legend order). Duplicates
   * are refused; a cache key or hash must canonicalise separately.
   */
  readonly itemIds: readonly string[];
  readonly period: PeriodPlan;
  readonly basis: SeriesBasis;
}

export const validateNationalExecutionSeriesInput = (
  raw: unknown
): Result<NationalExecutionSeriesQuery, ApiError> => {
  const input = objectWithKeys(raw, 'input', ['itemIds', 'period', 'basis']);
  if (input.isErr()) return err(input.error);
  const itemIds = requiredList(input.value['itemIds'], 'input.itemIds', {
    max: MAX_SERIES_ITEMS,
    item: idValue,
  });
  if (itemIds.isErr()) return err(itemIds.error);
  const basis = enumValue(SERIES_BASES)(input.value['basis'], 'input.basis');
  if (basis.isErr()) return err(basis.error);
  const period = validateReportPeriod(input.value['period'], 'input.period', {
    allowedTypes: SERIES_GRIDS[basis.value],
    maxLabels: MAX_SERIES_LABELS,
  });
  if (period.isErr()) return err(period.error);
  return ok({ itemIds: itemIds.value, period: period.value, basis: basis.value });
};
