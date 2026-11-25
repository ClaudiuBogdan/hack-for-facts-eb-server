/**
 * Contract awards (PROC-KB0Z step 1): SQL over the data platform's four
 * security-barrier views (`procurement_v3.ca_records_public`,
 * `ca_record_winners_public`, `ca_record_lots_public`, `ca_record_keys_public`;
 * scrapper 20261124T120040). Read-only; nothing here writes.
 *
 * Read shape (procurement-prod's reader rule 1, mandatory): a list reads its
 * KEYS first, filtered and sorted on the records view's plain columns only
 * (buyer_code, award_day, amount_lei, status), then its ROWS by
 * `source_name = $1 and match_id = any($2)`. Through a barrier view, a statement
 * that selects or filters a computed column (winner_count, lot_count, flags,
 * buyer_person, buyer_name_masked, change_*) evaluates it for every row that
 * passes the filter before the sort and limit (77 s for a page by day), so those
 * columns are read only in the rows step. Never `record_id`, never
 * `(source_name, match_id) in (select ...)`, never a join of two views.
 *
 * Columns are named, never `*`: the grant is table-level, so a column the
 * platform appends later reaches nothing until it is added here.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { daV3Table, DA_RELEASE_SCHEMA, SUPPLIER_NAMES_NAME } from './da-v3-sql.js';
import { namingFromView, type SupplierNamesViewRow } from '../../core/supplier-naming.js';

import type {
  CaBuyerProbe,
  CaCounts,
  CaRecordsReader,
  CaRecordsRepo,
  CaWindow,
} from '../../core/ca-records-ports.js';
import type {
  CaAppearance,
  CaKey,
  CaListSort,
  CaLotRow,
  CaRecordRow,
  CaWinnerRow,
} from '../../core/ca-records.js';

type Db = Kysely<ProdDatabase>;

const RECORDS = daV3Table('ca_records_public');
const WINNERS = daV3Table('ca_record_winners_public');
const LOTS = daV3Table('ca_record_lots_public');
const KEYS = daV3Table('ca_record_keys_public');
const RELEASE = daV3Table('da_release');
const PUBLIC_NAMES = daV3Table('party_public_names');
const SUPPLIER_NAMES = daV3Table('supplier_names_public');
const NAME_CHUNK = 500;

/** The four views the API reads; all four must be readable or nothing is served. */
export const CA_VIEW_NAMES = [
  'ca_records_public',
  'ca_record_winners_public',
  'ca_record_lots_public',
  'ca_record_keys_public',
].map((view) => `${DA_RELEASE_SCHEMA}.${view}`);
const PUBLIC_NAMES_NAME = `${DA_RELEASE_SCHEMA}.party_public_names`;

const AS_OF_SQL = sql`to_char(max(data_as_of) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const STATEMENT_TIMEOUT_MS = 10_000;

const readError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === '42P01' || code === '42703' || code === '3F000')
    return serviceUnavailable('Contract-award views are not deployed.');
  if (code === '42501') return serviceUnavailable('Contract awards are not readable by this API.');
  if (code === '57014') return timeoutError('Contract-award read timed out.');
  // Only the SQLSTATE: a driver message or detail may quote a value it read, and errors are logged.
  return databaseError(
    typeof code === 'string' ? `Contract-award read failed (${code})` : 'Contract-award read failed'
  );
};

const attempt = async <T>(run: () => Promise<T>): Promise<Result<T, ApiError>> => {
  try {
    return ok(await run());
  } catch (error) {
    return err(readError(error));
  }
};

const privilege = (name: string): RawBuilder<boolean> =>
  sql<boolean>`coalesce(has_table_privilege(to_regclass(${name}), 'SELECT'), false)`;

interface Access {
  readonly asOf: string | null;
  readonly views: boolean;
  readonly names: boolean;
  readonly registry: boolean;
}

/** What this login may read (catalog only, no view touched), then the release's data_as_of. */
const probeAccess = async (db: Db): Promise<Access> => {
  const result = await sql<{
    views: boolean;
    names: boolean;
    registry: boolean;
    release: boolean;
  }>`
    select ${sql.join(
      CA_VIEW_NAMES.map((name) => privilege(name)),
      sql` and `
    )} as views,
      ${privilege(SUPPLIER_NAMES_NAME)} as names,
      ${privilege(PUBLIC_NAMES_NAME)} as registry,
      -- The API's grant on da_release is per column (procurement-api-read.sql).
      coalesce(has_column_privilege(to_regclass(${`${DA_RELEASE_SCHEMA}.da_release`}), 'data_as_of', 'SELECT'),
        false) as release`.execute(db);
  const row = result.rows[0];
  let asOf: string | null = null;
  if (row?.release === true) {
    const release = await sql<{ as_of: string | null }>`
      select ${AS_OF_SQL} as as_of from ${RELEASE}`.execute(db);
    asOf = release.rows[0]?.as_of ?? null;
  }
  return {
    asOf,
    views: row?.views === true,
    names: row?.names === true,
    registry: row?.registry === true,
  };
};

const windowSql = (window: CaWindow): RawBuilder<unknown> =>
  window.to === null
    ? sql`r.award_day >= ${window.from}::date`
    : sql`r.award_day >= ${window.from}::date and r.award_day <= ${window.to}::date`;

const ORDER: Readonly<Record<CaListSort, RawBuilder<unknown>>> = {
  awardDayDesc: sql`r.award_day desc, r.source_name, r.match_id`,
  awardDayAsc: sql`r.award_day asc, r.source_name, r.match_id`,
  amountDesc: sql`r.amount_lei desc nulls last, r.award_day desc, r.source_name, r.match_id`,
};

/** Keys grouped by source, so each rows statement probes `(source_name, match_id = any(...))`. */
const bySource = (keys: readonly CaKey[]): Map<string, string[]> => {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const ids = groups.get(key.sourceName) ?? [];
    ids.push(key.matchId);
    groups.set(key.sourceName, ids);
  }
  return groups;
};

const keyText = (key: CaKey): string => `${key.sourceName}\u0000${key.matchId}`;

interface RecordSqlRow {
  source_name: string;
  match_id: string;
  contract_kind: string | null;
  value_kind: string;
  additive: boolean;
  status: string;
  ca_head_status: string | null;
  amount_lei: string | null;
  native_amount: string | null;
  currency: string | null;
  fx_source: string | null;
  vat_basis: string;
  amount_origin: string | null;
  flags: string[] | null;
  change_lei: string | null;
  change_publication_day: string | null;
  award_day: string | null;
  publication_day: string | null;
  buyer_code: string | null;
  buyer_county_code: string | null;
  buyer_siruta: string | null;
  buyer_region: string | null;
  buyer_person: boolean | null;
  buyer_name_masked: string | null;
  cpv_code: string | null;
  cpv_division: string | null;
  cpv_group: string | null;
  cpv_class: string | null;
  procedure_id: string | null;
  notice_no: string | null;
  title: string | null;
  source_url: string | null;
  winner_count: number;
  lot_count: number;
}

const toRecordRow = (row: RecordSqlRow): CaRecordRow => ({
  sourceName: row.source_name,
  matchId: row.match_id,
  contractKind: row.contract_kind,
  valueKind: row.value_kind,
  additive: row.additive,
  status: row.status,
  caHeadStatus: row.ca_head_status,
  amountLei: row.amount_lei,
  nativeAmount: row.native_amount,
  currency: row.currency,
  fxSource: row.fx_source,
  vatBasis: row.vat_basis,
  amountOrigin: row.amount_origin,
  flags: row.flags ?? [],
  changeLei: row.change_lei,
  changePublicationDay: row.change_publication_day,
  awardDay: row.award_day,
  publicationDay: row.publication_day,
  buyerCode: row.buyer_code,
  buyerCountyCode: row.buyer_county_code,
  buyerSiruta: row.buyer_siruta,
  buyerRegion: row.buyer_region,
  buyerPerson: row.buyer_person,
  buyerNameMasked: row.buyer_name_masked,
  cpvCode: row.cpv_code,
  cpvDivision: row.cpv_division,
  cpvGroup: row.cpv_group,
  cpvClass: row.cpv_class,
  procedureId: row.procedure_id,
  noticeNo: row.notice_no,
  title: row.title,
  sourceUrl: row.source_url,
  winnerCount: row.winner_count,
  lotCount: row.lot_count,
});

const day = (column: string): RawBuilder<unknown> =>
  sql`to_char(r.${sql.ref(column)}, 'YYYY-MM-DD')`;

/** The rows step's columns: every served column by name, money as text, days as text. */
const RECORD_COLUMNS = sql`
  r.source_name, r.match_id, r.contract_kind, r.value_kind, r.additive, r.status, r.ca_head_status,
  r.amount_lei::text as amount_lei, r.native_amount::text as native_amount, r.currency, r.fx_source,
  r.vat_basis, r.amount_origin, r.flags, r.change_lei::text as change_lei,
  ${day('change_publication_day')} as change_publication_day,
  ${day('award_day')} as award_day, ${day('publication_day')} as publication_day,
  r.buyer_code, r.buyer_county_code, r.buyer_siruta, r.buyer_region, r.buyer_person,
  r.buyer_name_masked, r.cpv_code, r.cpv_division, r.cpv_group, r.cpv_class, r.procedure_id,
  r.notice_no, r.title, r.source_url, r.winner_count, r.lot_count`;

/** The keys statement of a buyer's dated records in a window (plain columns only). */
export const buyerKeysSql = (query: {
  readonly buyerCode: string;
  readonly window: CaWindow;
  readonly sort: CaListSort;
  readonly offset: number;
  readonly limit: number;
}): RawBuilder<{ source_name: string; match_id: string }> => sql`
  select r.source_name, r.match_id
  from ${RECORDS} r
  where r.buyer_code = ${query.buyerCode} and ${windowSql(query.window)}
  order by ${ORDER[query.sort]}
  offset ${query.offset} limit ${query.limit}`;

/** The counts statement of a buyer (plain columns only). */
export const buyerCountsSql = (
  buyerCode: string,
  window: CaWindow
): RawBuilder<{ records: number; valued: number; review: number; undated: number }> => sql`
  select count(*) filter (where ${windowSql(window)})::integer as records,
    count(*) filter (where ${windowSql(window)} and r.amount_lei is not null)::integer as valued,
    count(*) filter (where ${windowSql(window)} and r.status = 'identity_review')::integer as review,
    count(*) filter (where r.award_day is null)::integer as undated
  from ${RECORDS} r
  where r.buyer_code = ${buyerCode}`;

/** The rows statement of one source's keys. */
export const recordRowsSql = (
  sourceName: string,
  matchIds: readonly string[]
): RawBuilder<RecordSqlRow> => sql`
  select ${RECORD_COLUMNS}
  from ${RECORDS} r
  where r.source_name = ${sourceName} and r.match_id = any(${matchIds}::text[])`;

/** A record's award day by key (the plain column only). */
export const awardDaySql = (key: CaKey): RawBuilder<{ award_day: string | null }> => sql`
  select to_char(r.award_day, 'YYYY-MM-DD') as award_day
  from ${RECORDS} r
  where r.source_name = ${key.sourceName} and r.match_id = any(${[key.matchId]}::text[])`;

/** The winners of one source's keys. */
export const winnerRowsSql = (
  sourceName: string,
  matchIds: readonly string[]
): RawBuilder<{
  source_name: string;
  match_id: string;
  winner_order: number | null;
  fiscal_code_clean: string | null;
  supplier_disclosed: boolean | null;
}> => sql`
  select w.source_name, w.match_id, w.winner_order, w.fiscal_code_clean, w.supplier_disclosed
  from ${WINNERS} w
  where w.source_name = ${sourceName} and w.match_id = any(${matchIds}::text[])`;

/** The lots of one record. */
export const lotRowsSql = (
  key: CaKey
): RawBuilder<{
  lot_order: number;
  lot_number: string | null;
  title: string | null;
  cpv_code: string | null;
  estimated_value: string | null;
  currency: string | null;
  is_eu_funded: boolean | null;
  cancelled_status: string | null;
}> => sql`
  select l.lot_order, l.lot_number, l.title, l.cpv_code, l.estimated_value::text as estimated_value,
    l.currency, l.is_eu_funded, l.cancelled_status
  from ${LOTS} l
  where l.source_name = ${key.sourceName} and l.match_id = any(${[key.matchId]}::text[])
  order by l.lot_order, l.lot_number`;

/** Today's key of an appearance (the keys view, by its primary key). */
export const currentKeySql = (
  appearance: CaAppearance
): RawBuilder<{ source_name: string; match_id: string }> => sql`
  select k.source_name, k.match_id
  from ${KEYS} k
  where k.source_name = ${appearance.sourceName}
    and k.publication_id = ${appearance.publicationId}
    and k.contract_id = ${appearance.contractId}`;

/** Any one record of a buyer (a keys step on the plain column). */
export const buyerAnyKeySql = (
  buyerCode: string
): RawBuilder<{ source_name: string; match_id: string }> => sql`
  select r.source_name, r.match_id from ${RECORDS} r
  where r.buyer_code = ${buyerCode} limit 1`;

const makeReader = (trx: Db, access: Access): CaRecordsReader => ({
  dataAsOf: () => Promise.resolve(ok(access.asOf)),
  namesReadable: () => access.names,

  buyerCounts: (buyerCode, window) =>
    attempt(async (): Promise<CaCounts> => {
      const result = await buyerCountsSql(buyerCode, window).execute(trx);
      const row = result.rows[0];
      return {
        recordCount: row?.records ?? 0,
        valuedCount: row?.valued ?? 0,
        identityReviewCount: row?.review ?? 0,
        undatedCount: row?.undated ?? 0,
      };
    }),

  buyerKeys: (query) =>
    attempt(async () => {
      const result = await buyerKeysSql(query).execute(trx);
      return result.rows.map((row) => ({ sourceName: row.source_name, matchId: row.match_id }));
    }),

  awardDayOf: (key) =>
    attempt(async () => {
      const result = await awardDaySql(key).execute(trx);
      const row = result.rows[0];
      return row === undefined ? null : { awardDay: row.award_day };
    }),

  recordsByKeys: (keys) =>
    attempt(async () => {
      const found = new Map<string, CaRecordRow>();
      for (const [sourceName, matchIds] of bySource(keys)) {
        const result = await recordRowsSql(sourceName, matchIds).execute(trx);
        for (const row of result.rows) {
          const record = toRecordRow(row);
          found.set(keyText(record), record);
        }
      }
      return keys.flatMap((key) => {
        const record = found.get(keyText(key));
        return record === undefined ? [] : [record];
      });
    }),

  winnersByKeys: (keys) =>
    attempt(async () => {
      const rows: CaWinnerRow[] = [];
      for (const [sourceName, matchIds] of bySource(keys)) {
        const result = await winnerRowsSql(sourceName, matchIds).execute(trx);
        for (const row of result.rows)
          rows.push({
            sourceName: row.source_name,
            matchId: row.match_id,
            winnerOrder: row.winner_order,
            fiscalCode: row.fiscal_code_clean,
            supplierDisclosed: row.supplier_disclosed,
          });
      }
      // Every code is named through supplier_names_public only (no registry fallback); without
      // it no naming is attached and the core shows no code.
      const codes = [
        ...new Set(rows.flatMap((row) => (row.fiscalCode === null ? [] : [row.fiscalCode]))),
      ];
      if (codes.length === 0 || !access.names) return rows;
      const views = new Map<string, SupplierNamesViewRow>();
      for (let start = 0; start < codes.length; start += NAME_CHUNK) {
        const result = await sql<{
          code: string;
          naming: string | null;
          display_name: string | null;
          code_shown: boolean | null;
        }>`
          select v.fiscal_code_clean as code, v.naming, v.display_name, v.code_shown
          from ${SUPPLIER_NAMES} v
          where v.fiscal_code_clean = any(${codes.slice(start, start + NAME_CHUNK)}::text[])`.execute(
          trx
        );
        for (const row of result.rows) {
          const next = {
            naming: row.naming,
            displayName: row.display_name,
            codeShown: row.code_shown,
          };
          // Two rows for one code (never expected): a code either hides is hidden.
          const prior = views.get(row.code);
          views.set(
            row.code,
            prior !== undefined && (prior.codeShown !== true || next.codeShown !== true)
              ? { ...next, codeShown: false }
              : next
          );
        }
      }
      return rows.map((row) =>
        row.fiscalCode === null
          ? row
          : { ...row, naming: namingFromView(views.get(row.fiscalCode)) }
      );
    }),

  lotsOf: (key) =>
    attempt(async () => {
      const result = await lotRowsSql(key).execute(trx);
      return result.rows.map((row): CaLotRow => ({
        ...key,
        lotOrder: row.lot_order,
        lotNumber: row.lot_number,
        title: row.title,
        cpvCode: row.cpv_code,
        estimatedValue: row.estimated_value,
        currency: row.currency,
        isEuFunded: row.is_eu_funded,
        cancelledStatus: row.cancelled_status,
      }));
    }),

  currentKeyOf: (appearance: CaAppearance) =>
    attempt(async () => {
      const result = await currentKeySql(appearance).execute(trx);
      const row = result.rows[0];
      return row === undefined ? null : { sourceName: row.source_name, matchId: row.match_id };
    }),

  buyerProbe: (buyerCode) =>
    attempt(async (): Promise<CaBuyerProbe | null> => {
      // Keys step: any one record of the buyer (plain columns), then its person flag by key.
      const keys = await buyerAnyKeySql(buyerCode).execute(trx);
      const key = keys.rows[0];
      if (key === undefined) return null;
      const result = await sql<{ buyer_person: boolean | null; buyer_name_masked: string | null }>`
        select r.buyer_person, r.buyer_name_masked from ${RECORDS} r
        where r.source_name = ${key.source_name} and r.match_id = any(${[key.match_id]}::text[])`.execute(
        trx
      );
      const row = result.rows[0];
      return row === undefined
        ? null
        : { person: row.buyer_person, maskedName: row.buyer_name_masked };
    }),

  buyerRegistryNames: (codes) =>
    attempt(async () => {
      const names = new Map<string, string>();
      if (codes.length === 0 || !access.registry) return names;
      const result = await sql<{ code: string; name: string | null }>`
        select n.fiscal_code_clean as code, n.registry_name as name
        from ${PUBLIC_NAMES} n
        where n.fiscal_code_clean = any(${[...new Set(codes)]}::text[])
          and n.buyer_name_public is true`.execute(trx);
      for (const row of result.rows) if (row.name !== null) names.set(row.code, row.name);
      return names;
    }),
});

const disabled = (): ApiError =>
  serviceUnavailable('Contract awards are not enabled on this server.');

const REPUBLISHED = (): ApiError =>
  serviceUnavailable('contract-award data was republished during this request; repeat the request');

export const makeCaRecordsRepo = (db: Db, enabled: boolean): CaRecordsRepo => ({
  enabled,
  snapshot: async (read) => {
    if (!enabled) return err(disabled());
    try {
      const seen: { access: Access | null } = { access: null };
      const result = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`set transaction read only`.execute(trx);
          await sql`set local statement_timeout = ${sql.lit(STATEMENT_TIMEOUT_MS)}`.execute(trx);
          const access = await probeAccess(trx);
          seen.access = access;
          if (!access.views)
            return err(serviceUnavailable('Contract awards are not readable by this API.'));
          return read(makeReader(trx, access));
        });
      const before = seen.access;
      if (result.isErr() || before === null) return result;
      // After the read: the same release, and the names view no less readable than it was.
      const now = await probeAccess(db);
      return now.asOf === before.asOf && now.views && (now.names || !before.names)
        ? result
        : err(REPUBLISHED());
    } catch (error) {
      return err(readError(error));
    }
  },
});
