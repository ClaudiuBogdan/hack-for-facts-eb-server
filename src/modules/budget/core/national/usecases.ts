/**
 * National budget — the seven read usecases shared by GraphQL and MCP.
 *
 * Each root validates its raw arguments, then computes its complete public
 * payload eagerly inside ONE read-only repeatable-read transaction. Lane
 * preconditions (`expectedSnapshot`, cursor bindings) are checked against the
 * lane token read in that same transaction. A bounded-stale cache may answer a
 * plain request from the last snapshot observed within the probe TTL; explicit
 * preconditions and cursor continuations always bypass it.
 */

import { err, ok, type Result } from 'neverthrow';

import { canonicalJsonStringify } from '@/common/canonical-json/index.js';
import {
  invalidInput,
  notFound,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  validateApprovedRecordsInput,
  validateApprovedSeriesInput,
  validateApprovedTotalsInput,
} from './approved-inputs.js';
import {
  classifyCandidates,
  descriptorGroupKey,
  planApprovedSeries,
  planTotals,
  seriesDescriptorGroups,
  totalsDescriptorGroups,
} from './approved-plan.js';
import {
  projectApprovedSeries,
  projectTotalCell,
  type ApprovedClassification,
} from './approved-projection.js';
import {
  acceptsAuthorityFilter,
  candidateFromStored,
  projectRecord,
  resolveRecordSource,
} from './approved-records.js';
import {
  decodeNationalCursor,
  encodeNationalCursor,
  nationalFilterHash,
  type CursorBinding,
  type CursorSpec,
} from './cursor.js';
import { TOTAL_DEFINITIONS } from './descriptors.js';
import {
  approvedSeriesPeriodsDto,
  authorityDto,
  coverageDto,
  editionRefDto,
  itemDto,
  nationalSeriesDto,
  observationDto,
  occurrenceId,
  recordDto,
  selectionDto,
  totalCellDto,
  type ApprovedRecordConnectionDto,
  type ApprovedSeriesDto,
  type ApprovedTotalsDto,
  type ExecutionMonthDto,
  type ExecutionReleaseIndexDto,
  type NationalCatalogDto,
  type NationalSeriesDto,
  type NationalSeriesResultDto,
  type ObservationConnectionDto,
  type ObservationEdgeDto,
} from './dto.js';
import {
  validateAfter,
  validateExecutionObservationsInput,
  validateExecutionReleasesInput,
  validateExpectedSnapshot,
  validateFirst,
  validateNationalExecutionSeriesInput,
} from './execution-inputs.js';
import {
  basisInterval,
  classifyCoverage,
  projectExecutionSeries,
  summarizeCoverage,
  type ExecutionCoverage,
} from './execution-projection.js';
import {
  observationCursorKeys,
  observationsBinding,
  OBSERVATIONS_CURSOR,
  OBSERVATIONS_ROOT,
  parseObservationAfter,
  parseRecordAfter,
  recordCursorKeys,
  recordsBinding,
  RECORDS_CURSOR,
  RECORDS_ROOT,
} from './paging.js';
import { calendarBounds } from './periods.js';
import {
  DEFAULT_READ_DEADLINE_MS,
  NATIONAL_SERIES_READ_DEADLINE_MS,
  type ApprovedInventory,
  type NationalReadPort,
  type NationalReadTx,
  type NationalResponseCache,
  type ResolvedSelection,
} from './ports.js';
import {
  approvedLaneToken,
  checkExpectedSnapshot,
  executionLaneToken,
  type Lane,
} from './snapshot.js';
import { toWireDataSeries } from './values.js';
import { FORM_FUND, TOTAL_KEYS } from './vocabulary.js';

import type { ApprovedStoredRecord, ExecutionItem, ExecutionLeafRow } from './models.js';

export interface NationalUsecaseDeps {
  readonly port: NationalReadPort;
  readonly cache?: NationalResponseCache;
}

/** Raw root arguments, exactly as GraphQL/MCP received them (validated here). */
export interface NationalRootArgs {
  readonly input?: unknown;
  readonly expectedSnapshot?: unknown;
}

export interface NationalPagedArgs extends NationalRootArgs {
  readonly first?: unknown;
  readonly after?: unknown;
}

type Outcome<T> = Promise<Result<T, ApiError>>;

const NO_CANDIDATES: ReadonlyMap<string, readonly ApprovedStoredRecord[]> = new Map();

// ── bounded-stale cache ──────────────────────────────────────────────────────

interface CachePlan<T> {
  readonly lanes: readonly Lane[];
  readonly root: string;
  /** Canonical validated arguments (units, page size included). */
  readonly key: unknown;
  /** Explicit snapshot precondition or cursor continuation: never use a probe. */
  readonly bypass: boolean;
  /**
   * A cursor continuation (`after` set): its response is never stored — it can
   * never be looked up — but its observed snapshot still updates the probe. A
   * passed `expectedSnapshot` first page is stored like a plain request.
   */
  readonly continuation?: boolean;
  readonly snapshots: (value: T) => readonly string[];
}

const withCache = async <T>(
  cache: NationalResponseCache | undefined,
  plan: CachePlan<T>,
  compute: () => Outcome<T>
): Outcome<T> => {
  const base =
    cache === undefined
      ? null
      : canonicalJsonStringify({ root: plan.root, key: plan.key }).unwrapOr(null);
  if (cache !== undefined && base !== null && !plan.bypass) {
    const probes = plan.lanes.map((lane) => cache.probe(lane));
    if (probes.every((probe) => probe !== undefined)) {
      const hit = cache.get(`${base}|${probes.join('|')}`);
      if (hit !== undefined) return ok(hit as T);
    }
  }
  // Freshness starts when the read is requested, before the snapshot is taken.
  const stamp = cache?.begin();
  const result = await compute();
  if (result.isOk() && cache !== undefined && stamp !== undefined && base !== null) {
    const snapshots = plan.snapshots(result.value);
    if (snapshots.length === plan.lanes.length) {
      if (plan.continuation !== true) {
        cache.set(`${base}|${snapshots.join('|')}`, result.value, stamp);
      }
      plan.lanes.forEach((lane, index) => {
        const snapshot = snapshots[index];
        if (snapshot !== undefined) cache.remember(lane, snapshot, stamp);
      });
    }
  }
  return result;
};

// ── shared reads ─────────────────────────────────────────────────────────────

interface ApprovedLane {
  readonly inventory: ApprovedInventory;
  readonly snapshot: string;
}

const readApprovedLane = async (
  tx: NationalReadTx,
  expected: string | null
): Outcome<ApprovedLane> => {
  const inventory = await tx.approved.inventory();
  if (inventory.isErr()) return err(inventory.error);
  const snapshot = approvedLaneToken(inventory.value.snapshotRows);
  if (snapshot.isErr()) return err(snapshot.error);
  const precondition = checkExpectedSnapshot(expected, snapshot.value);
  if (precondition.isErr()) return err(precondition.error);
  return ok({ inventory: inventory.value, snapshot: snapshot.value });
};

interface ExecutionLane {
  readonly leaves: readonly ExecutionLeafRow[];
  readonly snapshot: string;
}

const readExecutionLane = async (
  tx: NationalReadTx,
  expected: string | null
): Outcome<ExecutionLane> => {
  const leaves = await tx.execution.currentLeaves();
  if (leaves.isErr()) return err(leaves.error);
  const snapshot = executionLaneToken(
    leaves.value.map((leaf) => ({ periodEnd: leaf.periodEnd, selectionId: leaf.selectionId }))
  );
  if (snapshot.isErr()) return err(snapshot.error);
  const precondition = checkExpectedSnapshot(expected, snapshot.value);
  if (precondition.isErr()) return err(precondition.error);
  return ok({ leaves: leaves.value, snapshot: snapshot.value });
};

const coverageOf = (leaves: readonly ExecutionLeafRow[]): Result<ExecutionCoverage, ApiError> =>
  summarizeCoverage(leaves.map((leaf) => leaf.month));

const monthEnd = (label: string): string => calendarBounds('MONTH', label)?.end ?? '';

const knownItems = (
  items: readonly ExecutionItem[],
  requested: readonly string[]
): Result<ReadonlyMap<string, ExecutionItem>, ApiError> => {
  const byId = new Map(items.map((item) => [item.itemId, item]));
  const unknown = requested.filter((itemId) => !byId.has(itemId));
  return unknown.length > 0
    ? err(invalidInput(`unknown item IDs: ${unknown.join(', ')}`, 'input.itemIds'))
    : ok(byId);
};

interface PageArgs {
  readonly first: number;
  readonly after: string | null;
  readonly expected: string | null;
}

const validatePageArgs = (args: NationalPagedArgs): Result<PageArgs, ApiError> => {
  const first = validateFirst(args.first);
  if (first.isErr()) return err(first.error);
  const after = validateAfter(args.after);
  if (after.isErr()) return err(after.error);
  const expected = validateExpectedSnapshot(args.expectedSnapshot);
  if (expected.isErr()) return err(expected.error);
  return ok({ first: first.value, after: after.value, expected: expected.value });
};

const decodeAfter = (
  after: string | null,
  binding: CursorBinding,
  spec: CursorSpec,
  fhash: string
): Result<readonly string[] | null, ApiError> =>
  after === null ? ok(null) : decodeNationalCursor(after, binding, spec, fhash);

// ── budgetNationalCatalog ────────────────────────────────────────────────────

export const budgetNationalCatalog = (deps: NationalUsecaseDeps): Outcome<NationalCatalogDto> =>
  withCache(
    deps.cache,
    {
      lanes: ['APPROVED', 'EXECUTION'],
      root: 'budgetNationalCatalog',
      key: {},
      bypass: false,
      snapshots: (value) => [value.snapshots.approved, value.snapshots.execution],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const approved = await readApprovedLane(tx, null);
          if (approved.isErr()) return err(approved.error);
          const execution = await readExecutionLane(tx, null);
          if (execution.isErr()) return err(execution.error);
          const coverage = coverageOf(execution.value.leaves);
          if (coverage.isErr()) return err(coverage.error);
          const items = await tx.execution.catalogItems();
          if (items.isErr()) return err(items.error);
          const { inventory } = approved.value;
          return ok({
            snapshots: { approved: approved.value.snapshot, execution: execution.value.snapshot },
            approved: {
              editions: inventory.editions.map((entry) => ({
                ...editionRefDto(entry.edition),
                slots: entry.slots.map((slot) => ({
                  field: slot.field,
                  measure: slot.measure,
                  measureYear: slot.measureYear,
                  lineCount: entry.slotLineCounts.get(slot.field) ?? 0,
                })),
                forms: entry.forms.map((form) => ({
                  form: form.form,
                  fund: FORM_FUND[form.form],
                  interpretationIds: [...form.interpretationIds],
                  sources: form.sources.map((source) => ({
                    sourceFileId: source.sourceFileId,
                    document: {
                      url: source.document.url,
                      sha256: source.document.sha256,
                      bytes: source.document.bytes,
                    },
                  })),
                  recordCount: form.recordCount,
                  lineCount: form.lineCount,
                  creditTypes: [...form.creditTypes],
                  authorityCount: form.authorityCount,
                })),
                lineCount: entry.lineCount,
                hasConflictingInterpretations: entry.hasConflictingInterpretations,
              })),
              totals: TOTAL_KEYS.map((key) => {
                const definition = TOTAL_DEFINITIONS[key];
                return {
                  key: definition.key,
                  scope: definition.scope,
                  forms: [...definition.forms],
                  rowRole: definition.rowRole,
                  capitol: definition.capitol,
                  label: definition.label,
                  requiresCreditType: definition.requiresCreditType,
                  description: definition.description,
                };
              }),
              unrecognized: inventory.unrecognized.map((group) => ({
                budgetYear: group.budgetYear,
                publication: group.publication,
                fund: group.fund,
                form: group.form,
                lineCount: group.lineCount,
              })),
            },
            execution: {
              coverage: coverageDto(coverage.value),
              seriesItems: items.value.map(itemDto),
            },
          });
        },
        { deadlineMs: DEFAULT_READ_DEADLINE_MS, operation: 'budgetNationalCatalog' }
      )
  );

// ── budgetApprovedTotals ─────────────────────────────────────────────────────

export const budgetApprovedTotals = async (
  deps: NationalUsecaseDeps,
  args: NationalRootArgs
): Outcome<ApprovedTotalsDto> => {
  const query = validateApprovedTotalsInput(args.input);
  if (query.isErr()) return err(query.error);
  const expected = validateExpectedSnapshot(args.expectedSnapshot);
  if (expected.isErr()) return err(expected.error);
  return withCache(
    deps.cache,
    {
      lanes: ['APPROVED'],
      root: 'budgetApprovedTotals',
      key: query.value,
      bypass: expected.value !== null,
      snapshots: (value) => [value.snapshot],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const lane = await readApprovedLane(tx, expected.value);
          if (lane.isErr()) return err(lane.error);
          const plan = planTotals(query.value, lane.value.inventory.editions);
          if (plan.isErr()) return err(plan.error);
          const groups = totalsDescriptorGroups(plan.value);
          const candidates =
            groups.length === 0
              ? ok(NO_CANDIDATES)
              : await tx.approved.descriptorCandidates(groups);
          if (candidates.isErr()) return err(candidates.error);
          const cells = [];
          for (const cell of plan.value.cells) {
            const stored = candidates.value.get(
              descriptorGroupKey({
                editionId: cell.edition.id,
                form: cell.form,
                total: cell.total,
                creditType: cell.creditType,
                authorityCode: cell.authorityCode,
              })
            );
            const classification = cell.formLoaded
              ? classifyCandidates((stored ?? []).map(candidateFromStored), cell)
              : null;
            const projected = projectTotalCell(cell, classification, query.value.unit);
            if (projected.isErr()) return err(projected.error);
            cells.push(totalCellDto(projected.value));
          }
          return ok({
            snapshot: lane.value.snapshot,
            cells,
            unloadedEditionIds: [...plan.value.unloadedEditionIds],
            missingAuthorities: plan.value.missingAuthorities.map((missing) => ({
              editionId: missing.editionId,
              code: missing.code,
            })),
          });
        },
        { deadlineMs: DEFAULT_READ_DEADLINE_MS, operation: 'budgetApprovedTotals' }
      )
  );
};

// ── budgetApprovedSeries ─────────────────────────────────────────────────────

export const budgetApprovedSeries = async (
  deps: NationalUsecaseDeps,
  args: NationalRootArgs
): Outcome<ApprovedSeriesDto> => {
  const query = validateApprovedSeriesInput(args.input);
  if (query.isErr()) return err(query.error);
  const expected = validateExpectedSnapshot(args.expectedSnapshot);
  if (expected.isErr()) return err(expected.error);
  const q = query.value;
  return withCache(
    deps.cache,
    {
      lanes: ['APPROVED'],
      root: 'budgetApprovedSeries',
      key: q,
      bypass: expected.value !== null,
      snapshots: (value) => [value.snapshot],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const lane = await readApprovedLane(tx, expected.value);
          if (lane.isErr()) return err(lane.error);
          const editions = lane.value.inventory.editions;
          const plans = planApprovedSeries(q, editions);
          const groups = seriesDescriptorGroups(q, plans);
          const candidates =
            groups.length === 0
              ? ok(NO_CANDIDATES)
              : await tx.approved.descriptorCandidates(groups);
          if (candidates.isErr()) return err(candidates.error);
          const classifications = new Map<string, ApprovedClassification>();
          for (const plan of plans) {
            if (plan.kind !== 'READ') continue;
            const stored = candidates.value.get(
              descriptorGroupKey({
                editionId: plan.edition.id,
                form: plan.form,
                total: q.total,
                creditType: q.creditType,
                authorityCode: q.authorityCode,
              })
            );
            classifications.set(
              plan.date,
              classifyCandidates((stored ?? []).map(candidateFromStored), plan)
            );
          }
          const projection = projectApprovedSeries(q, plans, classifications);
          if (projection.isErr()) return err(projection.error);
          const axis = q.axis;
          const fixed =
            axis.kind === 'TARGET_YEARS_OF_EDITION'
              ? editions.find((entry) => entry.edition.id === axis.edition.id)
              : undefined;
          const named =
            fixed === undefined || q.authorityCode === null
              ? []
              : fixed.authorities.filter((authority) => authority.code === q.authorityCode);
          const [onlyAuthority] = named;
          return ok({
            snapshot: lane.value.snapshot,
            axis: q.axis.kind,
            fund: q.fund,
            total: q.total,
            creditType: q.creditType,
            // One printed name for the code in this edition, or no authority claim.
            authority:
              named.length === 1 && onlyAuthority !== undefined
                ? authorityDto(onlyAuthority)
                : null,
            edition: fixed === undefined ? null : editionRefDto(fixed.edition),
            targetYear: q.axis.kind === 'EDITIONS_FOR_TARGET' ? q.axis.targetYear : null,
            unit: projection.value.unit,
            series: toWireDataSeries(projection.value.series),
            periods: approvedSeriesPeriodsDto(projection.value),
          });
        },
        { deadlineMs: DEFAULT_READ_DEADLINE_MS, operation: 'budgetApprovedSeries' }
      )
  );
};

// ── budgetApprovedRecords ────────────────────────────────────────────────────

export const budgetApprovedRecords = async (
  deps: NationalUsecaseDeps,
  args: NationalPagedArgs
): Outcome<ApprovedRecordConnectionDto> => {
  const query = validateApprovedRecordsInput(args.input);
  if (query.isErr()) return err(query.error);
  const page = validatePageArgs(args);
  if (page.isErr()) return err(page.error);
  const { first, after, expected } = page.value;
  return withCache(
    deps.cache,
    {
      lanes: ['APPROVED'],
      root: RECORDS_ROOT,
      key: { query: query.value, first, after },
      bypass: expected !== null || after !== null,
      continuation: after !== null,
      snapshots: (value) => [value.snapshot],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const lane = await readApprovedLane(tx, expected);
          if (lane.isErr()) return err(lane.error);
          const resolved = resolveRecordSource(query.value.source, lane.value.inventory.editions);
          if (resolved === null) {
            return err(notFound('approved record source is not loaded', 'input.source'));
          }
          if (query.value.authorityCode !== null && !acceptsAuthorityFilter(resolved.form)) {
            return err(
              invalidInput(
                'input.authorityCode applies only to STATE_BUDGET_AUTHORITY_DETAIL records',
                'input.authorityCode'
              )
            );
          }
          const binding = recordsBinding(query.value, lane.value.snapshot);
          if (binding.isErr()) return err(binding.error);
          const fhash = nationalFilterHash(RECORDS_ROOT, query.value);
          if (fhash.isErr()) return err(fhash.error);
          const keys = decodeAfter(after, binding.value, RECORDS_CURSOR, fhash.value);
          if (keys.isErr()) return err(keys.error);
          const afterKeys = keys.value === null ? ok(null) : parseRecordAfter(keys.value);
          if (afterKeys.isErr()) return err(afterKeys.error);
          const rows = await tx.approved.records({
            query: query.value,
            interpretationIds: resolved.interpretationIds,
            after: afterKeys.value,
            limit: first + 1,
          });
          if (rows.isErr()) return err(rows.error);
          const edges = rows.value.slice(0, first).map((stored) => {
            const record = projectRecord(stored, resolved.slots);
            return {
              node: recordDto(record),
              cursor: encodeNationalCursor(
                binding.value,
                RECORDS_CURSOR,
                fhash.value,
                recordCursorKeys(record)
              ),
            };
          });
          return ok({
            snapshot: lane.value.snapshot,
            unit: 'THOUSAND_LEI' as const,
            edges,
            pageInfo: {
              hasNextPage: rows.value.length > first,
              endCursor: edges.at(-1)?.cursor ?? null,
            },
          });
        },
        { deadlineMs: DEFAULT_READ_DEADLINE_MS, operation: RECORDS_ROOT }
      )
  );
};

// ── budgetExecutionReleases ──────────────────────────────────────────────────

export const budgetExecutionReleases = async (
  deps: NationalUsecaseDeps,
  args: NationalRootArgs
): Outcome<ExecutionReleaseIndexDto> => {
  const query = validateExecutionReleasesInput(args.input);
  if (query.isErr()) return err(query.error);
  const expected = validateExpectedSnapshot(args.expectedSnapshot);
  if (expected.isErr()) return err(expected.error);
  return withCache(
    deps.cache,
    {
      lanes: ['EXECUTION'],
      root: 'budgetExecutionReleases',
      key: query.value,
      bypass: expected.value !== null,
      snapshots: (value) => [value.snapshot],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const lane = await readExecutionLane(tx, expected.value);
          if (lane.isErr()) return err(lane.error);
          const coverage = coverageOf(lane.value.leaves);
          if (coverage.isErr()) return err(coverage.error);
          const labels = query.value.months.labels;
          const chains = await tx.execution.releaseChains(
            labels.map(monthEnd),
            query.value.revisionsPerMonth
          );
          if (chains.isErr()) return err(chains.error);
          const byMonth = new Map(chains.value.map((chain) => [chain.month, chain]));
          const months: ExecutionMonthDto[] = [];
          for (const month of labels) {
            const chain = byMonth.get(month);
            if (chain === undefined) {
              months.push({
                month,
                status: 'NO_SELECTED_RELEASE',
                gapReason: null,
                current: null,
                revisionCount: 0,
                revisions: [],
                revisionsTruncated: false,
              });
              continue;
            }
            const [current] = chain.newest;
            if (current?.chainPosition !== chain.length || chain.newest.length > chain.length) {
              return err(
                serviceUnavailable(`execution selection chain is inconsistent for ${month}`)
              );
            }
            months.push({
              month,
              status: 'SELECTED',
              gapReason: null,
              current: selectionDto(current),
              revisionCount: chain.length,
              revisions: chain.newest.map(selectionDto),
              revisionsTruncated: chain.length > chain.newest.length,
            });
          }
          return ok({
            snapshot: lane.value.snapshot,
            coverage: coverageDto(coverage.value),
            months,
          });
        },
        { deadlineMs: DEFAULT_READ_DEADLINE_MS, operation: 'budgetExecutionReleases' }
      )
  );
};

// ── budgetExecutionObservations ──────────────────────────────────────────────

export const budgetExecutionObservations = async (
  deps: NationalUsecaseDeps,
  args: NationalPagedArgs
): Outcome<ObservationConnectionDto> => {
  const query = validateExecutionObservationsInput(args.input);
  if (query.isErr()) return err(query.error);
  const page = validatePageArgs(args);
  if (page.isErr()) return err(page.error);
  const { first, after, expected } = page.value;
  const q = query.value;
  return withCache(
    deps.cache,
    {
      lanes: ['EXECUTION'],
      root: OBSERVATIONS_ROOT,
      key: { query: q, first, after },
      bypass: expected !== null || after !== null,
      continuation: after !== null,
      snapshots: (value) => [value.snapshot],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const lane = await readExecutionLane(tx, expected);
          if (lane.isErr()) return err(lane.error);
          let selections: readonly ResolvedSelection[];
          if (q.source.kind === 'MONTHS') {
            const ends = new Set(q.source.months.labels.map(monthEnd));
            selections = lane.value.leaves
              .filter((leaf) => ends.has(leaf.periodEnd))
              .map((leaf) => ({
                selectionId: leaf.selectionId,
                periodEnd: leaf.periodEnd,
                releaseId: leaf.releaseId,
              }));
          } else {
            const found = await tx.execution.selections(q.source.selectionIds);
            if (found.isErr()) return err(found.error);
            const known = new Set(found.value.map((selection) => selection.selectionId));
            const unknown = q.source.selectionIds.filter((id) => !known.has(id));
            if (unknown.length > 0) {
              return err(
                notFound(
                  `unknown selection IDs: ${unknown.join(', ')}`,
                  'input.source.selectionIds'
                )
              );
            }
            selections = found.value;
          }
          if (q.requiresSingleSelection && selections.length !== 1) {
            return err(
              invalidInput(
                `BLANK, UNRESOLVED and NONFINANCIAL need exactly one resolved selection; the source resolved to ${String(selections.length)}`,
                'input.dispositions'
              )
            );
          }
          if (q.itemIds !== null) {
            const items = await tx.execution.catalogItems();
            if (items.isErr()) return err(items.error);
            const known = knownItems(items.value, q.itemIds);
            if (known.isErr()) return err(known.error);
          }
          const binding = observationsBinding(q, lane.value.snapshot);
          if (binding.isErr()) return err(binding.error);
          const fhash = nationalFilterHash(OBSERVATIONS_ROOT, q);
          if (fhash.isErr()) return err(fhash.error);
          const keys = decodeAfter(after, binding.value, OBSERVATIONS_CURSOR, fhash.value);
          if (keys.isErr()) return err(keys.error);
          const afterKeys = keys.value === null ? ok(null) : parseObservationAfter(keys.value);
          if (afterKeys.isErr()) return err(afterKeys.error);
          const rows =
            selections.length === 0
              ? ok([])
              : await tx.execution.observations({
                  query: q,
                  selections,
                  singleSelection: selections.length === 1,
                  after: afterKeys.value,
                  limit: first + 1,
                });
          if (rows.isErr()) return err(rows.error);
          const edges: ObservationEdgeDto[] = rows.value.slice(0, first).map((occurrence) => ({
            cursor: encodeNationalCursor(
              binding.value,
              OBSERVATIONS_CURSOR,
              fhash.value,
              observationCursorKeys(occurrence)
            ),
            occurrenceId: occurrenceId(occurrence),
            selectionId: occurrence.selectionId,
            node: observationDto(occurrence.node),
          }));
          return ok({
            snapshot: lane.value.snapshot,
            edges,
            pageInfo: {
              hasNextPage: rows.value.length > first,
              endCursor: edges.at(-1)?.cursor ?? null,
            },
          });
        },
        { deadlineMs: DEFAULT_READ_DEADLINE_MS, operation: OBSERVATIONS_ROOT }
      )
  );
};

// ── budgetNationalExecutionSeries ────────────────────────────────────────────

export const budgetNationalExecutionSeries = async (
  deps: NationalUsecaseDeps,
  args: NationalRootArgs
): Outcome<NationalSeriesResultDto> => {
  const query = validateNationalExecutionSeriesInput(args.input);
  if (query.isErr()) return err(query.error);
  const expected = validateExpectedSnapshot(args.expectedSnapshot);
  if (expected.isErr()) return err(expected.error);
  const q = query.value;
  return withCache(
    deps.cache,
    {
      lanes: ['EXECUTION'],
      root: 'budgetNationalExecutionSeries',
      // Item order is part of the key: the result array keeps the caller order.
      key: q,
      bypass: expected.value !== null,
      snapshots: (value) => [value.snapshot],
    },
    () =>
      deps.port.read(
        async (tx) => {
          const lane = await readExecutionLane(tx, expected.value);
          if (lane.isErr()) return err(lane.error);
          const coverage = coverageOf(lane.value.leaves);
          if (coverage.isErr()) return err(coverage.error);
          const items = await tx.execution.catalogItems();
          if (items.isErr()) return err(items.error);
          const known = knownItems(items.value, q.itemIds);
          if (known.isErr()) return err(known.error);
          const mappingVersions = new Set(
            q.itemIds.map((itemId) => known.value.get(itemId)?.mappingVersion ?? '')
          );
          const [mappingVersion] = mappingVersions;
          if (mappingVersions.size !== 1 || mappingVersion === undefined) {
            return err(serviceUnavailable('requested items carry different mapping versions'));
          }
          const inside = q.period.labels.filter((label) => {
            const interval = basisInterval(q.period.type, q.basis, label);
            return (
              interval !== null &&
              classifyCoverage(interval.endpointMonth, coverage.value) === 'INSIDE'
            );
          });
          const rows = await tx.execution.seriesRows({
            itemIds: q.itemIds,
            basis: q.basis,
            type: q.period.type,
            labels: inside,
          });
          if (rows.isErr()) return err(rows.error);
          const results: NationalSeriesDto[] = [];
          for (const itemId of q.itemIds) {
            const item = known.value.get(itemId);
            if (item === undefined)
              return err(invalidInput(`unknown item ID ${itemId}`, 'input.itemIds'));
            const projection = projectExecutionSeries(
              itemId,
              q.basis,
              q.period,
              coverage.value,
              rows.value.rows.filter((row) => row.itemId === itemId)
            );
            if (projection.isErr()) return err(projection.error);
            results.push(nationalSeriesDto(item, rows.value.component, projection.value));
          }
          return ok({
            snapshot: lane.value.snapshot,
            mappingVersion,
            derivationVersion: rows.value.derivationVersion,
            coverage: coverageDto(coverage.value),
            results,
          });
        },
        { deadlineMs: NATIONAL_SERIES_READ_DEADLINE_MS, operation: 'budgetNationalExecutionSeries' }
      )
  );
};
