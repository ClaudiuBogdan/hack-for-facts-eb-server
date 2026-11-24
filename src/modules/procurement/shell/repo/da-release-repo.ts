/**
 * Direct acquisitions, release 1 — SQL over the data platform's serving tables
 * (`procurement_v3`, pending the owner's migration; only the schema name may
 * change, so it is named once here).
 *
 * One read-only, repeatable-read transaction per request (`snapshot`). The
 * snapshot also probes the columns the contract still lists as pending
 * (`da_purchases.listed_now`, line and free-text columns) so the reader works
 * before and after they land. Parties come from `da_parties_public` and join on
 * (source_name, party_kind, portal_party_id); a supplier party id with no public
 * row is a withheld supplier. Named suppliers' names come from
 * `party_public_names`, by code, after a page is read. Columns are named: the
 * contract's unserved columns (estimates, amount/currency/VAT basis, rule
 * conditions, keys, internal review columns, raw free text) are never selected;
 * free text is read only from the platform's `*_shown` columns, and purchase
 * descriptions are never read.
 *
 * D6 in SQL (`namedSupplier`) is used only to filter and to bucket totals;
 * every party that reaches a response is re-checked by the core rule.
 */

import { Decimal } from 'decimal.js';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  offsetFor,
  serviceUnavailable,
  timeoutError,
  withoutLeadingZeros,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import {
  daV3Table,
  DA_PARTIES_PUBLIC,
  DA_RELEASE_SCHEMA,
  disclosedPartySql,
  DISCLOSED_COLUMN_STATE_SQL,
  disclosedColumnOf,
  namedSupplierSql,
  probeSupplierDisclosedColumn,
  type DisclosedColumn,
  probeSupplierDisclosure,
  undisclosedSupplierSql,
  purchaseParties,
  SUPPLIER_DISCLOSURE_NAME,
  supplierNamesByCode,
} from './da-v3-sql.js';
import { DA_LIST_MAX_DEPTH } from '../../core/da-release-usecases.js';
import {
  isNamedSupplier,
  type DaItemRecord,
  type DaPartyRecord,
  type DaPurchaseRecord,
  type DaTotalsGroupRecord,
  type DaTotalsRecord,
} from '../../core/da-release.js';

import type {
  DaPurchaseFilter,
  DaReleaseReader,
  DaReleaseRepo,
  DaTotalsQuery,
  DaTotalsRecords,
} from '../../core/da-release-ports.js';
import type { SupplierNaming } from '../../core/supplier-naming.js';

type Db = Kysely<ProdDatabase>;

export { DA_RELEASE_SCHEMA } from './da-v3-sql.js';

const table = daV3Table;
const PURCHASES = table('da_purchases');
const PARTIES = DA_PARTIES_PUBLIC;
const RULES = table('da_value_rules');
const ITEMS = table('da_items');
const RELEASE = table('da_release');
/** `data_as_of` as fixed-width ISO UTC (the envelope's dataAsOf). */
const AS_OF_SQL = sql`to_char(max(data_as_of) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const STATEMENT_TIMEOUT_MS = 10_000;

const readError = (error: unknown): ApiError => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  // Undefined schema/table/column: the serving tables are not deployed (yet).
  if (code === '42P01' || code === '42703' || code === '3F000')
    return serviceUnavailable('Direct acquisitions release 1 tables are not deployed.');
  // Insufficient privilege: a relation or column outside the API's grant is not served.
  if (code === '42501')
    return serviceUnavailable('Direct acquisitions data is not readable by this API.');
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
  supplier_undisclosed?: boolean;
}

/** The selected columns of one public party alias, prefixed (the views carry no contacts or addresses). */
const PARTY_COLUMNS = ['name_as_written', 'fiscal_code_clean', 'fiscal_code_status'];
/**
 * A buyer is its public row. A supplier's id is the purchase's own supplier
 * party id, so a withheld supplier (no public row) still reads as a party and
 * is served withheld; `supplier_public` is D6 in SQL. A buyer is never classified.
 */
const partyColumns = (alias: 'b' | 's', columns: Columns) =>
  sql.join([
    sql`${alias === 's' ? sql`p.supplier_party_id` : sql`b.portal_party_id`} as ${sql.id(`${alias}_portal_party_id`)}`,
    ...PARTY_COLUMNS.map(
      (column) => sql`${sql.ref(`${alias}.${column}`)} as ${sql.id(`${alias}_${column}`)}`
    ),
    sql`${alias === 's' ? namedSupplier(columns) : sql`false`} as ${sql.id(`${alias}_supplier_public`)}`,
    // Naming step 2b only: before the column exists the select list is as it was.
    ...(columns.supplierDisclosed
      ? [
          sql`${alias === 's' ? undisclosedSupplierSql(columns.supplierDisclosure, true) : sql`false`} as ${sql.id(`${alias}_supplier_undisclosed`)}`,
        ]
      : []),
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
    ...(row[`${prefix}_supplier_undisclosed`] === true && { supplierUndisclosed: true }),
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
  /** `supplier_disclosure` is readable. Not: every supplier is withheld (D6 fails closed). */
  readonly supplierDisclosure: boolean;
  /**
   * `da_parties_public.supplier_disclosed` exists (naming step 2b): the gate is that column, and a
   * supplier row without it shows its code at row level only. Absent: the row is the gate.
   */
  readonly supplierDisclosed: boolean;
  /** The column's probed state, so the after-read check can see a change (see `probeRelease`). */
  readonly disclosedColumn: DisclosedColumn;
  readonly listedNow: boolean;
  /** `da_items.superseded_at`: lines the sync no longer sees; only current lines are served. */
  readonly itemSupersededAt: boolean;
  /**
   * Free text (decision 2026-11-10: restricted until the platform marks a field
   * public). Read only from the platform's `*_shown` column, and only while its
   * public flag exists too; otherwise the text is never selected and the field
   * is served withheld. Purchase descriptions are never read.
   */
  readonly titleShown: boolean;
  readonly itemNameShown: boolean;
  /** The unit is free text too (procurement-prod, 18 Nov). */
  readonly itemUnitShown: boolean;
}

/**
 * A shown free-text column: the platform's `*_shown` text, served only where
 * its row's flag is true as well (defence in depth over the platform's mask).
 */
const shownText = (present: boolean, flag: string, column: string, alias: string) =>
  present
    ? sql`case when ${sql.ref(flag)} is true then ${sql.ref(column)} end as ${sql.id(alias)}, coalesce(${sql.ref(flag)}, false) as ${sql.id(`${alias}_public`)}`
    : sql`null::text as ${sql.id(alias)}, false as ${sql.id(`${alias}_public`)}`;

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
    ${shownText(columns.titleShown, 'p.title_public', 'p.title_shown', 'title')},
    null::text as description, false as description_public,
    p.category_code, p.category_as_written, p.acquisition_type_label,
    ${partyColumns('b', columns)},
    ${partyColumns('s', columns)}
  from ${PURCHASES} p
  ${purchaseParties(true, undefined, columns.supplierDisclosed)}
  left join ${RULES} r on r.rule = p.value_review_rule`;

/**
 * The list orders, served as `finalization_day desc|asc nulls last` and `counted_value desc nulls
 * last`, purchase_id breaking every tie (pages never overlap). Each runs in two phases: the rows
 * with a key by an order an index serves, then the rows without one by purchase_id, the offset
 * carried across. A single `desc nulls last` order cannot use da_purchases_finalization_day_idx
 * (a descending scan puts nulls first), so it sorted all 22.6M purchases and timed out; phase 1
 * takes 135 ms cold (procurement-prod, prod, 22 Nov; PROC-AP75). countedValueDesc's phase 1
 * matches the (counted_value desc, purchase_id desc) where-counted index (a counted value exists
 * only when counted).
 */
const LIST_PHASES = {
  finalizationDesc: {
    keyed: sql`p.finalization_day is not null`,
    keyedOrder: sql`p.finalization_day desc, p.purchase_id desc`,
    restOrder: sql`p.purchase_id desc`,
  },
  finalizationAsc: {
    keyed: sql`p.finalization_day is not null`,
    keyedOrder: sql`p.finalization_day asc, p.purchase_id asc`,
    restOrder: sql`p.purchase_id asc`,
  },
  countedValueDesc: {
    keyed: sql`p.counted and p.counted_value is not null`,
    keyedOrder: sql`p.counted_value desc, p.purchase_id desc`,
    restOrder: sql`p.purchase_id desc`,
  },
} as const;

/** D6 in SQL, over the public supplier alias `s`: see `isNamedSupplier` in core. */
const namedSupplier = (columns: Columns) =>
  namedSupplierSql(columns.supplierDisclosure, columns.supplierDisclosed);

/** The filter's conditions over `p`, with `b` and `s` joined. */
const whereOf = (filter: DaPurchaseFilter, columns: Columns): RawBuilder<unknown> => {
  const conditions: RawBuilder<unknown>[] = [sql`true`];
  // By party ids: the planner reaches the purchases through the party index instead of
  // filtering a year of purchases on the joined party row (procurement-prod measured, 18 Nov).
  // A supplier also needs the D6 column once it exists: a row that only shows its code is never
  // a filter (naming step 2b).
  const partyIds = (kind: 'buyer' | 'supplier', column: RawBuilder<unknown>, code: string) =>
    sql`(p.source_name, ${column}) in (select pp.source_name, pp.portal_party_id from ${PARTIES} pp
        where pp.party_kind = ${kind} and pp.fiscal_code_status = 'valid' and pp.fiscal_code_clean = ${withoutLeadingZeros(code)}${
          kind === 'supplier' ? disclosedPartySql(columns.supplierDisclosed) : sql``
        })`;
  if (filter.buyerFiscalCode !== undefined)
    conditions.push(partyIds('buyer', sql`p.buyer_party_id`, filter.buyerFiscalCode));
  // The party-id match IS the D6 test: the view holds a supplier row only for a disclosed code
  // (once the D6 column exists, the subquery requires it too), and the subquery itself requires
  // fiscal_code_status = 'valid' and an equal, non-null code on the same unique party key, so no
  // row probes `s` to filter. Unreadable D6: none.
  if (filter.supplierFiscalCode !== undefined)
    conditions.push(
      columns.supplierDisclosure
        ? partyIds('supplier', sql`p.supplier_party_id`, filter.supplierFiscalCode)
        : sql`false`
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

/** Whole-table aggregates (totals): plain joins, so the view is built once per statement. */
const SCOPE_FROM = sql`
  from ${PURCHASES} p
  ${purchaseParties(false)}`;

/**
 * A list's capped count, with no party join: no filter reads the joined `b` or `s` (a party filter
 * resolves party ids through its own subquery on the public view).
 */
const COUNT_FROM = sql`
  from ${PURCHASES} p`;

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

/**
 * A summed counted value with at least cents, never rounded: purchases carry their value at the
 * scale the portal gave (a sum of `13465400.0`s prints `13465400.0`), the rollup at two decimals,
 * and both must read alike.
 */
const atLeastCents = (text: string | null): string | null => {
  if (text === null) return null;
  const value = new Decimal(text);
  return value.toFixed(Math.max(2, value.decimalPlaces()));
};

const toMeasures = (row: MeasureRow): DaTotalsRecord => ({
  countedValue: atLeastCents(row.counted_value),
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

// ── Supplier totals from the per-party rollup (PROC-AP75) ────────────────────

const SUPPLIER_PARTY_ROLLUP = table('da_rollup_supplier_party_month');
const SUPPLIER_PARTY_ROLLUP_NAME = `${DA_RELEASE_SCHEMA}.da_rollup_supplier_party_month`;
const RELEASE_NAME = `${DA_RELEASE_SCHEMA}.da_release`;

/** `YYYY-MM-DD` is the last day of its month (UTC calendar; integer arithmetic only). */
const isMonthEnd = (day: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (match === null) return false;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return new Date(Date.UTC(year, month, 0)).getUTCDate() === date;
};

/**
 * Supplier totals the per-party rollup can answer: no filter, or only a finalization range whose
 * bounds fall on month boundaries (the rollup holds months). Any other filter reads the purchases.
 */
const rollupEligible = (query: DaTotalsQuery): boolean => {
  if (query.groupBy !== 'supplier') return false;
  const { finalizationFrom, finalizationTo, ...rest } = query.filter;
  // Any other filter field set (a key present with an undefined value is no filter).
  if (Object.values(rest).some((value: unknown) => value !== undefined)) return false;
  return (
    (finalizationFrom === undefined || finalizationFrom.endsWith('-01')) &&
    (finalizationTo === undefined || isMonthEnd(finalizationTo))
  );
};

/**
 * The rollup answers only when this login can read it and the release says it was built for this
 * very publication (`supplier_party_rollup_for = data_as_of`), both read in the totals' own
 * snapshot. Otherwise the purchases answer, as before the rollup existed. The rollup holds cents
 * (numeric(20,2)) and is exact: counted_value scale ≤ 2 is enforced by
 * procurement_v3.da_purchases_counted_value_scale_check (20261121T090000, validated on prod).
 */
const rollupFresh = async (trx: Db, tableName: string, marker: string): Promise<boolean> => {
  const readable = await sql<{ usable: boolean | null }>`
    select coalesce(has_table_privilege(to_regclass(${tableName}), 'SELECT'), false)
      and case when exists (
            select 1 from pg_attribute a
            where a.attrelid = to_regclass(${RELEASE_NAME}) and a.attname = ${marker}
              and a.attnum > 0 and not a.attisdropped)
          then has_column_privilege(to_regclass(${RELEASE_NAME}), ${marker}, 'SELECT')
          else false end as usable`.execute(trx);
  if (readable.rows[0]?.usable !== true) return false;
  const fresh = await sql<{ fresh: boolean | null }>`
    select ${sql.ref(`r.${marker}`)} = r.data_as_of as fresh
    from ${RELEASE} r
    where r.data_as_of = (select max(data_as_of) from ${RELEASE})`.execute(trx);
  return fresh.rows.length === 1 && fresh.rows[0]?.fresh === true;
};

const supplierPartyRollupFresh = (trx: Db): Promise<boolean> =>
  rollupFresh(trx, SUPPLIER_PARTY_ROLLUP_NAME, 'supplier_party_rollup_for');

/**
 * The rollup's rows in the range, summed per (source_name, supplier_party_id) FIRST, as relation
 * `p` with the MEASURES of the purchases they sum; only then the supplier's public party row `s`.
 * An emptied bucket (purchases 0) is skipped; a month range matches the day range it stands for
 * (a NULL month, no finalization day, only when unbounded, as `p.finalization_day >= …` would).
 */
const rollupWhere = (filter: DaPurchaseFilter): RawBuilder<unknown> => {
  const conditions: RawBuilder<unknown>[] = [sql`r.purchases > 0`];
  if (filter.finalizationFrom !== undefined)
    conditions.push(sql`r.month >= ${filter.finalizationFrom}::date`);
  if (filter.finalizationTo !== undefined)
    conditions.push(sql`r.month <= date_trunc('month', ${filter.finalizationTo}::date)::date`);
  return sql.join(conditions, sql` and `);
};

const rollupFrom = (filter: DaPurchaseFilter): RawBuilder<unknown> => {
  return sql`
  from (select r.source_name, r.supplier_party_id,
               sum(r.counted_value) filter (where r.counted_purchases > 0) as counted_value,
               sum(r.counted_purchases) as counted_count,
               sum(r.counted_symbolic_purchases) as symbolic_price_count,
               sum(r.purchases) as purchase_count
        from ${SUPPLIER_PARTY_ROLLUP} r
        where ${rollupWhere(filter)}
        group by 1, 2) p
  left join ${PARTIES} s
    on s.source_name = p.source_name and s.party_kind = 'supplier'
   and s.portal_party_id = p.supplier_party_id`;
};

/**
 * The overall line straight from the rollup's rows: it needs no party, so no per-party sums and no
 * view join (prod, 22 Nov: 0.3 s against 2.2 s through the sums).
 */
const rollupOverall = (filter: DaPurchaseFilter): RawBuilder<unknown> => sql`
  select (sum(r.counted_value) filter (where r.counted_purchases > 0))::text as counted_value,
         coalesce(sum(r.counted_purchases), 0)::text as counted_count,
         coalesce(sum(r.counted_symbolic_purchases), 0)::text as symbolic_price_count,
         coalesce(sum(r.purchases), 0)::text as purchase_count
  from ${SUPPLIER_PARTY_ROLLUP} r
  where ${rollupWhere(filter)}`;

/** MEASURES over the per-party sums (null counted value: no counted purchase). */
const ROLLUP_MEASURES = sql`
  sum(p.counted_value)::text as counted_value,
  sum(p.counted_count)::text as counted_count,
  sum(p.symbolic_price_count)::text as symbolic_price_count,
  sum(p.purchase_count)::text as purchase_count`;

// ── Unfiltered supplier totals from the all-time per-party table (PROC-AP75) ──

const SUPPLIER_PARTY_TOTALS = table('da_rollup_supplier_party');
const SUPPLIER_PARTY_TOTALS_NAME = `${DA_RELEASE_SCHEMA}.da_rollup_supplier_party`;

/** Unfiltered supplier totals: every filter field unset. */
const unfiltered = (query: DaTotalsQuery): boolean =>
  query.groupBy === 'supplier' &&
  Object.values(query.filter).every((value: unknown) => value === undefined);

/** The all-time table answers while readable and built for this publication (same snapshot). */
const supplierPartyTotalsFresh = (trx: Db): Promise<boolean> =>
  rollupFresh(trx, SUPPLIER_PARTY_TOTALS_NAME, 'supplier_party_totals_for');

/**
 * The all-time per-party table's groups `g`, one row each: a disclosed party is its own named
 * group (keyed and ordered exactly as the purchases name it, `source_name:party id`), every other
 * party one withheld group, the purchases with no supplier one none group. `disclosed` is the D6
 * named predicate the data platform evaluated at publish (a public party row with a valid code);
 * it counts only while supplier_disclosure is readable now, else every supplier is withheld. The
 * table holds no codes: the page's parties are probed below.
 */
const allTimeGroups = (named: RawBuilder<unknown>): RawBuilder<unknown> => sql`
  with t as materialized (
    select source_name, supplier_party_id, purchases, counted_purchases, counted_value,
           counted_symbolic_purchases, ${named} as named
    from ${SUPPLIER_PARTY_TOTALS} where purchases > 0),
  g as (
    select source_name || ':' || supplier_party_id as group_key, 'named'::text as g_bucket,
           source_name, supplier_party_id,
           case when counted_purchases > 0 then counted_value end as counted_value,
           counted_purchases as counted_count, counted_symbolic_purchases as symbolic_price_count,
           purchases as purchase_count
    from t where named and supplier_party_id is not null
    union all
    select null, 'withheld', null, null,
           sum(counted_value) filter (where counted_purchases > 0), sum(counted_purchases),
           sum(counted_symbolic_purchases), sum(purchases)
    from t where not named and supplier_party_id is not null having count(*) > 0
    union all
    select null, 'none', null, null,
           sum(counted_value) filter (where counted_purchases > 0), sum(counted_purchases),
           sum(counted_symbolic_purchases), sum(purchases)
    from t where supplier_party_id is null having count(*) > 0)`;

/** The groups' order, on relation `alias`'s numeric columns (never a text alias of the select). */
const allTimeOrder = (alias: string): RawBuilder<unknown> => {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql`${column('counted_value')} desc nulls last, ${column('purchase_count')} desc,
    ${column('group_key')} asc nulls last, ${column('g_bucket')} asc nulls last`;
};

/** One page of the all-time groups, each named one with its public party row (fenced probe). */
const allTimePage = (
  named: RawBuilder<unknown>,
  limit: number,
  offset: number,
  disclosedColumn: boolean
): RawBuilder<unknown> => sql`
  ${allTimeGroups(named)},
  page as (select * from g order by ${allTimeOrder('g')} limit ${limit} offset ${offset})
  select page.group_key, page.g_bucket,
         s.portal_party_id as g_portal_party_id, s.name_as_written as g_name_as_written,
         s.fiscal_code_clean as g_fiscal_code_clean, s.fiscal_code_status as g_fiscal_code_status,
         page.g_bucket = 'named' as g_supplier_public,
         page.counted_value::text as counted_value, page.counted_count::text as counted_count,
         page.symbolic_price_count::text as symbolic_price_count,
         page.purchase_count::text as purchase_count,
         (select count(*) from g)::text as group_count
  from page
  left join lateral (
    select x.portal_party_id, x.name_as_written, x.fiscal_code_clean, x.fiscal_code_status
    from ${PARTIES} x
    where page.g_bucket = 'named' and x.source_name = page.source_name
      and x.party_kind = 'supplier' and x.portal_party_id = page.supplier_party_id${
        // A party the table calls disclosed but the view's gate does not: no row, so refused.
        disclosedColumn ? sql` and x.supplier_disclosed is true` : sql``
      }
    offset 0) s on true
  order by ${allTimeOrder('page')}`;

/** The overall line straight from the all-time table. */
const ALL_TIME_OVERALL = sql`
  select (sum(counted_value) filter (where counted_purchases > 0))::text as counted_value,
         coalesce(sum(counted_purchases), 0)::text as counted_count,
         coalesce(sum(counted_symbolic_purchases), 0)::text as symbolic_price_count,
         coalesce(sum(purchases), 0)::text as purchase_count
  from ${SUPPLIER_PARTY_TOTALS} where purchases > 0`;

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
          case when p.supplier_party_id is null then 'none' when ${named} then 'named' else 'withheld' end as g_bucket,
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

// ── Supplier names ───────────────────────────────────────────────────────────

/**
 * A disclosed supplier's naming (`supplierNamesByCode`: the names view when this
 * login may read it, else its public registry name), read by code after the page
 * (the public party view carries no supplier name). A withheld supplier is
 * untouched: the core serves it with no name anyway.
 */
/** Every requested code has an entry; a missing one fails closed (code only). */
const nameSupplier = (party: DaPartyRecord, naming: SupplierNaming | undefined): DaPartyRecord => {
  const served = naming ?? { kind: 'code_only', name: null };
  return { ...party, name: served.name, naming: served };
};

const withSupplierNames = async <T>(
  trx: Db,
  items: readonly T[],
  supplierOf: (item: T) => DaPartyRecord | null,
  withSupplier: (item: T, supplier: DaPartyRecord) => T
): Promise<Result<T[], ApiError>> => {
  const named = (item: T): DaPartyRecord | null => {
    const party = supplierOf(item);
    return party !== null && (isNamedSupplier(party) || party.supplierUndisclosed === true)
      ? party
      : null;
  };
  const codes = items.flatMap((item) => named(item)?.fiscalCode ?? []);
  if (codes.length === 0) return ok([...items]);
  const names = await attempt(() => supplierNamesByCode(trx, codes));
  if (names.isErr()) return err(names.error);
  return ok(
    items.map((item) => {
      const party = named(item);
      const code = party?.fiscalCode ?? null;
      return party === null || code === null
        ? item
        : withSupplier(item, nameSupplier(party, names.value.get(code)));
    })
  );
};

const namePurchases = (trx: Db, rows: readonly DaPurchaseRecord[]) =>
  withSupplierNames(
    trx,
    rows,
    (row) => row.supplier,
    (row, supplier) => ({ ...row, supplier })
  );

// ── Reader ───────────────────────────────────────────────────────────────────

/**
 * Unfiltered supplier totals from the all-time table, in the totals' snapshot. A named group on
 * the page whose public party row is missing or no longer names it (never within one publication)
 * refuses the answer as retryable: it is never served partly named.
 */
const allTimeSupplierTotals = async (
  trx: Db,
  columns: Columns,
  query: DaTotalsQuery
): Promise<Result<DaTotalsRecords, ApiError>> => {
  const named = columns.supplierDisclosure ? sql`disclosed` : sql`false`;
  const overall = await attempt(
    async () => (await sql<MeasureRow>`${ALL_TIME_OVERALL}`.execute(trx)).rows[0]
  );
  if (overall.isErr()) return err(overall.error);
  if (overall.value === undefined)
    return err(databaseError('Direct acquisitions total returned no row.'));
  const page = await attempt(
    async () =>
      (
        await sql<GroupRow>`${allTimePage(named, query.pageSize, offsetFor(query), columns.supplierDisclosed)}`.execute(
          trx
        )
      ).rows
  );
  if (page.isErr()) return err(page.error);
  const unnamed = page.value.some(
    (row) =>
      row.g_bucket === 'named' &&
      (row.g_portal_party_id === null ||
        row.g_fiscal_code_status !== 'valid' ||
        row.g_fiscal_code_clean === null)
  );
  if (unnamed) return err(REPUBLISHED());
  let groupCount = page.value[0]?.group_count;
  if (groupCount === undefined) {
    // A page past the end still reports how many groups exist.
    const counted = await attempt(
      async () =>
        (
          await sql<{ total: string }>`
            ${allTimeGroups(named)}
            select count(*)::text as total from g`.execute(trx)
        ).rows[0]?.total
    );
    if (counted.isErr()) return err(counted.error);
    groupCount = counted.value ?? '0';
  }
  const count = exactCount(groupCount);
  if (count.isErr()) return err(count.error);
  const groups = await withSupplierNames(
    trx,
    page.value.map((row) => toGroupRecord(row, 'supplier')),
    (group) => group.party,
    (group, party) => ({ ...group, party })
  );
  if (groups.isErr()) return err(groups.error);
  return ok({ overall: toMeasures(overall.value), groups: groups.value, groupCount: count.value });
};

const makeReader = (trx: Db, columns: Columns): DaReleaseReader => ({
  dataAsOf: () =>
    attempt(async () => {
      const result = await sql<{ data_as_of: string | null }>`
        select ${AS_OF_SQL} as data_as_of
        from ${RELEASE}`.execute(trx);
      return result.rows[0]?.data_as_of ?? null;
    }),

  supplierPrivacyTable: () => columns.supplierDisclosure,

  listPurchases: async (query) => {
    const where = whereOf(query.filter, columns);
    const offset = offsetFor(query);
    const limit = Math.max(0, Math.min(query.pageSize, DA_LIST_MAX_DEPTH - offset));
    const phases = LIST_PHASES[query.sort];
    const page = (
      extra: RawBuilder<unknown>,
      order: RawBuilder<unknown>,
      n: number,
      skip: number
    ) =>
      sql<PurchaseRow>`
            ${purchaseSelect(columns)}
            where ${where} and ${extra}
            order by ${order}
            limit ${n}
            offset ${skip}`.execute(trx);
    const rows = await attempt(async () => {
      const keyed = (await page(phases.keyed, phases.keyedOrder, limit, offset)).rows;
      if (keyed.length >= limit) return keyed;
      // The keyed rows before this page: exactly offset + what it read, unless it read none, then
      // counted (capped at the offset, all the carry needs), with no party join: a party filter
      // resolves party ids through its own subquery on the public view.
      let before = offset + keyed.length;
      if (keyed.length === 0 && offset > 0) {
        const n = await sql<{ n: string }>`
            select count(*)::text as n from (
              select 1 ${COUNT_FROM} where ${where} and ${phases.keyed} limit ${offset}
            ) as capped`.execute(trx);
        before = Number(n.rows[0]?.n ?? '0');
      }
      const rest = (
        await page(
          sql`not (${phases.keyed})`,
          phases.restOrder,
          limit - keyed.length,
          Math.max(0, offset - before)
        )
      ).rows;
      return [...keyed, ...rest];
    });
    if (rows.isErr()) return err(rows.error);
    const counted = await attempt(
      async () =>
        (
          await sql<{ total: string }>`
            select count(*)::text as total from (
              select 1 ${COUNT_FROM} where ${where} limit ${DA_LIST_MAX_DEPTH + 1}
            ) as capped`.execute(trx)
        ).rows[0]?.total
    );
    if (counted.isErr()) return err(counted.error);
    const total = exactCount(counted.value);
    if (total.isErr()) return err(total.error);
    const capped = total.value > DA_LIST_MAX_DEPTH;
    const named = await namePurchases(trx, rows.value.map(toPurchaseRecord));
    if (named.isErr()) return err(named.error);
    return ok({
      rows: named.value,
      total: capped ? DA_LIST_MAX_DEPTH : total.value,
      capped,
    });
  },

  purchaseById: async (purchaseId) => {
    const found = await attempt(async () => {
      const result = await sql<PurchaseRow>`
        ${purchaseSelect(columns)}
        where p.purchase_id = ${purchaseId}
        limit 1`.execute(trx);
      const row = result.rows[0];
      return row === undefined ? null : toPurchaseRecord(row);
    });
    if (found.isErr() || found.value === null) return found;
    const named = await namePurchases(trx, [found.value]);
    return named.map((rows) => rows[0] ?? null);
  },

  itemsOf: (purchaseId) =>
    attempt(async () => {
      const result = await sql<{
        item_index: number;
        name: string | null;
        name_public: boolean;
        unit: string | null;
        unit_public: boolean;
        quantity: string | null;
        requested_quantity: string | null;
        unit_price: string | null;
        catalogue_price: string | null;
        reported_line_value: string | null;
        supplier_rejected: boolean | null;
        quantity_correction: boolean | null;
      }>`
        select i.item_index,
               ${shownText(columns.itemNameShown, 'i.item_name_public', 'i.item_name_shown', 'name')},
               ${shownText(columns.itemUnitShown, 'i.item_unit_public', 'i.item_unit_shown', 'unit')},
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
        unitPublic: row.unit_public,
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
    // PROC-AP75: unfiltered supplier totals from the all-time per-party table when it was built
    // for this publication; else the per-month rollup (no filter, or a month-aligned range);
    // otherwise the purchases, as before.
    if (unfiltered(query)) {
      const allTime = await attempt(() => supplierPartyTotalsFresh(trx));
      if (allTime.isErr()) return err(allTime.error);
      if (allTime.value) return allTimeSupplierTotals(trx, columns, query);
    }
    const fromRollup = rollupEligible(query)
      ? await attempt(() => supplierPartyRollupFresh(trx))
      : ok(false);
    if (fromRollup.isErr()) return err(fromRollup.error);
    const viaRollup = fromRollup.value;
    const from = viaRollup ? rollupFrom(query.filter) : SCOPE_FROM;
    const where = viaRollup ? sql`true` : whereOf(query.filter, columns);
    const measures = viaRollup ? ROLLUP_MEASURES : MEASURES;
    const overall = await attempt(
      async () =>
        (
          await (
            viaRollup
              ? sql<MeasureRow>`${rollupOverall(query.filter)}`
              : sql<MeasureRow>`select ${MEASURES} ${SCOPE_FROM} where ${where}`
          ).execute(trx)
        ).rows[0]
    );
    if (overall.isErr()) return err(overall.error);
    if (overall.value === undefined)
      return err(databaseError('Direct acquisitions total returned no row.'));
    if (query.groupBy === null)
      return ok({ overall: toMeasures(overall.value), groups: [], groupCount: 0 });

    const groupBy = query.groupBy;
    const { select, width, byValue } = groupSelect(groupBy, columns);
    const order = !byValue
      ? sql`group_key asc nulls last`
      : viaRollup
        ? sql`sum(p.counted_value) desc nulls last, sum(p.purchase_count) desc, group_key asc nulls last, g_bucket asc nulls last`
        : sql`sum(p.counted_value) filter (where p.counted) desc nulls last, count(*) desc, group_key asc nulls last, g_bucket asc nulls last`;
    const grouped = await attempt(
      async () =>
        (
          await sql<GroupRow>`
            select ${select}, ${measures}, count(*) over ()::text as group_count
            ${from}
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
                select ${select} ${from} where ${where} group by ${groupByPositions(width)}
              ) as g`.execute(trx)
          ).rows[0]?.total
      );
      if (counted.isErr()) return err(counted.error);
      groupCount = counted.value ?? '0';
    }
    const count = exactCount(groupCount);
    if (count.isErr()) return err(count.error);
    const groups = await withSupplierNames(
      trx,
      grouped.value.map((row) => toGroupRecord(row, groupBy)),
      (group) => (groupBy === 'supplier' ? group.party : null),
      (group, party) => ({ ...group, party })
    );
    if (groups.isErr()) return err(groups.error);
    return ok({
      overall: toMeasures(overall.value),
      groups: groups.value,
      groupCount: count.value,
    });
  },
});

/** The pending contract columns, each probed per snapshot: (table, column) → Columns key. */
const PENDING_COLUMNS = [
  ['da_purchases', 'listed_now', 'listedNow'],
  ['da_items', 'superseded_at', 'itemSupersededAt'],
  ['da_purchases', 'title_shown', 'titleShown'],
  ['da_purchases', 'title_public', 'titleShown'],
  ['da_items', 'item_name_shown', 'itemNameShown'],
  ['da_items', 'item_name_public', 'itemNameShown'],
  ['da_items', 'item_unit_shown', 'itemUnitShown'],
  ['da_items', 'item_unit_public', 'itemUnitShown'],
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
  // A key is present only when EVERY column it needs is (a shown text needs its flag too).
  const has = (key: keyof Columns): boolean =>
    PENDING_COLUMNS.filter(([, , k]) => k === key).every(([table, column]) =>
      present.has(`${table}.${column}`)
    );
  const disclosedColumn = await probeSupplierDisclosedColumn(trx);
  // An unreadable gate column withholds every supplier (never the row-presence rule).
  const supplierDisclosure = disclosedColumn !== 'denied' && (await probeSupplierDisclosure(trx));
  return {
    supplierDisclosure,
    listedNow: has('listedNow'),
    itemSupersededAt: has('itemSupersededAt'),
    titleShown: has('titleShown'),
    itemNameShown: has('itemNameShown'),
    itemUnitShown: has('itemUnitShown'),
    supplierDisclosed: disclosedColumn === 'readable',
    disclosedColumn,
  };
};

const disabled = (): ApiError =>
  serviceUnavailable('Direct acquisitions release 1 is not enabled on this server.');

const REPUBLISHED = (): ApiError =>
  serviceUnavailable(
    'direct-acquisition data was republished during this request; repeat the request'
  );

/**
 * The release, the supplier_disclosure grant and the D6 column's state RIGHT NOW, in one
 * statement. D6 is readable only with the grant and a column that is absent or readable.
 */
const probeRelease = async (
  db: Db
): Promise<{
  readonly asOf: string | null;
  readonly privacy: boolean;
  readonly column: DisclosedColumn;
}> => {
  const result = await sql<{
    as_of: string | null;
    privacy: boolean | null;
    disclosed_column: string | null;
  }>`
    select ${AS_OF_SQL} as as_of,
           coalesce(
             has_table_privilege(to_regclass(${SUPPLIER_DISCLOSURE_NAME}), 'SELECT'),
             false
           ) as privacy,
           ${DISCLOSED_COLUMN_STATE_SQL} as disclosed_column
    from ${RELEASE}`.execute(db);
  const row = result.rows[0];
  const column = disclosedColumnOf(row?.disclosed_column);
  return {
    asOf: row?.as_of ?? null,
    privacy: row?.privacy === true && column !== 'denied',
    column,
  };
};

export const makeDaReleaseRepo = (db: Db, enabled: boolean): DaReleaseRepo => ({
  enabled,
  snapshot: async (read, options) => {
    if (!enabled) return err(disabled());
    try {
      const seen = {
        asOf: null as string | null,
        privacy: false,
        column: 'absent' as DisclosedColumn,
      };
      const result = await db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (trx) => {
          await sql`set transaction read only`.execute(trx);
          await sql`set local statement_timeout = ${sql.lit(STATEMENT_TIMEOUT_MS)}`.execute(trx);
          const columns = await probeColumns(trx);
          if (options?.settle === true) {
            const release = await sql<{ as_of: string | null }>`
              select ${AS_OF_SQL} as as_of from ${RELEASE}`.execute(trx);
            seen.asOf = release.rows[0]?.as_of ?? null;
            seen.privacy = columns.supplierDisclosure;
            seen.column = columns.disclosedColumn;
          }
          return read(makeReader(trx, columns));
        });
      if (options?.settle !== true || result.isErr()) return result;
      const now = await probeRelease(db);
      // A D6 column that appeared, went or changed grant during the read: repeat the request.
      return now.asOf === seen.asOf && (now.privacy || !seen.privacy) && now.column === seen.column
        ? result
        : err(REPUBLISHED());
    } catch (error) {
      return err(readError(error));
    }
  },
});
