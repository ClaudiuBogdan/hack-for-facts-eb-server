/**
 * Totals v2 reader (docs/server-redesign/10-public-contracts-totals-v2.md,
 * schema: scrapper PROCUREMENT_MONEY_FACTS.md draft 2).
 *
 * - The active money build comes from Postgres `procurement_v3.money_generations`
 *   (status 'active'), a pointer separate from the legacy analysis one. An
 *   absent table or no active row means "not published": fail closed.
 * - Facts, suppliers and labels are read from that build's own ClickHouse
 *   tables (`money_*_b<build_id>`), through the process-wide reader, so the
 *   per-pod cap covers these reads too.
 * - Money is integer bani (`amount_bani` Int64), summed exactly in ClickHouse
 *   and carried as decimal strings; `native_amount` (Decimal(20,2)) is summed
 *   in minor units for currency subtotals.
 * - Labels are immutable per build: cached per build id.
 */

import { Type } from '@sinclair/typebox';
import { sql, type Kysely } from 'kysely';
import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  serviceUnavailable,
  type ApiError,
  type ProdDatabase,
} from '@/modules/shared/index.js';

import { DA_RELEASE_SCHEMA } from './da-v3-sql.js';

import type { ClickhouseReader } from './clickhouse-reader.js';
import type {
  AggregateFilters,
  FactAggregate,
  FactStatus,
  MoneyLabel,
  MoneyTotalsPort,
  ValueKind,
  VatBasis,
} from '../../core/money-totals.js';

const BUILD_ID = /^[1-9][0-9]{0,18}$/u;

/** A ClickHouse string literal (single quotes and backslashes escaped). */
const lit = (value: string): string => `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
const litList = (values: readonly string[]): string => values.map(lit).join(', ');

const tableOf = (base: string, build: string): string => `${base}_b${build}`;

/**
 * A build table that is gone (ClickHouse UNKNOWN_TABLE 60 / UNKNOWN_DATABASE 81)
 * means the build is not served: ServiceUnavailable, never a guessed total.
 */
const notServed = <T>(result: Result<T, ApiError>): Result<T, ApiError> =>
  result.isErr() &&
  result.error.type === 'Database' &&
  /\(code (60|81)\)/u.test(result.error.message)
    ? err(serviceUnavailable('the active money build is not available; retry later'))
    : result;

const CountString = Type.String({ pattern: '^[0-9]+$' });
const IntegerString = Type.String({ pattern: '^-?[0-9]+$' });
const Flag01 = Type.Union([Type.Literal('0'), Type.Literal('1')]);

const AggregateRowSchema = Type.Object(
  {
    value_kind: Type.String(),
    status: Type.String(),
    additive: Flag01,
    dated: Flag01,
    has_amount: Flag01,
    joint_win: Flag01,
    vat_basis: Type.String(),
    currency: Type.Union([Type.String(), Type.Null()]),
    unverified_head: Flag01,
    list_value: Flag01,
    withheld_supplier: Flag01,
    n: CountString,
    sum_bani: IntegerString,
    native_minor: IntegerString,
  },
  { additionalProperties: false }
);

const LabelRowSchema = Type.Object(
  {
    label_set: Type.String(),
    key: Type.String(),
    label_ro: Type.String(),
    label_en: Type.String(),
    meaning_ro: Type.String(),
    meaning_en: Type.String(),
  },
  { additionalProperties: false }
);

const SupplierRowSchema = Type.Object({ ref: Type.String() }, { additionalProperties: false });

/** The WHERE for one aggregate read: every non-status filter, undated rows admitted. */
export const moneyWhere = (
  filters: AggregateFilters,
  supplierRef: string | null,
  valueKinds: readonly ValueKind[]
): string => {
  const conds = [
    `procurement_kind IN (${litList(filters.procurementKinds)})`,
    `value_kind IN (${litList(valueKinds)})`,
  ];
  if (filters.contractKinds !== null) {
    conds.push(`contract_kind IN (${litList(filters.contractKinds)})`);
  }
  if (filters.from !== null || filters.to !== null) {
    // Undated rows stay in the population: they are the `undated` exclusion.
    const range = [
      ...(filters.from === null ? [] : [`award_day >= toDate(${lit(filters.from)})`]),
      ...(filters.to === null ? [] : [`award_day <= toDate(${lit(filters.to)})`]),
    ].join(' AND ');
    conds.push(`(award_day IS NULL OR (${range}))`);
  }
  if (filters.buyerCode !== null) conds.push(`buyer_code = ${lit(filters.buyerCode)}`);
  if (supplierRef !== null) conds.push(`has(supplier_refs, ${lit(supplierRef)})`);
  if (filters.cpvPrefix !== null) {
    conds.push(`startsWith(ifNull(cpv_code, ''), ${lit(filters.cpvPrefix)})`);
  }
  if (filters.countyCode !== null) {
    conds.push(`buyer_county_code = ${lit(filters.countyCode)}`);
  }
  if (filters.siruta !== null) conds.push(`toString(buyer_siruta) = ${lit(filters.siruta)}`);
  if (filters.vatBases !== null) conds.push(`vat_basis IN (${litList(filters.vatBases)})`);
  if (filters.q !== null) {
    conds.push(`positionCaseInsensitiveUTF8(ifNull(title_shown, ''), ${lit(filters.q)}) > 0`);
  }
  return conds.join(' AND ');
};

export const makeClickhouseMoneyRepo = (deps: {
  readonly db: Kysely<ProdDatabase>;
  readonly reader: ClickhouseReader;
}): MoneyTotalsPort => {
  const labelsByBuild = new Map<string, readonly MoneyLabel[]>();

  return {
    activeBuild: async () => {
      try {
        const result = await sql<{ build_id: string | null }>`
          select case
            when to_regclass(${`${DA_RELEASE_SCHEMA}.money_generations`}) is null then null
            else (select g.build_id::text
                    from procurement_v3.money_generations g
                   where g.status = 'active'
                   order by g.published_at desc
                   limit 1)
          end as build_id`.execute(deps.db);
        const build = result.rows[0]?.build_id ?? null;
        if (build === null) return ok(null);
        return BUILD_ID.test(build)
          ? ok(build)
          : err(databaseError('the active money build id is malformed'));
      } catch (error) {
        // The table arrives in a later migration (undefined_table, 42P01): until
        // then nothing is published. Any other failure is a failure.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '42P01'
        ) {
          return ok(null);
        }
        return err(databaseError('money generation read failed', error));
      }
    },

    labels: async (build) => {
      const cached = labelsByBuild.get(build);
      if (cached !== undefined) return ok(cached);
      const rows = notServed(
        await deps.reader.query(
          `SELECT label_set, key, label_ro, label_en, meaning_ro, meaning_en FROM ${tableOf('money_labels', build)}`,
          LabelRowSchema
        )
      );
      if (rows.isErr()) return err(rows.error);
      const labels = rows.value.map((row) => ({
        labelSet: row.label_set,
        key: row.key,
        labelRo: row.label_ro,
        labelEn: row.label_en,
        meaningRo: row.meaning_ro,
        meaningEn: row.meaning_en,
      }));
      labelsByBuild.set(build, labels);
      return ok(labels);
    },

    supplierRef: async (build, supplierCode) => {
      // toString: the scalar ref's ClickHouse type is not pinned by the contract.
      const rows = notServed(
        await deps.reader.query(
          `SELECT toString(supplier_ref) AS ref FROM ${tableOf('money_suppliers', build)} WHERE supplier_cui = ${lit(supplierCode)} AND toString(supplier_ref) != '0' LIMIT 1`,
          SupplierRowSchema
        )
      );
      return rows.map((value) => value[0]?.ref ?? null);
    },

    aggregate: async (build, filters, supplierRef, valueKinds) => {
      const rows = notServed(
        await deps.reader.query(
          `SELECT
           value_kind,
           status,
           toString(toUInt8(additive)) AS additive,
           toString(toUInt8(award_day IS NOT NULL)) AS dated,
           toString(toUInt8(amount_bani IS NOT NULL)) AS has_amount,
           toString(toUInt8(has(flags, 'joint_win'))) AS joint_win,
           vat_basis,
           currency,
           toString(toUInt8(ifNull(ca_head_status, '') = 'unverified')) AS unverified_head,
           toString(toUInt8(has(flags, 'list_value'))) AS list_value,
           toString(toUInt8(ifNull(toString(supplier_ref), '') = '0')) AS withheld_supplier,
           toString(count()) AS n,
           toString(sum(toInt128(ifNull(amount_bani, 0)))) AS sum_bani,
           toString(sum(toInt128(ifNull(native_amount, toDecimal64(0, 2)) * 100))) AS native_minor
         FROM ${tableOf('money_facts', build)}
         WHERE ${moneyWhere(filters, supplierRef, valueKinds)}
         GROUP BY value_kind, status, additive, dated, has_amount, joint_win, vat_basis, currency,
                  unverified_head, list_value, withheld_supplier`,
          AggregateRowSchema
        )
      );
      if (rows.isErr()) return err(rows.error);
      const out: FactAggregate[] = [];
      for (const row of rows.value) {
        const dated = row.dated === '1';
        out.push({
          valueKind: row.value_kind as ValueKind,
          status: row.status as FactStatus,
          additive: row.additive === '1',
          dated,
          // The WHERE admits only in-range or undated rows.
          inRange: dated,
          hasAmount: row.has_amount === '1',
          jointWin: row.joint_win === '1',
          vatBasis: (['excluded', 'included'].includes(row.vat_basis)
            ? row.vat_basis
            : 'unknown') as VatBasis,
          currency: row.currency,
          unverifiedHead: row.unverified_head === '1',
          listValue: row.list_value === '1',
          withheldSupplier: row.withheld_supplier === '1',
          count: BigInt(row.n),
          sumBani: BigInt(row.sum_bani),
          nativeSumMinor: BigInt(row.native_minor),
        });
      }
      return ok(out);
    },
  };
};
