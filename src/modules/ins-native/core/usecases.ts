/**
 * Public identifiers resolve to typed repository inputs here. Observation lists
 * use complete source coordinates or explicit modern geographic scopes; numeric
 * classification members and TOTAL resolve separately and intersect that scope.
 * Default preparation pins classifications; the repository probes complete
 * eligible source tuples and reports ambiguity before selecting any latest row.
 */

import { err, ok, type Result } from 'neverthrow';

import { buildDefaultSeries, type InsDefaultSelection } from './default-series.js';
import { observationGeoScope } from './geography.js';
import {
  isTotalAlias,
  parseDimensionCode,
  parseMemberCode,
  periodTokenBounds,
} from './identity.js';
import {
  DASHBOARD_ROWS_PER_DATASET,
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_DATASET_LIMIT,
  DEFAULT_DIMENSION_VALUES_LIMIT,
  DEFAULT_OBSERVATION_LIMIT,
  DEFAULT_TERRITORY_LIMIT,
  MAX_BATCH_DATASETS,
  MAX_CONTEXT_LIMIT,
  MAX_DATASET_LIMIT,
  MAX_DIMENSION_VALUES_LIMIT,
  MAX_OBSERVATION_LIMIT,
  MAX_TERRITORY_LIMIT,
  type InsContext,
  type InsContextFilter,
  type InsDashboardGroup,
  type InsDatasetFilter,
  type InsDatasetView,
  type InsDimensionView,
  type InsEntitySelector,
  type InsFactQuery,
  type InsLatestValue,
  type InsMemberView,
  type InsObservationFilter,
  type InsObservationView,
  type InsPage,
  type InsPeriodFilter,
  type InsPeriodicity,
  type InsTerritoryLevel,
  type InsTerritoryFilter,
  type InsTerritoryNode,
  type SlotPins,
} from './types.js';

import type { InsRepo } from './ports.js';
import type { ApiError } from '@/modules/shared/index.js';

const invalidInput = (message: string, field?: string): ApiError => ({
  type: 'InvalidInput',
  message,
  ...(field !== undefined && { field }),
});

const clamp = (value: number | undefined, dflt: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return dflt;
  return Math.min(Math.max(Math.floor(value), 1), max);
};

const offsetOf = (value: number | undefined): number =>
  value === undefined || !Number.isFinite(value) || value < 0 ? 0 : Math.floor(value);

/** A classification dimension with its physical slot (the only kind a pin can target). */
interface SlottedDimension {
  readonly dimIndex: number;
  readonly slotIndex: number;
}

const isTerritorialDim = (dimensions: readonly InsDimensionView[], dimIndex: number): boolean =>
  dimensions.some((d) => d.dimIndex === dimIndex && d.isTerritorial);

const slotted = (dimensions: readonly InsDimensionView[]): SlottedDimension[] =>
  dimensions.flatMap((d) =>
    d.role === 'classification' && d.slotIndex !== null
      ? [{ dimIndex: d.dimIndex, slotIndex: d.slotIndex }]
      : []
  );

// ─────────────────────────────────────────────────────────────────────────────
// Catalog usecases (thin: clamp, delegate)
// ─────────────────────────────────────────────────────────────────────────────

export const listDatasets = (
  repo: InsRepo,
  filter: InsDatasetFilter,
  limit?: number,
  offset?: number
): Promise<Result<InsPage<InsDatasetView>, ApiError>> =>
  repo.listDatasets(
    filter,
    clamp(limit, DEFAULT_DATASET_LIMIT, MAX_DATASET_LIMIT),
    offsetOf(offset)
  );

export const getDataset = (
  repo: InsRepo,
  code: string
): Promise<Result<InsDatasetView | null, ApiError>> => repo.getDataset(code.trim().toUpperCase());

export const listDimensions = (
  repo: InsRepo,
  datasetCode: string
): Promise<Result<readonly InsDimensionView[], ApiError>> => repo.listDimensions(datasetCode);

export const listDimensionValues = async (
  repo: InsRepo,
  datasetCode: string,
  dimIndex: number,
  search: string | undefined,
  limit?: number,
  offset?: number
): Promise<Result<InsPage<InsMemberView>, ApiError>> => {
  if (!Number.isInteger(dimIndex) || dimIndex < 0) {
    return err(invalidInput('dimensionIndex must be a non-negative integer', 'dimensionIndex'));
  }
  return repo.listMembers(
    datasetCode,
    dimIndex,
    search?.trim() === '' ? undefined : search?.trim(),
    clamp(limit, DEFAULT_DIMENSION_VALUES_LIMIT, MAX_DIMENSION_VALUES_LIMIT),
    offsetOf(offset)
  );
};

export const listContexts = (
  repo: InsRepo,
  filter: InsContextFilter,
  limit?: number,
  offset?: number
): Promise<Result<InsPage<InsContext>, ApiError>> =>
  repo.listContexts(
    filter,
    clamp(limit, DEFAULT_CONTEXT_LIMIT, MAX_CONTEXT_LIMIT),
    offsetOf(offset)
  );

export const listTerritories = (
  repo: InsRepo,
  filter: InsTerritoryFilter,
  limit?: number,
  offset?: number
): Promise<Result<InsPage<InsTerritoryNode>, ApiError>> =>
  repo.listTerritories(
    filter,
    clamp(limit, DEFAULT_TERRITORY_LIMIT, MAX_TERRITORY_LIMIT),
    offsetOf(offset)
  );

// ─────────────────────────────────────────────────────────────────────────────
// Territory resolution → slot pins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the territory part of a filter to spine nodes. `sirutaCodes` and
 * `territoryCodes` AND together on the legacy surface; here they simply
 * intersect (a node must match every given list). Unknown codes resolve to
 * nothing — the caller decides whether "nothing" is an empty page or an error.
 */
export const resolveTerritoryNodes = async (
  repo: InsRepo,
  filter: Pick<InsObservationFilter, 'territoryCodes' | 'sirutaCodes' | 'territoryLevels'>
): Promise<
  Result<
    readonly InsTerritoryNode[] | { readonly levels: readonly InsTerritoryLevel[] } | null,
    ApiError
  >
> => {
  const wantsSiruta = filter.sirutaCodes !== undefined && filter.sirutaCodes.length > 0;
  const wantsCodes = filter.territoryCodes !== undefined && filter.territoryCodes.length > 0;
  const levels = filter.territoryLevels;
  if (!wantsSiruta && !wantsCodes) {
    // Levels alone select EVERY territory of those levels — expressed as a level
    // predicate on the dimension, never as a node list a limit could truncate.
    if (levels === undefined || levels.length === 0) return ok(null);
    return ok({ levels });
  }
  let selected: InsTerritoryNode[] | null = null;
  if (wantsCodes) {
    const byCode = await repo.territoriesByCodes(filter.territoryCodes ?? [], levels);
    if (byCode.isErr()) return err(byCode.error);
    selected = [...byCode.value];
  }
  if (wantsSiruta) {
    const bySiruta = await repo.territoriesBySiruta(filter.sirutaCodes ?? []);
    if (bySiruta.isErr()) return err(bySiruta.error);
    const keep = new Set(bySiruta.value.map((n) => n.territoryId));
    selected =
      selected === null ? [...bySiruta.value] : selected.filter((n) => keep.has(n.territoryId));
  }
  const filtered =
    levels !== undefined && levels.length > 0
      ? (selected ?? []).filter((n) => levels.includes(n.level))
      : (selected ?? []);
  return ok(filtered);
};

// ─────────────────────────────────────────────────────────────────────────────
// Classification pins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve `classificationTypeCodes` (`D<n>`) + `classificationValueCodes`
 * (member codes or `TOTAL`) into slot pins. Semantics, deliberately exact:
 *  - with type codes: every listed dimension is pinned to the listed members
 *    that BELONG to it (a member code is only matched inside its dimension;
 *    `TOTAL` means that dimension's TOTAL member);
 *  - without type codes: each member code pins the dimension it belongs to;
 *    `TOTAL` alone pins EVERY classification dimension to its TOTAL member.
 * A code that belongs to no dimension is an `InvalidInput`. A dimension that
 * was asked for TOTAL but has no TOTAL member cannot be pinned: the result
 * carries it in `unpinnable`, and the caller answers NO_DATA / an empty page
 * (decision D1b: never a label match, never every member).
 */
export const classificationPins = async (
  repo: InsRepo,
  datasetCode: string,
  dimensions: readonly InsDimensionView[],
  filter: Pick<InsObservationFilter, 'classificationTypeCodes' | 'classificationValueCodes'>,
  options: { readonly territoryPinned?: boolean } = {}
): Promise<
  Result<
    {
      pins: SlotPins;
      explicitPins: ReadonlyMap<number, readonly number[]>;
      unpinnable: readonly number[];
    },
    ApiError
  >
> => {
  const classification = slotted(dimensions);
  const bySlotOfDim = new Map(classification.map((d) => [d.dimIndex, d.slotIndex]));
  // The implicit TOTAL (no type codes) never touches a territorial dimension when
  // the request already names a territory: the territory pins decide those slots.
  const implicitTotalDims = classification
    .filter((d) => options.territoryPinned !== true || !isTerritorialDim(dimensions, d.dimIndex))
    .map((d) => d.dimIndex);
  const typeCodes = filter.classificationTypeCodes ?? [];
  const valueCodes = filter.classificationValueCodes ?? [];
  const pins = new Map<number, number[]>();
  const explicitPins = new Map<number, number[]>();

  const targetDims: number[] = [];
  for (const code of typeCodes) {
    const dimIndex = parseDimensionCode(code);
    if (dimIndex === null || !bySlotOfDim.has(dimIndex)) {
      return err(
        invalidInput(`unknown classification dimension code ${code}`, 'classificationTypeCodes')
      );
    }
    targetDims.push(dimIndex);
  }

  const wantsTotal = valueCodes.some(isTotalAlias);
  const memberIds: number[] = [];
  for (const code of valueCodes) {
    if (isTotalAlias(code)) continue;
    const id = parseMemberCode(code);
    if (id === null) {
      return err(
        invalidInput(`unknown classification value code ${code}`, 'classificationValueCodes')
      );
    }
    memberIds.push(id);
  }

  const dimsForTotal = targetDims.length > 0 ? targetDims : implicitTotalDims;
  const unpinnable: number[] = [];
  if (wantsTotal) {
    for (const dimIndex of dimsForTotal) {
      const slot = bySlotOfDim.get(dimIndex);
      if (slot === undefined) continue;
      const total = await repo.totalMember(datasetCode, dimIndex);
      if (total.isErr()) return err(total.error);
      if (total.value === null) {
        unpinnable.push(dimIndex);
        continue;
      }
      pins.set(slot, [...(pins.get(slot) ?? []), total.value]);
      if (targetDims.length > 0)
        explicitPins.set(slot, [...(explicitPins.get(slot) ?? []), total.value]);
    }
  }

  if (memberIds.length > 0) {
    const members = await repo.membersByIds(datasetCode, memberIds);
    if (members.isErr()) return err(members.error);
    const found = new Set<number>();
    for (const m of members.value) {
      const slot = bySlotOfDim.get(m.dimIndex);
      if (slot === undefined) continue; // a time/unit member is not a classification pin
      if (targetDims.length > 0 && !targetDims.includes(m.dimIndex)) continue;
      found.add(m.nomItemId);
      pins.set(slot, [...(pins.get(slot) ?? []), m.nomItemId]);
      explicitPins.set(slot, [...(explicitPins.get(slot) ?? []), m.nomItemId]);
    }
    const missing = memberIds.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return err(
        invalidInput(
          `classification value code(s) not in dataset ${datasetCode}: ${missing.join(', ')}`,
          'classificationValueCodes'
        )
      );
    }
  }
  return ok({ pins, explicitPins, unpinnable });
};

/** Unit codes are unit member ids; unknown ones are an InvalidInput. */
export const unitPins = async (
  repo: InsRepo,
  datasetCode: string,
  unitCodes: readonly string[] | undefined
): Promise<Result<readonly number[] | undefined, ApiError>> => {
  if (unitCodes === undefined || unitCodes.length === 0) return ok(undefined);
  const units = await repo.listUnits(datasetCode);
  if (units.isErr()) return err(units.error);
  const known = new Set(units.value.map((u) => u.nomItemId));
  const ids: number[] = [];
  for (const code of unitCodes) {
    const id = parseMemberCode(code);
    if (id === null || !known.has(id)) {
      return err(invalidInput(`unknown unit code ${code} for dataset ${datasetCode}`, 'unitCodes'));
    }
    ids.push(id);
  }
  return ok(ids);
};

export interface PeriodPredicates {
  readonly periodicities?: readonly InsPeriodicity[];
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodRanges?: readonly { readonly start: string; readonly end: string }[];
}

/** Period filter → the fact query's period predicates. Tokens are validated. */
export const periodPredicates = (
  period: InsPeriodFilter | undefined
): Result<PeriodPredicates, ApiError> => {
  if (period === undefined) return ok({});
  const out: {
    periodicities?: readonly InsPeriodicity[];
    periodStart?: string;
    periodEnd?: string;
    periodRanges?: { start: string; end: string }[];
  } = {};
  if (period.periodicity !== undefined) out.periodicities = [period.periodicity];
  if (period.tokens !== undefined && period.tokens.length > 0) {
    // `dates` selects EXACTLY those periods (the legacy semantics), never the span
    // between them, and only at the token's own periodicity (an annual token never
    // matches the monthly rows overlapping that year).
    const ranges: { start: string; end: string }[] = [];
    let periodicity: InsPeriodicity | undefined = period.periodicity;
    for (const token of period.tokens) {
      const b = periodTokenBounds(token);
      if (b === null) return err(invalidInput(`invalid period token ${token}`, 'period'));
      // Every token must be of ONE periodicity (the filter's, when given): a
      // year token next to a month token cannot mean one thing.
      if (periodicity !== undefined && b.periodicity !== periodicity) {
        return err(invalidInput(`period token ${token} is not ${periodicity}`, 'period'));
      }
      periodicity = b.periodicity;
      ranges.push({ start: b.start, end: b.end });
    }
    out.periodRanges = ranges;
    if (periodicity !== undefined) out.periodicities = [periodicity];
    return ok(out);
  }
  if (period.start !== undefined) {
    const b = periodTokenBounds(period.start);
    if (b === null) return err(invalidInput(`invalid period start ${period.start}`, 'period'));
    out.periodStart = b.start;
  }
  if (period.end !== undefined) {
    const b = periodTokenBounds(period.end);
    if (b === null) return err(invalidInput(`invalid period end ${period.end}`, 'period'));
    out.periodEnd = b.end;
  }
  return ok(out);
};

// ─────────────────────────────────────────────────────────────────────────────
// Observations
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_PAGE: InsPage<InsObservationView> = {
  nodes: [],
  totalCount: 0,
  hasNextPage: false,
  hasPreviousPage: false,
};

/**
 * `insObservations`: dataset mandatory; territory and classification pins are
 * resolved to physical predicates; the repository reads limit+1 rows.
 * An empty resolved territory set (every requested code unknown) is an empty
 * page, not an error — the legacy surface behaved the same.
 */
export const listObservations = (
  outer: InsRepo,
  datasetCode: string,
  filter: InsObservationFilter,
  limit?: number,
  offset?: number
): Promise<Result<InsPage<InsObservationView>, ApiError>> =>
  outer.withSnapshot(async (repo) => {
    const code = datasetCode.trim().toUpperCase();
    const dataset = await repo.getDataset(code);
    if (dataset.isErr()) return err(dataset.error);
    if (dataset.value === null || dataset.value.publicationStatus === 'NOT_LOADED')
      return ok(EMPTY_PAGE);
    if (dataset.value.dataStatus !== 'AVAILABLE') {
      return err({ type: 'ServiceUnavailable', message: 'INS dataset publication is unavailable' });
    }
    const dimensions = await repo.listDimensions(code);
    if (dimensions.isErr()) return err(dimensions.error);
    // An unknown dataset is an EMPTY page, not an error: the entity page sends
    // aliased batches of literal codes, and one unknown code must not void the batch.
    if (dimensions.value.length === 0) return ok(EMPTY_PAGE);

    const nodes = await resolveTerritoryNodes(repo, filter);
    if (nodes.isErr()) return err(nodes.error);
    const classPins = await classificationPins(repo, code, dimensions.value, filter, {
      territoryPinned: nodes.value !== null,
    });
    if (classPins.isErr()) return err(classPins.error);
    // TOTAL asked on a dimension without a TOTAL member: nothing matches (D1b).
    if (classPins.value.unpinnable.length > 0) return ok(EMPTY_PAGE);
    const units = await unitPins(repo, code, filter.unitCodes);
    if (units.isErr()) return err(units.error);
    const period = periodPredicates(filter.period);
    if (period.isErr()) return err(period.error);

    const scope = observationGeoScope(dimensions.value, nodes.value, classPins.value.explicitPins);
    if (scope.isErr()) return err(scope.error);
    if (scope.value === null) return ok(EMPTY_PAGE);
    // Non-geographic reads still need a classification or unit bound.
    if (
      scope.value.kind === 'nonGeographic' &&
      classPins.value.pins.size === 0 &&
      units.value === undefined
    ) {
      return err(
        invalidInput(
          'insObservations needs a classification pin or a unit for a non-geographic dataset',
          'filter'
        )
      );
    }
    const pinGroups = [classPins.value.pins];
    const pageLimit = clamp(limit, DEFAULT_OBSERVATION_LIMIT, MAX_OBSERVATION_LIMIT);
    const pageOffset = offsetOf(offset);
    const query: InsFactQuery = {
      datasetCode: code,
      geoScope: scope.value,
      pinGroups,
      ...(units.value !== undefined && { unitNomItemIds: units.value }),
      ...period.value,
      ...(filter.hasValue !== undefined && { hasValue: filter.hasValue }),
      limit: pageLimit,
      offset: pageOffset,
    };
    return repo.listObservations(query);
  });

// ─────────────────────────────────────────────────────────────────────────────
// Default series, latest values, dashboard
// ─────────────────────────────────────────────────────────────────────────────

const prepareDefaultSelections = async (
  repo: InsRepo,
  datasets: readonly InsDatasetView[],
  node: InsTerritoryNode,
  preferredCodes: readonly string[]
): Promise<Result<ReadonlyMap<string, InsDefaultSelection>, ApiError>> => {
  const parsed = preferredCodes.filter((code) => !isTotalAlias(code)).map(parseMemberCode);
  if (parsed.some((id) => id === null))
    return err(
      invalidInput(
        'preferredClassificationCodes must be member codes or TOTAL',
        'preferredClassificationCodes'
      )
    );
  const preferredIds = parsed.filter((id): id is number => id !== null);
  const codes = [...new Set(datasets.map((dataset) => dataset.code))];
  const dimensions = await repo.dimensionsForDatasets(codes);
  if (dimensions.isErr()) return err(dimensions.error);
  const defaults = await repo.defaultPins(codes);
  if (defaults.isErr()) return err(defaults.error);
  const members = await repo.membersForDatasets(
    codes.map((code) => ({
      datasetCode: code,
      nomItemIds: [
        ...new Set([
          ...preferredIds,
          ...defaults.value.filter((pin) => pin.datasetCode === code).map((pin) => pin.nomItemId),
        ]),
      ],
    }))
  );
  if (members.isErr()) return err(members.error);
  const output = new Map<string, InsDefaultSelection>();
  for (const dataset of datasets) {
    const selection = buildDefaultSeries(
      dataset,
      dimensions.value,
      defaults.value,
      members.value,
      preferredIds,
      node
    );
    if (selection.isErr()) return err(selection.error);
    if (selection.value !== null) output.set(dataset.code, selection.value);
  }
  return ok(output);
};

export const resolveEntity = async (
  repo: InsRepo,
  entity: InsEntitySelector
): Promise<Result<InsTerritoryNode, ApiError>> => {
  if (
    (entity.sirutaCode === undefined || entity.sirutaCode === '') &&
    (entity.territoryCode === undefined || entity.territoryCode === '')
  ) {
    return err(invalidInput('entity needs sirutaCode or territoryCode', 'entity'));
  }
  const nodes = await resolveTerritoryNodes(repo, {
    ...(entity.sirutaCode === undefined || entity.sirutaCode === ''
      ? {}
      : { sirutaCodes: [entity.sirutaCode] }),
    ...(entity.territoryCode === undefined || entity.territoryCode === ''
      ? {}
      : { territoryCodes: [entity.territoryCode] }),
    ...(entity.territoryLevel === undefined ? {} : { territoryLevels: [entity.territoryLevel] }),
  });
  if (nodes.isErr()) return err(nodes.error);
  if (
    nodes.value === null ||
    'levels' in nodes.value ||
    nodes.value.length !== 1 ||
    nodes.value[0] === undefined
  ) {
    return err(invalidInput('entity selectors must identify exactly one INS territory', 'entity'));
  }
  return ok(nodes.value[0]);
};

/** `insLatestDatasetValues`: one batched read for every resolvable default series. */
export const listLatestValues = (
  outer: InsRepo,
  entity: InsEntitySelector,
  datasetCodes: readonly string[],
  preferredCodes: readonly string[] = []
): Promise<Result<readonly InsLatestValue[], ApiError>> =>
  outer.withSnapshot((repo) => latestValuesIn(repo, entity, datasetCodes, preferredCodes));

const latestValuesIn = async (
  repo: InsRepo,
  entity: InsEntitySelector,
  datasetCodes: readonly string[],
  preferredCodes: readonly string[]
): Promise<Result<readonly InsLatestValue[], ApiError>> => {
  if (datasetCodes.length === 0) return ok([]);
  if (datasetCodes.length > MAX_BATCH_DATASETS) {
    return err(
      invalidInput(`at most ${String(MAX_BATCH_DATASETS)} datasets per request`, 'datasetCodes')
    );
  }
  const node = await resolveEntity(repo, entity);
  if (node.isErr()) return err(node.error);
  const codes = [...new Set(datasetCodes.map((code) => code.trim().toUpperCase()))];
  const datasets = await repo.getDatasets(codes);
  if (datasets.isErr()) return err(datasets.error);
  const selections = await prepareDefaultSelections(
    repo,
    datasets.value,
    node.value,
    preferredCodes
  );
  if (selections.isErr()) return err(selections.error);
  const rows = await repo.readDefaultSeries(
    [...selections.value.values()].map((selection) => selection.request),
    1
  );
  if (rows.isErr()) return err(rows.error);
  const results = new Map(rows.value.map((result) => [result.seriesKey, result]));
  if (results.size !== selections.value.size)
    return err({ type: 'ServiceUnavailable', message: 'INS series result is unavailable' });
  const output: InsLatestValue[] = [];
  for (const dataset of datasets.value) {
    const selection = selections.value.get(dataset.code);
    const result = selection === undefined ? undefined : results.get(selection.request.key);
    if (selection !== undefined && result === undefined)
      return err({ type: 'ServiceUnavailable', message: 'INS series result is unavailable' });
    const observation = result?.status === 'SERIES' ? result.observations[0] : null;
    if (observation === undefined)
      return err({ type: 'ServiceUnavailable', message: 'INS series result is unavailable' });
    output.push({
      dataset,
      observation,
      witnesses: result?.witnesses ?? [],
      matchStrategy:
        result?.status === 'AMBIGUOUS_GEOGRAPHY'
          ? 'AMBIGUOUS_GEOGRAPHY'
          : observation === null
            ? 'NO_DATA'
            : (selection?.strategy ?? 'TOTAL_FALLBACK'),
    });
  }
  return ok(output);
};

/**
 * `insUatDashboard`: every dataset bound at LAU (optionally under one context),
 * the default series of the given UAT, its most recent rows — batched.
 */
export const uatDashboard = (
  outer: InsRepo,
  sirutaCode: string,
  contextCode: string | undefined,
  period: InsPeriodFilter | undefined
): Promise<Result<readonly InsDashboardGroup[], ApiError>> =>
  outer.withSnapshot((repo) => dashboardIn(repo, sirutaCode, contextCode, period));

const dashboardIn = async (
  repo: InsRepo,
  sirutaCode: string,
  contextCode: string | undefined,
  period: InsPeriodFilter | undefined
): Promise<Result<readonly InsDashboardGroup[], ApiError>> => {
  const node = await resolveEntity(repo, { sirutaCode });
  if (node.isErr()) return err(node.error);
  if (node.value.level !== 'LAU')
    return err(invalidInput('sirutaCode must name a LAU', 'sirutaCode'));
  const bounds = periodPredicates(period);
  if (bounds.isErr()) return err(bounds.error);
  const codes = await repo.datasetsForTerritory(node.value.territoryId, contextCode);
  if (codes.isErr()) return err(codes.error);
  const datasets = await repo.getDatasets(codes.value);
  if (datasets.isErr()) return err(datasets.error);
  const selections = await prepareDefaultSelections(repo, datasets.value, node.value, []);
  if (selections.isErr()) return err(selections.error);
  const requests = [...selections.value.values()].map((selection) => selection.request);
  const results = await repo.readDefaultSeries(
    requests,
    DASHBOARD_ROWS_PER_DATASET + 1,
    bounds.value
  );
  if (results.isErr()) return err(results.error);
  const byKey = new Map(results.value.map((result) => [result.seriesKey, result]));
  if (byKey.size !== selections.value.size)
    return err({ type: 'ServiceUnavailable', message: 'INS series result is unavailable' });
  const output: InsDashboardGroup[] = [];
  for (const dataset of datasets.value) {
    const selection = selections.value.get(dataset.code);
    if (selection === undefined) continue;
    const result = byKey.get(selection.request.key);
    if (result === undefined)
      return err({ type: 'ServiceUnavailable', message: 'INS series result is unavailable' });
    if (result.status === 'NO_DATA') continue;
    output.push({
      dataset,
      status: result.status,
      witnesses: result.witnesses,
      observations: result.observations.slice(0, DASHBOARD_ROWS_PER_DATASET),
      truncated: result.observations.length > DASHBOARD_ROWS_PER_DATASET,
    });
  }
  return ok(output);
};
