/**
 * Contract awards (PROC-KB0Z step 1): the usecases REST and GraphQL share. A
 * buyer's counts, a buyer's records (newest award first, oldest first or by
 * amount) and one record's detail, each in one snapshot. No lei sum (see
 * `ca-records.ts`).
 */

import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  notFound,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  CA_FLOOR_DAY,
  CA_LIST_MAX_DEPTH,
  CA_LIST_SORTS,
  CA_MAX_PAGE_SIZE,
  isBeforeFloor,
  isPublicCode,
  parseCaRecordId,
  toCaBuyer,
  toCaLot,
  toCaRecord,
  type CaBuyer,
  type CaKey,
  type CaListSort,
  type CaLot,
  type CaRecord,
  type CaRecordRow,
} from './ca-records.js';

import type { CaCounts, CaRecordsReader, CaRecordsRepo, CaWindow } from './ca-records-ports.js';

export interface CaRecordsDeps {
  readonly repo: CaRecordsRepo;
}

export interface CaEnvelope {
  /** `da_release.data_as_of` of the snapshot. */
  readonly dataAsOf: string;
  /** The key a client caches winner names under: dataAsOf, or `unavailable` without the names view. */
  readonly disclosureKey: string;
}

export interface CaWindowAnswer {
  /** The published window's first award day; `from` is never before it. */
  readonly floor: string;
  readonly from: string;
  readonly to: string | null;
}

export interface CaBuyerSummary extends CaEnvelope, CaCounts {
  readonly window: CaWindowAnswer;
  readonly buyer: CaBuyer;
}

export interface CaRecordPage extends CaEnvelope {
  readonly window: CaWindowAnswer;
  readonly items: readonly CaRecord[];
  readonly page: number;
  readonly pageSize: number;
  /** The records in the window (exact). */
  readonly total: number;
  readonly hasMore: boolean;
  /** More records than a list may reach (row 10000): narrow the window to see the rest. */
  readonly depthLimited: boolean;
}

export interface CaRecordDetail extends CaEnvelope {
  readonly record: CaRecord;
  readonly lots: readonly CaLot[];
  /** True when the id asked for was issued by an earlier build and resolved through the keys view. */
  readonly reanchored: boolean;
}

/** The refusal for a record before the floor: it is loaded, but outside the published window. */
export const OUTSIDE_WINDOW_RESOURCE = 'contractAwardOutsideWindow';

const disabled = (): ApiError =>
  serviceUnavailable('Contract awards are not enabled on this server.');

const contractBreak = (what: string): ApiError =>
  databaseError(`Contract-award ${what} breaks the serving contract; response refused.`);

const BUYER_CODE = /^[1-9][0-9]{1,9}$/u;

const isCalendarDay = (day: string): boolean => {
  // Years 1900-2999 only: PostgreSQL has no year 0, and no award is older.
  if (!/^(19|2[0-9])[0-9]{2}-[0-9]{2}-[0-9]{2}$/u.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
};

/** A buyer code as digits: an `RO` prefix and leading zeros are not accepted (the views key plain codes). */
const validateBuyerCode = (code: unknown): Result<string, ApiError> =>
  typeof code === 'string' && BUYER_CODE.test(code)
    ? ok(code)
    : err(
        invalidInput(
          'buyerFiscalCode must be a fiscal code: 2-10 digits, no leading zero',
          'buyerFiscalCode'
        )
      );

/** The window asked for, its start raised to the floor. */
export const validateCaWindow = (
  from: string | null | undefined,
  to: string | null | undefined
): Result<CaWindow, ApiError> => {
  for (const [field, day] of [
    ['from', from],
    ['to', to],
  ] as const)
    if (day !== null && day !== undefined && !isCalendarDay(day))
      return err(invalidInput(`${field} must be a calendar day (YYYY-MM-DD)`, field));
  const start = from === null || from === undefined || from < CA_FLOOR_DAY ? CA_FLOOR_DAY : from;
  const end = to ?? null;
  if (from !== null && from !== undefined && end !== null && from > end)
    return err(invalidInput('from is after to', 'from'));
  return ok({ from: start, to: end });
};

const windowAnswer = (window: CaWindow): CaWindowAnswer => ({
  floor: CA_FLOOR_DAY,
  from: window.from,
  to: window.to,
});

const inSnapshot = async <T>(
  deps: CaRecordsDeps,
  read: (reader: CaRecordsReader, envelope: CaEnvelope) => Promise<Result<T, ApiError>>
): Promise<Result<T, ApiError>> => {
  if (!deps.repo.enabled) return err(disabled());
  return deps.repo.snapshot(async (reader) => {
    const asOf = await reader.dataAsOf();
    if (asOf.isErr()) return err(asOf.error);
    if (asOf.value === null) return err(serviceUnavailable('Contract awards hold no data yet.'));
    return read(reader, {
      dataAsOf: asOf.value,
      disclosureKey: reader.namesReadable() ? asOf.value : 'unavailable',
    });
  });
};

/** Rows of these keys with their winners and buyers' public names, mapped. */
const recordsOf = async (
  reader: CaRecordsReader,
  rows: readonly CaRecordRow[]
): Promise<Result<CaRecord[], ApiError>> => {
  if (rows.length === 0) return ok([]);
  const winners = await reader.winnersByKeys(rows);
  if (winners.isErr()) return err(winners.error);
  // Only a buyer the view says is not a person, with a public code's shape, is named by code.
  const named = [
    ...new Set(
      rows.flatMap((row) =>
        row.buyerPerson === false && row.buyerCode !== null && isPublicCode(row.buyerCode)
          ? [row.buyerCode]
          : []
      )
    ),
  ];
  const names =
    named.length === 0 ? ok(new Map<string, string>()) : await reader.buyerRegistryNames(named);
  if (names.isErr()) return err(names.error);
  const records: CaRecord[] = [];
  for (const row of rows) {
    const own = winners.value.filter(
      (winner) => winner.sourceName === row.sourceName && winner.matchId === row.matchId
    );
    const buyer =
      row.buyerCode === null
        ? null
        : {
            code: row.buyerCode,
            person: row.buyerPerson,
            maskedName: row.buyerNameMasked,
            registryName: names.value.get(row.buyerCode) ?? null,
          };
    const record = toCaRecord(row, buyer, own);
    if (record.isErr()) return err(record.error);
    records.push(record.value);
  }
  return ok(records);
};

const checkPage = (page: number, pageSize: number): ApiError | null => {
  if (!Number.isSafeInteger(page) || page < 1)
    return invalidInput('page must be an integer >= 1', 'page');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > CA_MAX_PAGE_SIZE)
    return invalidInput(
      `pageSize must be an integer from 1 to ${String(CA_MAX_PAGE_SIZE)}`,
      'pageSize'
    );
  if ((page - 1) * pageSize >= CA_LIST_MAX_DEPTH)
    return invalidInput(
      `page reaches beyond row ${String(CA_LIST_MAX_DEPTH)}; narrow the window`,
      'page'
    );
  return null;
};

export const caBuyerSummary = async (
  deps: CaRecordsDeps,
  request: { buyerFiscalCode: unknown; from?: string | null; to?: string | null }
): Promise<Result<CaBuyerSummary, ApiError>> => {
  const code = validateBuyerCode(request.buyerFiscalCode);
  if (code.isErr()) return err(code.error);
  const window = validateCaWindow(request.from, request.to);
  if (window.isErr()) return err(window.error);
  return inSnapshot(deps, async (reader, envelope) => {
    const counts = await reader.buyerCounts(code.value, window.value);
    if (counts.isErr()) return err(counts.error);
    const probe = await reader.buyerProbe(code.value);
    if (probe.isErr()) return err(probe.error);
    const person = probe.value?.person ?? null;
    const names =
      person === false
        ? await reader.buyerRegistryNames([code.value])
        : ok(new Map<string, string>());
    if (names.isErr()) return err(names.error);
    const buyer = toCaBuyer(
      {
        code: code.value,
        person,
        maskedName: probe.value?.maskedName ?? null,
        registryName: person === false ? (names.value.get(code.value) ?? null) : null,
      },
      // The place is a record's; the summary does not read one.
      { countyCode: null, siruta: null, region: null }
    );
    return ok({ ...envelope, ...counts.value, window: windowAnswer(window.value), buyer });
  });
};

export const listCaBuyerRecords = async (
  deps: CaRecordsDeps,
  request: {
    buyerFiscalCode: unknown;
    from?: string | null;
    to?: string | null;
    sort?: string | null;
    page: number;
    pageSize: number;
  }
): Promise<Result<CaRecordPage, ApiError>> => {
  const code = validateBuyerCode(request.buyerFiscalCode);
  if (code.isErr()) return err(code.error);
  const window = validateCaWindow(request.from, request.to);
  if (window.isErr()) return err(window.error);
  const sort = request.sort ?? 'awardDayDesc';
  if (!(CA_LIST_SORTS as readonly string[]).includes(sort))
    return err(invalidInput('Invalid sort.', 'sort'));
  const fault = checkPage(request.page, request.pageSize);
  if (fault !== null) return err(fault);
  const offset = (request.page - 1) * request.pageSize;
  const limit = Math.min(request.pageSize, CA_LIST_MAX_DEPTH - offset);
  return inSnapshot(deps, async (reader, envelope) => {
    const counts = await reader.buyerCounts(code.value, window.value);
    if (counts.isErr()) return err(counts.error);
    const keys = await reader.buyerKeys({
      buyerCode: code.value,
      window: window.value,
      sort: sort as CaListSort,
      offset,
      limit,
    });
    if (keys.isErr()) return err(keys.error);
    const rows = keys.value.length === 0 ? ok([]) : await reader.recordsByKeys(keys.value);
    if (rows.isErr()) return err(rows.error);
    // Every key the keys step read has its row in the same snapshot.
    if (rows.value.length !== keys.value.length) return err(contractBreak('key without a row'));
    const items = await recordsOf(reader, rows.value);
    if (items.isErr()) return err(items.error);
    const total = counts.value.recordCount;
    return ok({
      ...envelope,
      window: windowAnswer(window.value),
      items: items.value,
      page: request.page,
      pageSize: request.pageSize,
      total,
      hasMore: offset + items.value.length < Math.min(total, CA_LIST_MAX_DEPTH),
      depthLimited: total > CA_LIST_MAX_DEPTH,
    });
  });
};

export const getCaRecord = async (
  deps: CaRecordsDeps,
  recordId: unknown
): Promise<Result<CaRecordDetail, ApiError>> => {
  const parsed = typeof recordId === 'string' ? parseCaRecordId(recordId) : null;
  if (parsed === null)
    return err(
      invalidInput('recordId must be <source>:ca:<publication id>:<contract id>', 'recordId')
    );
  return inSnapshot(deps, async (reader, envelope) => {
    let key: CaKey = { sourceName: parsed.sourceName, matchId: parsed.matchId };
    let rows = await reader.recordsByKeys([key]);
    if (rows.isErr()) return err(rows.error);
    let reanchored = false;
    if (rows.value.length === 0) {
      // An id from an earlier build: its appearance's identity under today's key.
      const current = await reader.currentKeyOf(parsed);
      if (current.isErr()) return err(current.error);
      if (current.value === null || current.value.matchId === parsed.matchId)
        return err(notFound('Contract award not found.', 'contractAward'));
      key = current.value;
      reanchored = true;
      rows = await reader.recordsByKeys([key]);
      if (rows.isErr()) return err(rows.error);
    }
    const row = rows.value[0];
    if (row === undefined) return err(notFound('Contract award not found.', 'contractAward'));
    // The floor first: nothing more of a record outside the window is read.
    if (isBeforeFloor(row.awardDay))
      return err(
        notFound(
          `Contract award is outside the published window (award day from ${CA_FLOOR_DAY}).`,
          OUTSIDE_WINDOW_RESOURCE
        )
      );
    const records = await recordsOf(reader, [row]);
    if (records.isErr()) return err(records.error);
    const record = records.value[0];
    if (record === undefined) return err(contractBreak('record'));
    const lotRows = await reader.lotsOf(key);
    if (lotRows.isErr()) return err(lotRows.error);
    if (lotRows.value.length !== row.lotCount) return err(contractBreak('lot count'));
    const lots: CaLot[] = [];
    for (const lotRow of lotRows.value) {
      const lot = toCaLot(lotRow);
      if (lot.isErr()) return err(lot.error);
      lots.push(lot.value);
    }
    return ok({ ...envelope, record, lots, reanchored });
  });
};
