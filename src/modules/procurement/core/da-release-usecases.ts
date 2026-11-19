/**
 * Direct acquisitions, release 1 — usecases shared by GraphQL, REST and MCP.
 *
 * Each call opens exactly one repository snapshot and reads `dataAsOf` in it
 * first; every answer carries that `dataAsOf`. Unfiltered totals change only
 * when the nightly publish moves `dataAsOf` (rows and `data_as_of` are written
 * in one transaction), so they are cached per `dataAsOf`.
 */

import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  invalidInput,
  MAX_PAGE_SIZE,
  notFound,
  offsetFor,
  serviceUnavailable,
  type ApiError,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import {
  DA_LIST_SORTS,
  DA_OUTCOMES,
  DA_TOTALS_GROUPS,
  DA_COUNTED_VALUE_BASIS,
  toItem,
  toPurchase,
  toTotals,
  toTotalsGroup,
  type DaItem,
  type DaListSort,
  type DaPurchase,
  type DaTotals,
  type DaTotalsGroup,
} from './da-release.js';

import type {
  DaPurchaseFilter,
  DaReleaseReader,
  DaReleaseRepo,
  DaTotalsRecords,
} from './da-release-ports.js';

/** The deepest row a list page may reach; a page may start below it and is clamped to it. Lists count up to it. */
export const DA_LIST_MAX_DEPTH = 10_000;

export interface DaTotalsCache {
  get(key: string): DaTotalsAnswer | undefined;
  set(key: string, value: DaTotalsAnswer): void;
}

export interface DaReleaseDeps {
  readonly repo: DaReleaseRepo;
  /** Site-wide D6: reported in the status so clients key caches by the privacy publication. */
  readonly supplierDisclosure?: SupplierDisclosurePort;
  /** Cache for unfiltered totals, keyed by dataAsOf and the request shape. */
  readonly totalsCache?: DaTotalsCache;
}

export interface DaEnvelope {
  readonly dataAsOf: string;
  readonly countedValueBasis: typeof DA_COUNTED_VALUE_BASIS;
}

export interface DaReleaseStatus {
  /** True when the server reads the release and it holds data; choose the v3 path from this. */
  readonly enabled: boolean;
  readonly dataAsOf: string | null;
  /** Site-wide D6 is enforced (its own switch, independent of `enabled`). */
  readonly privacyEnforced: boolean;
  /**
   * The supplier_privacy publication in force; null when D6 is off or its source is
   * absent (then every DA supplier is withheld). Key caches by (dataAsOf, privacyAsOf).
   */
  readonly privacyAsOf: string | null;
}

export interface DaPurchasePage extends DaEnvelope {
  readonly items: readonly DaPurchase[];
  readonly page: number;
  readonly pageSize: number;
  /** Exact unless `totalCapped`, then a lower bound (DA_LIST_MAX_DEPTH). */
  readonly total: number;
  readonly totalCapped: boolean;
  readonly hasMore: boolean;
}

export interface DaPurchaseDetail extends DaEnvelope {
  readonly purchase: DaPurchase;
  /** In item_index order; values as reported, never summed. */
  readonly items: readonly DaItem[];
}

export interface DaTotalsAnswer extends DaEnvelope {
  readonly groupBy: (typeof DA_TOTALS_GROUPS)[number] | null;
  /** The whole filtered scope. */
  readonly overall: DaTotals;
  /** Empty when `groupBy` is null. Buyer/supplier/CPV groups by counted value; month/year by key. */
  readonly groups: readonly DaTotalsGroup[];
  readonly page: number;
  readonly pageSize: number;
  readonly groupCount: number;
  readonly hasMore: boolean;
}

// ── Input ────────────────────────────────────────────────────────────────────

const ISO_DAY = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });

/** The one filter schema every surface validates against. */
export const DaPurchaseFilterSchema = Type.Object(
  {
    buyerFiscalCode: Type.Optional(Type.String({ pattern: '^[0-9]{1,10}$' })),
    supplierFiscalCode: Type.Optional(Type.String({ pattern: '^[0-9]{1,10}$' })),
    cpvDivision: Type.Optional(Type.String({ pattern: '^[0-9]{2}$' })),
    finalizationFrom: Type.Optional(ISO_DAY),
    finalizationTo: Type.Optional(ISO_DAY),
    outcomes: Type.Optional(
      Type.Array(Type.Union(DA_OUTCOMES.map((value) => Type.Literal(value))), {
        minItems: 1,
        maxItems: DA_OUTCOMES.length,
      })
    ),
    counted: Type.Optional(Type.Boolean()),
    code: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9]{1,40}$' })),
    nativeId: Type.Optional(Type.String({ pattern: '^[0-9A-Za-z-]{1,40}$' })),
  },
  { additionalProperties: false }
);
export type DaPurchaseFilterInput = Static<typeof DaPurchaseFilterSchema>;

const PURCHASE_ID = /^[0-9a-f]{64}$/u;

const isCalendarDay = (day: string): boolean => {
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};

export const validateDaFilter = (raw: unknown): Result<DaPurchaseFilter, ApiError> => {
  const input = raw ?? {};
  if (!Value.Check(DaPurchaseFilterSchema, input)) {
    const fault = Value.Errors(DaPurchaseFilterSchema, input).First();
    const field = fault?.path.split('/')[1] ?? 'filter';
    return err(invalidInput(`Invalid ${field}.`, field));
  }
  for (const field of ['finalizationFrom', 'finalizationTo'] as const) {
    const day = input[field];
    if (day !== undefined && !isCalendarDay(day))
      return err(invalidInput(`Invalid ${field}.`, field));
  }
  if (
    input.finalizationFrom !== undefined &&
    input.finalizationTo !== undefined &&
    input.finalizationFrom > input.finalizationTo
  )
    return err(invalidInput('finalizationFrom is after finalizationTo', 'finalizationFrom'));
  return ok(input);
};

const checkPage = (page: number, pageSize: number, maxDepth: number | null): ApiError | null => {
  if (!Number.isSafeInteger(page) || page < 1)
    return invalidInput('page must be an integer >= 1', 'page');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    return invalidInput(
      `pageSize must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`,
      'pageSize'
    );
  // A page may START at any row below maxDepth; the repo clamps its last rows to maxDepth.
  const offset = offsetFor({ page, pageSize });
  if (!Number.isSafeInteger(offset + pageSize) || (maxDepth !== null && offset >= maxDepth))
    return invalidInput(
      maxDepth !== null
        ? `page reaches beyond row ${String(maxDepth)}; narrow the filter`
        : 'page is beyond the largest safe offset',
      'page'
    );
  return null;
};

const isEmptyFilter = (filter: DaPurchaseFilter): boolean =>
  Object.values(filter).every((value) => value === undefined);

// ── Reads ────────────────────────────────────────────────────────────────────

const disabled = (): ApiError =>
  serviceUnavailable('Direct acquisitions release 1 is not enabled on this server.');

/** Open the request's one snapshot and read its dataAsOf first. */
const inSnapshot = async <T>(
  deps: DaReleaseDeps,
  read: (reader: DaReleaseReader, envelope: DaEnvelope) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> => {
  if (!deps.repo.enabled) return err(disabled());
  return deps.repo.snapshot(async (reader) => {
    const asOf = await reader.dataAsOf();
    if (asOf.isErr()) return err(asOf.error);
    if (asOf.value === null)
      return err(serviceUnavailable('Direct acquisitions release 1 holds no data yet.'));
    return read(reader, { dataAsOf: asOf.value, countedValueBasis: DA_COUNTED_VALUE_BASIS });
  });
};

const mapAll = <R, V>(
  records: readonly R[],
  map: (record: R) => Result<V, ApiError>
): Result<V[], ApiError> => {
  const out: V[] = [];
  for (const record of records) {
    const mapped = map(record);
    if (mapped.isErr()) return err(mapped.error);
    out.push(mapped.value);
  }
  return ok(out);
};

export const daReleaseStatus = async (deps: DaReleaseDeps): Promise<DaReleaseStatus> => {
  const disclosure = deps.supplierDisclosure;
  const privacyEnforced = disclosure?.enforced === true;
  const release = deps.repo.enabled
    ? await inSnapshot(deps, (_reader, envelope) => Promise.resolve(ok(envelope)))
    : null;
  // The privacy key is read LAST, after every other wait: a value read before a
  // slow snapshot could reach the client after a later request already returned a
  // newer one, rolling its cache key back to a publication that names a supplier
  // the newer one withholds. The port never serves an older one than it has served.
  const privacy =
    disclosure !== undefined && privacyEnforced ? await disclosure.privacyAsOf() : undefined;
  const privacyAsOf = privacy?.isOk() === true ? privacy.value : null;
  return release?.isOk() === true
    ? { enabled: true, dataAsOf: release.value.dataAsOf, privacyEnforced, privacyAsOf }
    : { enabled: false, dataAsOf: null, privacyEnforced, privacyAsOf };
};

export const listDaPurchases = async (
  deps: DaReleaseDeps,
  request: { filter?: unknown; sort?: string | null; page: number; pageSize: number }
): Promise<Result<DaPurchasePage, ApiError>> => {
  const filter = validateDaFilter(request.filter);
  if (filter.isErr()) return err(filter.error);
  const sort = request.sort ?? 'finalizationDesc';
  if (!(DA_LIST_SORTS as readonly string[]).includes(sort))
    return err(invalidInput('Invalid sort.', 'sort'));
  const fault = checkPage(request.page, request.pageSize, DA_LIST_MAX_DEPTH);
  if (fault !== null) return err(fault);
  return inSnapshot(deps, async (reader, envelope) => {
    const records = await reader.listPurchases({
      filter: filter.value,
      sort: sort as DaListSort,
      page: request.page,
      pageSize: request.pageSize,
    });
    if (records.isErr()) return err(records.error);
    const items = mapAll(records.value.rows, (row) => toPurchase(row));
    if (items.isErr()) return err(items.error);
    const reached = offsetFor(request) + items.value.length;
    return ok({
      ...envelope,
      items: items.value,
      page: request.page,
      pageSize: request.pageSize,
      total: records.value.total,
      totalCapped: records.value.capped,
      // A capped total is DA_LIST_MAX_DEPTH, the last row a page may reach.
      hasMore: reached < records.value.total,
    });
  });
};

export const getDaPurchase = async (
  deps: DaReleaseDeps,
  purchaseId: string
): Promise<Result<DaPurchaseDetail, ApiError>> => {
  if (!PURCHASE_ID.test(purchaseId))
    return err(invalidInput('purchaseId must be 64 lowercase hex characters', 'purchaseId'));
  return inSnapshot(deps, async (reader, envelope) => {
    const record = await reader.purchaseById(purchaseId);
    if (record.isErr()) return err(record.error);
    if (record.value === null) return err(notFound('Direct acquisition not found.', 'purchase'));
    const purchase = toPurchase(record.value);
    if (purchase.isErr()) return err(purchase.error);
    const itemRecords = await reader.itemsOf(purchaseId);
    if (itemRecords.isErr()) return err(itemRecords.error);
    const items = mapAll(itemRecords.value, toItem);
    if (items.isErr()) return err(items.error);
    return ok({ ...envelope, purchase: purchase.value, items: items.value });
  });
};

const isGroup = (value: string): value is (typeof DA_TOTALS_GROUPS)[number] =>
  (DA_TOTALS_GROUPS as readonly string[]).includes(value);

const toAnswer = (
  records: DaTotalsRecords,
  request: { groupBy: (typeof DA_TOTALS_GROUPS)[number] | null; page: number; pageSize: number },
  envelope: DaEnvelope
): Result<DaTotalsAnswer, ApiError> => {
  const overall = toTotals(records.overall);
  if (overall.isErr()) return err(overall.error);
  const groupBy = request.groupBy;
  const groups =
    groupBy === null ? ok([]) : mapAll(records.groups, (group) => toTotalsGroup(group, groupBy));
  if (groups.isErr()) return err(groups.error);
  return ok({
    ...envelope,
    groupBy,
    overall: overall.value,
    groups: groups.value,
    page: request.page,
    pageSize: request.pageSize,
    groupCount: records.groupCount,
    hasMore: offsetFor(request) + groups.value.length < records.groupCount,
  });
};

export const daPurchaseTotals = async (
  deps: DaReleaseDeps,
  request: { filter?: unknown; groupBy?: string | null; page: number; pageSize: number }
): Promise<Result<DaTotalsAnswer, ApiError>> => {
  const filter = validateDaFilter(request.filter);
  if (filter.isErr()) return err(filter.error);
  const rawGroup = request.groupBy ?? null;
  if (rawGroup !== null && !isGroup(rawGroup))
    return err(invalidInput('Invalid groupBy.', 'groupBy'));
  const groupBy = rawGroup;
  const fault = checkPage(request.page, request.pageSize, null);
  if (fault !== null) return err(fault);
  const shape = { groupBy, page: request.page, pageSize: request.pageSize };
  const cache = isEmptyFilter(filter.value) ? deps.totalsCache : undefined;

  return inSnapshot(deps, async (reader, envelope) => {
    const key = `${envelope.dataAsOf}|${String(reader.supplierPrivacyTable())}|${groupBy ?? ''}|${String(shape.page)}|${String(shape.pageSize)}`;
    const hit = cache?.get(key);
    if (hit !== undefined) return ok(hit);
    const records = await reader.totals({ filter: filter.value, ...shape });
    if (records.isErr()) return err(records.error);
    const answer = toAnswer(records.value, shape, envelope);
    if (answer.isOk()) cache?.set(key, answer.value);
    return answer;
  });
};

/** A small in-process cache: entries for an older dataAsOf are dropped when a newer one arrives. */
export const makeDaTotalsCache = (maxEntries = 256): DaTotalsCache => {
  const entries = new Map<string, DaTotalsAnswer>();
  let asOf: string | null = null;
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      if (value.dataAsOf !== asOf) {
        entries.clear();
        asOf = value.dataAsOf;
      }
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) entries.delete(oldest.value);
      }
      entries.set(key, value);
    },
  };
};
