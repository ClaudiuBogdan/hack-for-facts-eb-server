/**
 * Direct acquisitions, release 1 — SQL over the data platform's serving tables
 * (`procurement_v3`, pending the owner's migration; only the schema name may
 * change, so it is named once here).
 *
 * One read-only, repeatable-read transaction per request (`snapshot`). The
 * snapshot also probes the columns the contract still lists as pending
 * (`da_purchases.listed_now`, line and free-text flags) so the reader works
 * before and after they land. Parties join on (source_name, party_kind,
 * portal_party_id). Columns are named: the contract's unserved columns
 * (estimates, amount/currency/VAT basis, rule conditions, keys, internal review
 * columns, party contacts and addresses) are never selected.
 *
 * D6 in SQL (`namedSupplier`) is used only to filter and to bucket totals;
 * every party that reaches a response is re-checked by the core rule.
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  offsetFor,
  serviceUnavailable,
  timeoutError,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  daV3Table,
  DA_RELEASE_SCHEMA,
  namedSupplierSql,
  probeSupplierPrivacy,
  supplierPrivacyJoin,
} from './da-v3-sql.js';
import { DA_LIST_MAX_DEPTH } from '../../core/da-release-usecases.js';

import type {
  DaPurchaseFilter,
  DaReleaseReader,
  DaReleaseRepo,
  DaTotalsQuery,
} from '../../core/da-release-ports.js';
import type {
  DaItemRecord,
  DaPartyRecord,
  DaPurchaseRecord,
  DaTotalsGroupRecord,
  DaTotalsRecord,
} from '../../core/da-release.js';

type Db = Kysely<ProdDatabase>;

export { DA_RELEASE_SCHEMA } from './da-v3-sql.js';

const table = daV3Table;
const PURCHASES = table('da_purchases');
const PARTIES = table('da_parties');
const RULES = table('da_value_rules');
const ITEMS = table('da_items');
const RELEASE = table('da_release');

const STATEMENT_TIMEOUT_MS = 10_000;

const readError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  // Undefined schema/table/column: the serving tables are not deployed (yet).
  if (code === '42P01' || code === '42703' || code === '3F000')
    return serviceUnavailable('Direct acquisitions release 1 tables are not deployed.');
  if (code === '57014') return timeoutError('Direct acquisitions read timed out.');
  return databaseError('Direct acquisitions read failed', error);
};

const attempt = async <T>(run: () => Promise<T>): Promise<Result<T, ApiError>> => {
  try {
    return ok(await run());
  } catch (error) {
    return err(readError(error));
  }
};

// ── Columns ──────────────────────────────────────────────────────────────────

interface PartyColumns {
  portal_party_id: string | null;
  name_as_written: string | null;
  fiscal_code_clean: string | null;
  fiscal_code_status: string | null;
  supplier_public: boolean;
}

/** The selected columns of one party alias, prefixed. Contacts and addresses are never read. */
const PARTY_COLUMNS = [
  'portal_party_id',
  'name_as_written',
  'fiscal_code_clean',
  'fiscal_code_status',
];
/** `supplier_public` for `s` comes from `supplier_privacy` (alias `sv`); a buyer is never classified. */
const partyColumns = (alias: 'b' | 's', supplierPrivacy: boolean) =>
  sql.join([
    ...PARTY_COLUMNS.map(
      (column) => sql`${sql.ref(`${alias}.${column}`)} as ${sql.id(`${alias}_${column}`)}`
    ),
    sql`${alias === 's' && supplierPrivacy ? sql`coalesce(sv.public, false)` : sql`false`} as ${sql.id(`${alias}_supplier_public`)}`,
  ]);

const partyOf = (row: Record<string, unknown>, prefix: string): DaPartyRecord | null => {
  const id = row[`${prefix}_portal_party_id`];
  if (typeof id !== 'string') return null;
  const text = (key: string): string | null => {
    const value = row[`${prefix}_${key}`];
    return typeof value === 'string' ? value : null;
  };
  return {
    portalPartyId: id,
    name: text('name_as_written'),
    fiscalCode: text('fiscal_code_clean'),
    fiscalCodeStatus: text('fiscal_code_status'),
    supplierPublic: row[`${prefix}_supplier_public`] === true,
  };
};

const toPartyRecord = (row: PartyColumns): DaPartyRecord | null =>
  row.portal_party_id === null
    ? null
    : {
        portalPartyId: row.portal_party_id,
        name: row.name_as_written,
        fiscalCode: row.fiscal_code_clean,
        fiscalCodeStatus: row.fiscal_code_status,
        supplierPublic: row.supplier_public,
      };

interface PurchaseRow extends Record<string, unknown> {
  purchase_id: string;
  native_id: string | null;
  code: string | null;
  source_url: string | null;
  outcome: string;
  state_label: string | null;
  publication_day: string | null;
  finalization_day: string | null;
  ca_decision_at: string | null;
  supplier_decision_at: string | null;
  reported_value: string | null;
  counted: boolean;
  counted_value: string | null;
  not_counted_reason: string | null;
  value_corrected: boolean;
  value_review_rule: string | null;
  rule_rule: string | null;
  rule_effect: string | null;
  rule_description_en: string | null;
  rule_description_ro: string | null;
  symbolic_price: boolean;
  listed_now: boolean | null;
  title: string | null;
  title_public: boolean;
  description: string | null;
  description_public: boolean;
  category_code: string | null;
  category_as_written: string | null;
  acquisition_type_label: string | null;
}

const toPurchaseRecord = (row: PurchaseRow): DaPurchaseRecord => ({
  purchaseId: row.purchase_id,
  nativeId: row.native_id,
  code: row.code,
  sourceUrl: row.source_url,
  outcome: row.outcome,
  stateLabel: row.state_label,
  publicationDay: row.publication_day,
  finalizationDay: row.finalization_day,
  buyerDecisionAt: row.ca_decision_at,
  supplierDecisionAt: row.supplier_decision_at,
  reportedValue: row.reported_value,
  counted: row.counted,
  countedValue: row.counted_value,
  notCountedReason: row.not_counted_reason,
  valueCorrected: row.value_corrected,
  valueReviewRule: row.value_review_rule,
  rule:
    row.rule_rule === null || row.rule_effect === null
      ? null
      : {
          rule: row.rule_rule,
          effect: row.rule_effect,
          descriptionEn: row.rule_description_en,
          descriptionRo: row.rule_description_ro,
        },
  symbolicPrice: row.symbolic_price,
  listedNow: row.listed_now,
  title: row.title,
  titlePublic: row.title_public,
  description: row.description,
  descriptionPublic: row.description_public,
  categoryCode: row.category_code,
  categoryAsWritten: row.category_as_written,
  acquisitionTypeLabel: row.acquisition_type_label,
  buyer: partyOf(row, 'b'),
  supplier: partyOf(row, 's'),
});

interface Columns {
  /** `supplier_privacy` exists. Absent: every supplier is withheld (D6 fails closed). */
  readonly supplierPrivacy: boolean;
  readonly listedNow: boolean;
  /** `da_items.superseded_at`: lines the sync no longer sees; only current lines are served. */
  readonly itemSupersededAt: boolean;
  /**
   * Free-text gates (decision 2026-11-10: free text is restricted until the
   * loader marks a field public). Absent column, or a false/null flag: the
   * text is never selected and the field is served withheld.
   */
  readonly titlePublic: boolean;
  readonly descriptionPublic: boolean;
  readonly itemNamePublic: boolean;
}

/** A gated free-text column: the text leaves the database only when its row's flag is true. */
const gatedText = (present: boolean, flag: string, column: string, alias: string) =>
  present
    ? sql`case when ${sql.ref(flag)} is true then ${sql.ref(column)} end as ${sql.id(alias)}, coalesce(${sql.ref(flag)}, false) as ${sql.id(`${alias}_public`)}`
    : sql`null::text as ${sql.id(alias)}, false as ${sql.id(`${alias}_public`)}`;

/** The supplier's classification row; joined only when the table exists. */
const privacyJoin = (columns: Columns) => supplierPrivacyJoin(columns.supplierPrivacy);

/** Dates and timestamps as text, so the driver never builds a JS Date. Money stays numeric text. */
const purchaseSelect = (columns: Columns) => sql`
  select
    p.purchase_id, p.native_id, p.code, p.source_url, p.outcome, p.state_label,
    p.publication_day::text as publication_day,
    p.finalization_day::text as finalization_day,
    to_char(p.ca_decision_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ca_decision_at,
    to_char(p.supplier_decision_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as supplier_decision_at,
    p.reported_value::text as reported_value,
    p.counted,
    p.counted_value::text as counted_value,
    p.not_counted_reason, p.value_corrected, p.value_review_rule,
    r.rule as rule_rule, r.effect as rule_effect,
    r.public_description_en as rule_description_en,
    r.public_description_ro as rule_description_ro,
    p.symbolic_price,
    ${columns.listedNow ? sql`p.listed_now` : sql`null::boolean`} as listed_now,
    ${gatedText(columns.titlePublic, 'p.title_public', 'p.title', 'title')},
    ${gatedText(columns.descriptionPublic, 'p.description_public', 'p.description', 'description')},
    p.category_code, p.category_as_written, p.acquisition_type_label,
    ${partyColumns('b', false)},
    ${partyColumns('s', columns.supplierPrivacy)}
  from ${PURCHASES} p
  left join ${PARTIES} b
    on b.source_name = p.source_name and b.party_kind = 'buyer'
   and b.portal_party_id = p.buyer_party_id
  left join ${PARTIES} s
    on s.source_name = p.source_name and s.party_kind = 'supplier'
   and s.portal_party_id = p.supplier_party_id
  ${privacyJoin(columns)}
  left join ${RULES} r on r.rule = p.value_review_rule`;

/** D6 in SQL, over supplier alias `s` and its `supplier_privacy` row `sv`: see `isNamedSupplier` in core. */
const namedSupplier = (columns: Columns) => namedSupplierSql(columns.supplierPrivacy);

/** The filter's conditions over `p`, with `b` and `s` joined. */
const whereOf = (filter: DaPurchaseFilter, columns: Columns): RawBuilder<unknown> => {
  const conditions: RawBuilder<unknown>[] = [sql`true`];
  if (filter.buyerFiscalCode !== undefined)
    conditions.push(
      sql`b.fiscal_code_clean = ${filter.buyerFiscalCode} and b.fiscal_code_status = 'valid'`
    );
  if (filter.supplierFiscalCode !== undefined)
    conditions.push(
      sql`s.fiscal_code_clean = ${filter.supplierFiscalCode} and ${namedSupplier(columns)}`
    );
  if (filter.cpvDivision !== undefined)
    conditions.push(sql`left(p.category_code, 2) = ${filter.cpvDivision}`);
  if (filter.finalizationFrom !== undefined)
    conditions.push(sql`p.finalization_day >= ${filter.finalizationFrom}::date`);
  if (filter.finalizationTo !== undefined)
    conditions.push(sql`p.finalization_day <= ${filter.finalizationTo}::date`);
  if (filter.outcomes !== undefined)
    conditions.push(sql`p.outcome = any(${[...filter.outcomes]}::text[])`);
  if (filter.counted !== undefined) conditions.push(sql`p.counted = ${filter.counted}`);
  if (filter.code !== undefined) conditions.push(sql`p.code = ${filter.code}`);
  if (filter.nativeId !== undefined) conditions.push(sql`p.native_id = ${filter.nativeId}`);
  return sql.join(conditions, sql` and `);
};

const scopeFrom = (columns: Columns) => sql`
  from ${PURCHASES} p
  left join ${PARTIES} b
    on b.source_name = p.source_name and b.party_kind = 'buyer'
   and b.portal_party_id = p.buyer_party_id
  left join ${PARTIES} s
    on s.source_name = p.source_name and s.party_kind = 'supplier'
   and s.portal_party_id = p.supplier_party_id
  ${privacyJoin(columns)}`;

const MEASURES = sql`
  sum(p.counted_value) filter (where p.counted)::text as counted_value,
  count(*) filter (where p.counted)::text as counted_count,
  count(*) filter (where p.counted and p.symbolic_price)::text as symbolic_price_count,
  count(*)::text as purchase_count`;

interface MeasureRow {
  counted_value: string | null;
  counted_count: string;
  symbolic_price_count: string;
  purchase_count: string;
}

const toMeasures = (row: MeasureRow): DaTotalsRecord => ({
  countedValue: row.counted_value,
  countedCount: row.counted_count,
  symbolicPriceCount: row.symbolic_price_count,
  purchaseCount: row.purchase_count,
});

const exactCount = (text: string | undefined): Result<number, ApiError> => {
  const value = Number(text);
  return /^[0-9]+$/u.test(text ?? '') && Number.isSafeInteger(value)
    ? ok(value)
    : err(databaseError('Direct acquisitions count is not an exact integer.'));
};

// ── Totals grouping ──────────────────────────────────────────────────────────

/**
 * The grouped select list for each dimension: `group_key`, the supplier
 * bucket, and (buyer/supplier) the party's own columns, so a group needs no
 * second read. A buyer groups by (source_name, portal_party_id). A supplier D6
 * names groups the same way; every withheld supplier falls into ONE bucket
 * whose party columns are all null, so no withheld party is told apart.
 */
const groupSelect = (groupBy: NonNullable<DaTotalsQuery['groupBy']>, columns: Columns) => {
  const noParty = sql`null::text as g_portal_party_id, null::text as g_name_as_written,
    null::text as g_fiscal_code_clean, null::text as g_fiscal_code_status, false as g_supplier_public`;
  switch (groupBy) {
    case 'buyer':
      return {
        select: sql`b.source_name || ':' || b.portal_party_id as group_key, null::text as g_bucket,
          b.portal_party_id as g_portal_party_id, b.name_as_written as g_name_as_written,
          b.fiscal_code_clean as g_fiscal_code_clean, b.fiscal_code_status as g_fiscal_code_status,
          false as g_supplier_public`,
        width: 7,
        byValue: true,
      };
    case 'supplier': {
      const named = namedSupplier(columns);
      const when = (column: string) => sql`case when ${named} then ${sql.ref(`s.${column}`)} end`;
      return {
        select: sql`case when ${named} then s.source_name || ':' || s.portal_party_id end as group_key,
          case when s.portal_party_id is null then 'none' when ${named} then 'named' else 'withheld' end as g_bucket,
          ${when('portal_party_id')} as g_portal_party_id,
          ${when('name_as_written')} as g_name_as_written,
          ${when('fiscal_code_clean')} as g_fiscal_code_clean,
          ${when('fiscal_code_status')} as g_fiscal_code_status,
          ${named} as g_supplier_public`,
        width: 7,
        byValue: true,
      };
    }
    case 'cpvDivision':
      return {
        select: sql`left(p.category_code, 2) as group_key, null::text as g_bucket, ${noParty}`,
        width: 7,
        byValue: true,
      };
    case 'month':
      return {
        select: sql`to_char(p.finalization_day, 'YYYY-MM') as group_key, null::text as g_bucket, ${noParty}`,
        width: 7,
        byValue: false,
      };
    case 'year':
      return {
        select: sql`to_char(p.finalization_day, 'YYYY') as group_key, null::text as g_bucket, ${noParty}`,
        width: 7,
        byValue: false,
      };
  }
};

/** `group by 1, 2, …, width`: every selected group column. */
const groupByPositions = (width: number) =>
  sql.join(Array.from({ length: width }, (_, index) => sql.lit(index + 1)));

interface GroupRow extends MeasureRow {
  group_key: string | null;
  g_bucket: string | null;
  g_portal_party_id: string | null;
  g_name_as_written: string | null;
  g_fiscal_code_clean: string | null;
  g_fiscal_code_status: string | null;
  g_supplier_public: boolean | null;
  group_count: string;
}

const toGroupRecord = (
  row: GroupRow,
  groupBy: NonNullable<DaTotalsQuery['groupBy']>
): DaTotalsGroupRecord => {
  const party =
    groupBy === 'buyer' || groupBy === 'supplier'
      ? toPartyRecord({
          portal_party_id: row.g_portal_party_id,
          name_as_written: row.g_name_as_written,
          fiscal_code_clean: row.g_fiscal_code_clean,
          fiscal_code_status: row.g_fiscal_code_status,
          supplier_public: row.g_supplier_public === true,
        })
      : null;
  return {
    ...toMeasures(row),
    key: groupBy === 'buyer' || groupBy === 'supplier' ? null : row.group_key,
    supplierBucket:
      groupBy !== 'supplier'
        ? null
        : row.g_bucket === 'none'
          ? 'none'
          : row.g_bucket === 'named'
            ? 'named'
            : 'withheld',
    party,
  };
};

// ── Reader ───────────────────────────────────────────────────────────────────

const makeReader = (trx: Db, columns: Columns): DaReleaseReader => ({
  dataAsOf: () =>
    attempt(async () => {
      const result = await sql<{ data_as_of: string | null }>`
        select to_char(max(data_as_of) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as data_as_of
        from ${RELEASE}`.execute(trx);
      return result.rows[0]?.data_as_of ?? null;
    }),

  supplierPrivacyTable: () => columns.supplierPrivacy,

  listPurchases: async (query) => {
    const where = whereOf(query.filter, columns);
    const rows = await attempt(
      async () =>
        (
          await sql<PurchaseRow>`
            ${purchaseSelect(columns)}
            where ${where}
            order by p.finalization_day desc nulls last, p.purchase_id desc
            limit ${Math.max(0, Math.min(query.pageSize, DA_LIST_MAX_DEPTH - offsetFor(query)))}
            offset ${offsetFor(query)}`.execute(trx)
        ).rows
    );
    if (rows.isErr()) return err(rows.error);
    const counted = await attempt(
      async () =>
        (
          await sql<{ total: string }>`
            select count(*)::text as total from (
              select 1 ${scopeFrom(columns)} where ${where} limit ${DA_LIST_MAX_DEPTH + 1}
            ) as capped`.execute(trx)
        ).rows[0]?.total
    );
    if (counted.isErr()) return err(counted.error);
    const total = exactCount(counted.value);
    if (total.isErr()) return err(total.error);
    const capped = total.value > DA_LIST_MAX_DEPTH;
    return ok({
      rows: rows.value.map(toPurchaseRecord),
      total: capped ? DA_LIST_MAX_DEPTH : total.value,
      capped,
    });
  },

  purchaseById: (purchaseId) =>
    attempt(async () => {
      const result = await sql<PurchaseRow>`
        ${purchaseSelect(columns)}
        where p.purchase_id = ${purchaseId}
        limit 1`.execute(trx);
      const row = result.rows[0];
      return row === undefined ? null : toPurchaseRecord(row);
    }),

  itemsOf: (purchaseId) =>
    attempt(async () => {
      const result = await sql<{
        item_index: number;
        name: string | null;
        name_public: boolean;
        unit: string | null;
        quantity: string | null;
        requested_quantity: string | null;
        unit_price: string | null;
        catalogue_price: string | null;
        reported_line_value: string | null;
        supplier_rejected: boolean | null;
        quantity_correction: boolean | null;
      }>`
        select i.item_index,
               ${gatedText(columns.itemNamePublic, 'i.item_name_public', 'i.name', 'name')},
               i.unit,
               i.quantity::text as quantity,
               i.requested_quantity::text as requested_quantity,
               i.unit_price::text as unit_price,
               i.catalogue_price::text as catalogue_price,
               (i.quantity * i.unit_price)::text as reported_line_value,
               i.supplier_rejected, i.quantity_correction
        from ${ITEMS} i
        where i.purchase_id = ${purchaseId}
          ${columns.itemSupersededAt ? sql`and i.superseded_at is null` : sql``}
        order by i.item_index`.execute(trx);
      return result.rows.map((row): DaItemRecord => ({
        itemIndex: row.item_index,
        name: row.name,
        namePublic: row.name_public,
        unit: row.unit,
        quantity: row.quantity,
        requestedQuantity: row.requested_quantity,
        unitPrice: row.unit_price,
        cataloguePrice: row.catalogue_price,
        reportedLineValue: row.reported_line_value,
        supplierRejected: row.supplier_rejected,
        quantityCorrection: row.quantity_correction,
      }));
    }),

  totals: async (query) => {
    const where = whereOf(query.filter, columns);
    const overall = await attempt(
      async () =>
        (
          await sql<MeasureRow>`select ${MEASURES} ${scopeFrom(columns)} where ${where}`.execute(
            trx
          )
        ).rows[0]
    );
    if (overall.isErr()) return err(overall.error);
    if (overall.value === undefined)
      return err(databaseError('Direct acquisitions total returned no row.'));
    if (query.groupBy === null)
      return ok({ overall: toMeasures(overall.value), groups: [], groupCount: 0 });

    const groupBy = query.groupBy;
    const { select, width, byValue } = groupSelect(groupBy, columns);
    const order = byValue
      ? sql`sum(p.counted_value) filter (where p.counted) desc nulls last, count(*) desc, group_key asc nulls last, g_bucket asc nulls last`
      : sql`group_key asc nulls last`;
    const grouped = await attempt(
      async () =>
        (
          await sql<GroupRow>`
            select ${select}, ${MEASURES}, count(*) over ()::text as group_count
            ${scopeFrom(columns)}
            where ${where}
            group by ${groupByPositions(width)}
            order by ${order}
            limit ${query.pageSize} offset ${offsetFor(query)}`.execute(trx)
        ).rows
    );
    if (grouped.isErr()) return err(grouped.error);
    let groupCount = grouped.value[0]?.group_count;
    if (groupCount === undefined) {
      // A page past the end still reports how many groups exist.
      const counted = await attempt(
        async () =>
          (
            await sql<{ total: string }>`
              select count(*)::text as total from (
                select ${select} ${scopeFrom(columns)} where ${where} group by ${groupByPositions(width)}
              ) as g`.execute(trx)
          ).rows[0]?.total
      );
      if (counted.isErr()) return err(counted.error);
      groupCount = counted.value ?? '0';
    }
    const count = exactCount(groupCount);
    if (count.isErr()) return err(count.error);
    const groups = grouped.value.map((row) => toGroupRecord(row, groupBy));
    return ok({ overall: toMeasures(overall.value), groups, groupCount: count.value });
  },
});

/** The pending contract columns, each probed per snapshot: (table, column) → Columns key. */
const PENDING_COLUMNS = [
  ['da_purchases', 'listed_now', 'listedNow'],
  ['da_items', 'superseded_at', 'itemSupersededAt'],
  ['da_purchases', 'title_public', 'titlePublic'],
  ['da_purchases', 'description_public', 'descriptionPublic'],
  ['da_items', 'item_name_public', 'itemNamePublic'],
] as const satisfies readonly (readonly [string, string, keyof Columns])[];

/** Which pending contract columns exist yet. Catalog reads only. */
const probeColumns = async (trx: Db): Promise<Columns> => {
  const result = await sql<{ table_name: string; column_name: string }>`
    select c.relname as table_name, a.attname as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${DA_RELEASE_SCHEMA} and not a.attisdropped and a.attnum > 0
      and c.relname = any(${[...new Set(PENDING_COLUMNS.map(([table]) => table))]}::text[])
      and a.attname = any(${[...new Set(PENDING_COLUMNS.map(([, column]) => column))]}::text[])`.execute(
    trx
  );
  const present = new Set(result.rows.map((row) => `${row.table_name}.${row.column_name}`));
  const has = (key: keyof Columns): boolean =>
    PENDING_COLUMNS.some(([table, column, k]) => k === key && present.has(`${table}.${column}`));
  const supplierPrivacy = await probeSupplierPrivacy(trx);
  return {
    supplierPrivacy,
    listedNow: has('listedNow'),
    itemSupersededAt: has('itemSupersededAt'),
    titlePublic: has('titlePublic'),
    descriptionPublic: has('descriptionPublic'),
    itemNamePublic: has('itemNamePublic'),
  };
};

const disabled = (): ApiError =>
  serviceUnavailable('Direct acquisitions release 1 is not enabled on this server.');

export const makeDaReleaseRepo = (db: Db, enabled: boolean): DaReleaseRepo => ({
  enabled,
  snapshot: async (read) => {
    if (!enabled) return err(disabled());
    try {
      return await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`set transaction read only`.execute(trx);
          await sql`set local statement_timeout = ${sql.lit(STATEMENT_TIMEOUT_MS)}`.execute(trx);
          const columns = await probeColumns(trx);
          return read(makeReader(trx, columns));
        });
    } catch (error) {
      return err(readError(error));
    }
  },
});
