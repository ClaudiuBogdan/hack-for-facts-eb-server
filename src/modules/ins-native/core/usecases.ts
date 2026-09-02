/**
 * INS native module — usecases (pure orchestration over the repository port).
 *
 * Every public identifier is resolved HERE, before the repository sees a fact
 * query: territory tokens → spine nodes → the dataset's bound members (and the
 * TOTAL members of the territorial dimensions the node is above); `D<n>` +
 * member codes → slot pins; the `TOTAL` alias → the dimension's TOTAL member;
 * the default-series registry → the pins a tile needs. Unresolvable input is an
 * `InvalidInput` (never a 23 M-row scan) or a `NO_DATA` (never an arbitrary
 * row).
 */

import { err, ok, type Result } from 'neverthrow';

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

import type { InsRepo, InsTerritoryBinding } from './ports.js';
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
): Promise<Result<readonly InsTerritoryNode[] | null, ApiError>> => {
  const wantsSiruta = filter.sirutaCodes !== undefined && filter.sirutaCodes.length > 0;
  const wantsCodes = filter.territoryCodes !== undefined && filter.territoryCodes.length > 0;
  const levels = filter.territoryLevels;
  if (!wantsSiruta && !wantsCodes) {
    // Levels alone (e.g. NATIONAL) select every node of those levels.
    if (levels === undefined || levels.length === 0) return ok(null);
    const nodes = await repo.listTerritories({ levels }, MAX_TERRITORY_LIMIT, 0);
    return nodes.isErr() ? err(nodes.error) : ok(nodes.value.nodes);
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

/**
 * The slot pins one spine node implies in one dataset: for every territorial
 * dimension of the dataset, the member bound to the node or to one of its
 * ancestors; for a dimension whose grain is BELOW the node (e.g. the locality
 * dimension when the node is a county), the dimension's TOTAL member. A node
 * with no binding in any dimension, or a node below every bound grain, has no
 * series in this dataset → null.
 */
export const territoryPinsFor = (
  node: InsTerritoryNode,
  ancestors: readonly InsTerritoryNode[],
  bindings: readonly InsTerritoryBinding[]
): SlotPins | null => {
  const chain = [node, ...ancestors];
  const chainIds = new Map(chain.map((n) => [n.territoryId, n]));
  const byDim = new Map<number, InsTerritoryBinding[]>();
  for (const b of bindings) {
    const list = byDim.get(b.dimIndex) ?? [];
    list.push(b);
    byDim.set(b.dimIndex, list);
  }
  if (byDim.size === 0) return null;
  const nodeDepth = TERRITORY_LEVEL_DEPTH[node.level];
  const depthOf = (level: InsTerritoryLevel | null): number =>
    level === null ? -1 : TERRITORY_LEVEL_DEPTH[level];
  // The finest grain any territorial dimension of the dataset binds: a node
  // deeper than that has no row of its own (a locality in a county-only
  // dataset must never be answered with its county's value).
  let finestGrain = -1;
  for (const [, dimBindings] of byDim) {
    for (const b of dimBindings) finestGrain = Math.max(finestGrain, depthOf(b.territoryLevel));
  }
  if (nodeDepth > finestGrain) return null;

  const pins = new Map<number, readonly number[]>();
  let boundToChain = false;
  for (const [, dimBindings] of byDim) {
    const onChain = dimBindings
      .filter((b) => b.territoryId !== null && chainIds.has(b.territoryId))
      .sort((a, b) => depthOf(b.territoryLevel) - depthOf(a.territoryLevel));
    const best = onChain[0];
    if (best !== undefined) {
      // The deepest chain node bound in this dimension (the node itself over its ancestors).
      pins.set(best.slotIndex, [best.nomItemId]);
      boundToChain = true;
      continue;
    }
    // The dimension binds nodes at some grain; if that grain is below the node,
    // the node's row is the dimension's TOTAL member.
    const dimGrain = Math.max(...dimBindings.map((b) => depthOf(b.territoryLevel)));
    const total = dimBindings.find((b) => b.resolution === 'TOTAL_MEMBER');
    if (dimGrain > nodeDepth && total !== undefined) {
      pins.set(total.slotIndex, [total.nomItemId]);
      continue;
    }
    // A dimension the node cannot be expressed in: no series.
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
 * A code that belongs to no dimension is an `InvalidInput`; a dimension with no
 * TOTAL when TOTAL was asked yields no pin for it (the caller treats an
 * unpinned dimension per its own rule).
 */
export const classificationPins = async (
  repo: InsRepo,
  datasetCode: string,
  dimensions: readonly InsDimensionView[],
  filter: Pick<InsObservationFilter, 'classificationTypeCodes' | 'classificationValueCodes'>,
  options: { readonly territoryPinned?: boolean } = {}
): Promise<Result<SlotPins, ApiError>> => {
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
  if (wantsTotal) {
    for (const dimIndex of dimsForTotal) {
      const slot = bySlotOfDim.get(dimIndex);
      if (slot === undefined) continue;
      const total = await repo.totalMember(datasetCode, dimIndex);
      if (total.isErr()) return err(total.error);
      if (total.value === null) continue;
      pins.set(slot, [...(pins.get(slot) ?? []), total.value]);
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
  return ok(pins);
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
    // `dates` selects EXACTLY those periods (the legacy semantics), never the span between them.
    const ranges: { start: string; end: string }[] = [];
    for (const token of period.tokens) {
      const b = periodTokenBounds(token);
      if (b === null) return err(invalidInput(`invalid period token ${token}`, 'period'));
      ranges.push({ start: b.start, end: b.end });
    }
    out.periodRanges = ranges;
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

const mergePins = (base: SlotPins, extra: SlotPins): SlotPins => {
  const out = new Map<number, readonly number[]>(base);
  for (const [slot, ids] of extra) {
    const existing = out.get(slot);
    // A territory pin and a classification pin on the same slot intersect.
    out.set(slot, existing === undefined ? ids : ids.filter((id) => existing.includes(id)));
  }
  return out;
};

/**
 * `insObservations`: dataset mandatory; territory and classification pins are
 * resolved to physical predicates; the repository reads limit+1 rows.
 * An empty resolved territory set (every requested code unknown) is an empty
 * page, not an error — the legacy surface behaved the same.
 */
export const listObservations = async (
  repo: InsRepo,
  datasetCode: string,
  filter: InsObservationFilter,
  limit?: number,
  offset?: number
): Promise<Result<InsPage<InsObservationView>, ApiError>> => {
  const code = datasetCode.trim().toUpperCase();
  const dimensions = await repo.listDimensions(code);
  if (dimensions.isErr()) return err(dimensions.error);
  // An unknown dataset is an EMPTY page, not an error: the entity page sends
  // aliased batches of literal codes, and one unknown code must not void the batch.
  if (dimensions.value.length === 0) {
    return ok({ nodes: [], totalCount: 0, hasNextPage: false, hasPreviousPage: false });
  }

  const nodes = await resolveTerritoryNodes(repo, filter);
  if (nodes.isErr()) return err(nodes.error);
  const classPins = await classificationPins(repo, code, dimensions.value, filter, {
    territoryPinned: nodes.value !== null,
  });
  if (classPins.isErr()) return err(classPins.error);
  const units = await unitPins(repo, code, filter.unitCodes);
  if (units.isErr()) return err(units.error);
  const period = periodPredicates(filter.period);
  if (period.isErr()) return err(period.error);

  let pinGroups: readonly SlotPins[];
  if (nodes.value === null) {
    pinGroups = [classPins.value];
  } else {
    const groups = await territoryPinGroups(repo, code, nodes.value);
    if (groups.isErr()) return err(groups.error);
    pinGroups = groups.value.map((g) => mergePins(g.pins, classPins.value));
    if (pinGroups.length === 0) {
      return ok({ nodes: [], totalCount: 0, hasNextPage: false, hasPreviousPage: false });
    }
  }
  const pageLimit = clamp(limit, DEFAULT_OBSERVATION_LIMIT, MAX_OBSERVATION_LIMIT);
  const pageOffset = offsetOf(offset);
  const query: InsFactQuery = {
    datasetCode: code,
    pinGroups,
    ...(units.value !== undefined && { unitNomItemIds: units.value }),
    ...period.value,
    ...(filter.hasValue !== undefined && { hasValue: filter.hasValue }),
    limit: pageLimit,
    offset: pageOffset,
  };
  return repo.listObservations(query);
};

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
    for (const [slot, ids] of group.pins) {
      const id = ids[0];
      if (id === undefined) return ok(null);
      slots[slot - 1] = id;
      const dim = classification.find((d) => d.slotIndex === slot);
      if (dim !== undefined) pinnedDims.add(dim.dimIndex);
    }
  } else {
    // National scope on a territorial dataset: every territorial dimension at its TOTAL member.
    const bindings = await repo.territoryBindings(dataset.code, []);
    if (bindings.isErr()) return err(bindings.error);
    for (const b of bindings.value) {
      if (b.resolution === 'TOTAL_MEMBER' && !pinnedDims.has(b.dimIndex)) {
        slots[b.slotIndex - 1] = b.nomItemId;
        pinnedDims.add(b.dimIndex);
      }
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
export const listLatestValues = async (
  repo: InsRepo,
  entity: InsEntitySelector,
  datasetCodes: readonly string[],
  preferredCodes: readonly string[] = []
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

/** Does a period satisfy the resolved predicates (span bounds and/or explicit ranges)? */
export const periodMatches = (
  period: { readonly periodStart: string; readonly periodEnd: string },
  p: PeriodPredicates
): boolean => {
  if (p.periodStart !== undefined && period.periodEnd < p.periodStart) return false;
  if (p.periodEnd !== undefined && period.periodStart > p.periodEnd) return false;
  if (p.periodRanges !== undefined && p.periodRanges.length > 0) {
    return p.periodRanges.some((r) => period.periodEnd >= r.start && period.periodStart <= r.end);
  }
  return true;
};

/**
 * `insUatDashboard`: every dataset bound at LAU (optionally under one context),
 * the default series of the given UAT, its most recent rows — batched.
 */
export const uatDashboard = async (
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
  const rows =
    specs.length === 0 ? ok([]) : await repo.latestForSeries(specs, DASHBOARD_ROWS_PER_DATASET + 1);
  if (rows.isErr()) return err(rows.error);
  const grouped = new Map<string, InsObservationView[]>();
  for (const r of rows.value) {
    if (!periodMatches(r.observation.period, bounds.value)) continue;
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
