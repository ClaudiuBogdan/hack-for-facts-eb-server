/**
 * Public identifiers resolve to typed repository inputs here. Observation lists
 * use complete source coordinates or explicit modern geographic scopes; numeric
 * classification members and TOTAL resolve separately and intersect that scope.
 * Default-series geography still uses the transitional binding helpers below,
 * pending the next prerequisite before native INS is enabled.
 */

import { err, ok, type Result } from 'neverthrow';

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
  TERRITORY_LEVEL_DEPTH,
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
  type InsSeriesSpec,
  type InsTerritoryLevel,
  type InsTerritoryFilter,
  type InsTerritoryNode,
  type SlotPins,
} from './types.js';

import type { InsRepo, InsTerritoryBinding, InsTerritoryDimension } from './ports.js';
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

const depthOf = (level: InsTerritoryLevel | null): number =>
  level === null ? -1 : TERRITORY_LEVEL_DEPTH[level];

/**
 * The slot pins one spine node implies in one dataset: for every territorial
 * dimension, the member bound to the node or to one of its ancestors (the
 * deepest wins); for a dimension whose members are all BELOW the node (the
 * locality dimension when the node is a county), the dimension's TOTAL member.
 * A node deeper than every grain the dataset binds (a locality in a
 * county-only dataset), or a node bound in no dimension, has no series → null:
 * a node is never answered with an ancestor's row.
 */
export const territoryPinsFor = (
  node: InsTerritoryNode,
  ancestors: readonly InsTerritoryNode[],
  dims: readonly InsTerritoryDimension[],
  bindings: readonly InsTerritoryBinding[]
): SlotPins | null => {
  if (dims.length === 0) return null;
  const chainIds = new Set([node, ...ancestors].map((n) => n.territoryId));
  const nodeDepth = TERRITORY_LEVEL_DEPTH[node.level];
  const finestGrain = Math.max(...dims.flatMap((d) => d.levels.map(depthOf)));
  if (nodeDepth > finestGrain) return null;

  const pins = new Map<number, readonly number[]>();
  let boundToChain = false;
  for (const dim of dims) {
    const onChain = bindings
      .filter((b) => b.dimIndex === dim.dimIndex && chainIds.has(b.territoryId))
      .sort((a, b) => depthOf(b.territoryLevel) - depthOf(a.territoryLevel));
    const best = onChain[0];
    if (best !== undefined) {
      pins.set(dim.slotIndex, [best.nomItemId]);
      boundToChain = true;
      continue;
    }
    const dimGrain = Math.max(...dim.levels.map(depthOf));
    if (dimGrain > nodeDepth && dim.totalNomItemId !== null) {
      pins.set(dim.slotIndex, [dim.totalNomItemId]);
      continue;
    }
    return null;
  }
  return boundToChain || node.level === 'NATIONAL' ? pins : null;
};

/** One AND-group per node, OR-ed by the repository. Nodes without a series are dropped. */
export const territoryPinGroups = async (
  repo: InsRepo,
  datasetCode: string,
  nodes: readonly InsTerritoryNode[]
): Promise<Result<readonly { node: InsTerritoryNode; pins: SlotPins }[], ApiError>> => {
  const dims = await repo.territoryDimensions(datasetCode);
  if (dims.isErr()) return err(dims.error);
  const ancestorsByNode = new Map<number, readonly InsTerritoryNode[]>();
  const allIds = new Set<number>();
  for (const node of nodes) {
    const ancestors = await repo.ancestorsOf(node.territoryId);
    if (ancestors.isErr()) return err(ancestors.error);
    ancestorsByNode.set(node.territoryId, ancestors.value);
    allIds.add(node.territoryId);
    for (const a of ancestors.value) allIds.add(a.territoryId);
  }
  const bindings = await repo.territoryBindings(datasetCode, [...allIds]);
  if (bindings.isErr()) return err(bindings.error);
  const groups: { node: InsTerritoryNode; pins: SlotPins }[] = [];
  for (const node of nodes) {
    const pins = territoryPinsFor(
      node,
      ancestorsByNode.get(node.territoryId) ?? [],
      dims.value,
      bindings.value
    );
    if (pins !== null) groups.push({ node, pins });
  }
  return ok(groups);
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

/**
 * Build the fully pinned series of a dataset for one territory node: territory
 * pins + the default-series registry for every remaining classification
 * dimension + the unit; `preferred` member codes override the registry on the
 * dimension they belong to. Returns null (NO_DATA) when any classification
 * dimension or the unit stays unpinned (decision D2).
 */
export const defaultSeriesFor = async (
  repo: InsRepo,
  dataset: InsDatasetView,
  dimensions: readonly InsDimensionView[],
  node: InsTerritoryNode | null,
  preferredCodes: readonly string[]
): Promise<
  Result<
    { spec: InsSeriesSpec; strategy: 'PREFERRED_CLASSIFICATION' | 'TOTAL_FALLBACK' } | null,
    ApiError
  >
> => {
  if (dataset.publicationStatus === 'NOT_LOADED') return ok(null);
  if (dataset.dataStatus !== 'AVAILABLE') {
    return err({ type: 'ServiceUnavailable', message: 'INS dataset publication is unavailable' });
  }
  const classification = slotted(dimensions);
  const unitDim = dimensions.find((d) => d.role === 'unit');
  if (unitDim === undefined) return ok(null);

  const slots: (number | null)[] = Array.from({ length: 7 }, () => null);
  const pinnedDims = new Set<number>();

  if (node !== null) {
    const groups = await territoryPinGroups(repo, dataset.code, [node]);
    if (groups.isErr()) return err(groups.error);
    const group = groups.value[0];
    if (group === undefined) return ok(null);
    for (const [slot, pred] of group.pins) {
      const id = pred[0];
      if (id === undefined) return ok(null);
      slots[slot - 1] = id;
      const dim = classification.find((d) => d.slotIndex === slot);
      if (dim !== undefined) pinnedDims.add(dim.dimIndex);
    }
  } else {
    // National scope on a territorial dataset: every territorial dimension at
    // its TOTAL member; a territorial dimension without one has no national row.
    const dims = await repo.territoryDimensions(dataset.code);
    if (dims.isErr()) return err(dims.error);
    for (const dim of dims.value) {
      if (dim.totalNomItemId === null) return ok(null);
      slots[dim.slotIndex - 1] = dim.totalNomItemId;
      pinnedDims.add(dim.dimIndex);
    }
  }

  let strategy: 'PREFERRED_CLASSIFICATION' | 'TOTAL_FALLBACK' = 'TOTAL_FALLBACK';
  const preferred = preferredCodes.filter((c) => !isTotalAlias(c)).map(parseMemberCode);
  if (preferred.some((p) => p === null)) {
    return err(
      invalidInput(
        'preferredClassificationCodes must be member codes or TOTAL',
        'preferredClassificationCodes'
      )
    );
  }
  if (preferred.length > 0) {
    const members = await repo.membersByIds(dataset.code, preferred as number[]);
    if (members.isErr()) return err(members.error);
    for (const m of members.value) {
      const dim = classification.find((d) => d.dimIndex === m.dimIndex);
      if (dim === undefined || pinnedDims.has(dim.dimIndex)) continue;
      slots[dim.slotIndex - 1] = m.nomItemId;
      pinnedDims.add(dim.dimIndex);
      strategy = 'PREFERRED_CLASSIFICATION';
    }
  }

  const defaults = await repo.defaultPins([dataset.code]);
  if (defaults.isErr()) return err(defaults.error);
  let unitNomItemId: number | null = null;
  for (const pin of defaults.value) {
    if (pin.dimIndex === unitDim.dimIndex) {
      unitNomItemId = pin.nomItemId;
      continue;
    }
    const dim = classification.find((d) => d.dimIndex === pin.dimIndex);
    if (dim === undefined || pinnedDims.has(dim.dimIndex)) continue;
    slots[dim.slotIndex - 1] = pin.nomItemId;
    pinnedDims.add(dim.dimIndex);
  }

  if (unitNomItemId === null) return ok(null);
  if (classification.some((d) => !pinnedDims.has(d.dimIndex))) return ok(null);
  const key = `${dataset.code}|${node === null ? 'RO' : String(node.territoryId)}`;
  return ok({ spec: { key, datasetCode: dataset.code, slots, unitNomItemId }, strategy });
};

const resolveEntity = async (
  repo: InsRepo,
  entity: InsEntitySelector
): Promise<Result<InsTerritoryNode | null, ApiError>> => {
  if (entity.sirutaCode !== undefined && entity.sirutaCode !== '') {
    const nodes = await repo.territoriesBySiruta([entity.sirutaCode]);
    if (nodes.isErr()) return err(nodes.error);
    return nodes.value[0] === undefined
      ? err(invalidInput(`unknown SIRUTA code ${entity.sirutaCode}`, 'entity.sirutaCode'))
      : ok(nodes.value[0]);
  }
  if (entity.territoryCode !== undefined && entity.territoryCode !== '') {
    const levels = entity.territoryLevel !== undefined ? [entity.territoryLevel] : undefined;
    const nodes = await repo.territoriesByCodes([entity.territoryCode], levels);
    if (nodes.isErr()) return err(nodes.error);
    const node = nodes.value[0];
    if (node === undefined) {
      return err(
        invalidInput(`unknown territory code ${entity.territoryCode}`, 'entity.territoryCode')
      );
    }
    return ok(node.level === 'NATIONAL' ? null : node);
  }
  return err(invalidInput('entity needs sirutaCode or territoryCode', 'entity'));
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
  const codes = datasetCodes.map((c) => c.trim().toUpperCase());
  const datasets = await repo.getDatasets(codes);
  if (datasets.isErr()) return err(datasets.error);
  const byCode = new Map(datasets.value.map((d) => [d.code, d]));

  const specs: InsSeriesSpec[] = [];
  const strategies = new Map<string, 'PREFERRED_CLASSIFICATION' | 'TOTAL_FALLBACK'>();
  for (const code of codes) {
    const dataset = byCode.get(code);
    if (dataset === undefined) continue;
    const dimensions = await repo.listDimensions(code);
    if (dimensions.isErr()) return err(dimensions.error);
    const series = await defaultSeriesFor(
      repo,
      dataset,
      dimensions.value,
      node.value,
      preferredCodes
    );
    if (series.isErr()) return err(series.error);
    if (series.value === null) continue;
    specs.push(series.value.spec);
    strategies.set(code, series.value.strategy);
  }
  const rows = specs.length === 0 ? ok([]) : await repo.latestForSeries(specs, 1);
  if (rows.isErr()) return err(rows.error);
  const latestByCode = new Map(
    rows.value.map((r) => [r.observation.coordinate.datasetCode, r.observation])
  );

  return ok(
    codes.flatMap((code) => {
      const dataset = byCode.get(code);
      if (dataset === undefined) return [];
      const observation = latestByCode.get(code) ?? null;
      return [
        {
          dataset,
          observation,
          matchStrategy:
            observation === null ? 'NO_DATA' : (strategies.get(code) ?? 'TOTAL_FALLBACK'),
        },
      ];
    })
  );
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
  if (node.value === null) return err(invalidInput('sirutaCode must name a LAU', 'sirutaCode'));
  const bounds = periodPredicates(period);
  if (bounds.isErr()) return err(bounds.error);
  const lauCodes = await repo.datasetsWithLevel('LAU');
  if (lauCodes.isErr()) return err(lauCodes.error);
  const datasets = await repo.getDatasets(lauCodes.value);
  if (datasets.isErr()) return err(datasets.error);
  const selected = datasets.value.filter(
    (d) =>
      d.dataStatus === 'AVAILABLE' &&
      (contextCode === undefined ||
        d.contextCode === contextCode ||
        (d.contextPath ?? '').includes(contextCode))
  );
  const specs: InsSeriesSpec[] = [];
  const byKey = new Map<string, InsDatasetView>();
  for (const dataset of selected) {
    const dimensions = await repo.listDimensions(dataset.code);
    if (dimensions.isErr()) return err(dimensions.error);
    const series = await defaultSeriesFor(repo, dataset, dimensions.value, node.value, []);
    if (series.isErr()) return err(series.error);
    if (series.value === null) continue;
    specs.push(series.value.spec);
    byKey.set(series.value.spec.key, dataset);
  }
  // The period narrows INSIDE the batched read (a period older than the newest
  // rows must still be found), never after the per-series limit.
  const rows =
    specs.length === 0
      ? ok([])
      : await repo.latestForSeries(specs, DASHBOARD_ROWS_PER_DATASET + 1, bounds.value);
  if (rows.isErr()) return err(rows.error);
  const grouped = new Map<string, InsObservationView[]>();
  for (const r of rows.value) {
    const list = grouped.get(r.seriesKey) ?? [];
    list.push(r.observation);
    grouped.set(r.seriesKey, list);
  }
  const out: InsDashboardGroup[] = [];
  for (const [key, dataset] of byKey) {
    const observations = grouped.get(key) ?? [];
    if (observations.length === 0) continue;
    out.push({
      dataset,
      observations: observations.slice(0, DASHBOARD_ROWS_PER_DATASET),
      truncated: observations.length > DASHBOARD_ROWS_PER_DATASET,
    });
  }
  return ok(out);
};
