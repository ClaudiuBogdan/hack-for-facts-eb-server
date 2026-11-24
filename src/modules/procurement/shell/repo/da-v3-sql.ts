/**
 * Direct acquisitions release 1 — the SQL pieces every procurement_v3 reader
 * shares, so the supplier rule (D6, site-wide) exists in ONE place.
 *
 * The API reads parties and the D6 publication only through the data
 * platform's public views (SEC-GRANTS-PROC-2211, owner-approved 2026-11-22):
 * - `da_parties_public`: every buyer, and a supplier only when its code is
 *   disclosed (its `name_as_written` is NULL; names come from
 *   `party_public_names` by code). A purchase whose supplier party id is set
 *   but has no row here has a withheld supplier.
 * - `supplier_disclosure` (fiscal_code_clean, supplier_id): the disclosed
 *   (public company) suppliers; every row is public, so no predicate.
 *
 * D6: a supplier is named only when its public party row is present (and,
 * defensively, its code valid and present) AND `supplier_disclosure` is
 * readable in this snapshot. Without that grant the predicate is constant
 * false: every supplier is withheld (fails closed). The core re-checks every
 * party it serves (`isNamedSupplier`).
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';

import {
  namingFromRegistry,
  namingFromView,
  type SupplierNaming,
  type SupplierNamesViewRow,
} from '../../core/supplier-naming.js';

import type { ProdDatabase } from '@/modules/shared/index.js';

/** The serving schema. */
export const DA_RELEASE_SCHEMA = 'procurement_v3';

export const daV3Table = (name: string) => sql.table(`${DA_RELEASE_SCHEMA}.${name}`);

/** Buyers, and disclosed suppliers only (`name_as_written` NULL for suppliers). */
export const DA_PARTIES_PUBLIC = daV3Table('da_parties_public');
/** The disclosed suppliers: (fiscal_code_clean, supplier_id). */
export const SUPPLIER_DISCLOSURE = daV3Table('supplier_disclosure');
/** The view the D6 probes check (unqualified name, for `to_regclass`). */
export const SUPPLIER_DISCLOSURE_NAME = `${DA_RELEASE_SCHEMA}.supplier_disclosure`;
const PUBLIC_NAMES = daV3Table('party_public_names');

/**
 * One public party per purchase row (`b` buyer, `s` supplier), for point reads: list pages, detail,
 * lookups, records pages. A plain join into the security-barrier view is not pushed into it, so
 * every query would build the whole view (procurement-prod, EXPLAIN ANALYZE on prod, 22 Nov: a
 * list page of 100 took 1,482 ms). A lateral probe fenced with `offset 0` lets the planner probe
 * the view's keys per row instead (22 ms; a lookup 0.23 ms). The fence is a planner hint only: the
 * barrier still filters first. Whole-table aggregates keep the plain joins (`purchaseParties(false)`).
 */
export const publicPartyLateral = (
  alias: 'b' | 's',
  kind: 'buyer' | 'supplier',
  partyId: RawBuilder<unknown>
): RawBuilder<unknown> => sql`left join lateral (
    select x.source_name, x.portal_party_id, x.name_as_written, x.fiscal_code_clean, x.fiscal_code_status
    from ${DA_PARTIES_PUBLIC} x
    where x.source_name = p.source_name and x.party_kind = ${sql.lit(kind)}
      and x.portal_party_id = ${partyId}
    offset 0) ${sql.id(alias)} on true`;

/** The plain join of purchase `p`'s buyer `b`, for whole-table aggregates. */
const PLAIN_BUYER_JOIN = sql`left join ${DA_PARTIES_PUBLIC} b
    on b.source_name = p.source_name and b.party_kind = 'buyer'
   and b.portal_party_id = p.buyer_party_id`;
/** The plain join of purchase `p`'s supplier `s`, for whole-table aggregates. */
const PLAIN_SUPPLIER_JOIN = sql`left join ${DA_PARTIES_PUBLIC} s
    on s.source_name = p.source_name and s.party_kind = 'supplier'
   and s.portal_party_id = p.supplier_party_id`;

/** Which of purchase `p`'s parties an aggregate reads (a party is at most one row: see below). */
export interface PartyJoins {
  readonly buyer: boolean;
  readonly supplier: boolean;
}

/**
 * Buyer `b` and supplier `s` of purchase `p`: fenced lateral probes (both), or plain joins of the
 * parties an aggregate reads. A left join on the view's unique party key (source_name,
 * party_kind, portal_party_id) adds at most one row per purchase, so leaving out a party nothing
 * reads changes no count or sum; it only spares hashing the view (PROC buyer x CPV, 23 Nov).
 */
export const purchaseParties = (
  lateral: boolean,
  joins: PartyJoins = { buyer: true, supplier: true }
): RawBuilder<unknown> =>
  lateral
    ? sql`${publicPartyLateral('b', 'buyer', sql`p.buyer_party_id`)}
  ${publicPartyLateral('s', 'supplier', sql`p.supplier_party_id`)}`
    : sql`${joins.buyer ? PLAIN_BUYER_JOIN : sql``}
  ${joins.supplier ? PLAIN_SUPPLIER_JOIN : sql``}`;

/** The supplier party alias `s` (from `da_parties_public`) names its supplier: see `isNamedSupplier`. */
export const namedSupplierSql = (present: boolean): RawBuilder<unknown> =>
  present
    ? sql`(s.portal_party_id is not null and s.fiscal_code_status = 'valid' and s.fiscal_code_clean is not null)`
    : sql`false`;

/**
 * Whether `supplier_disclosure` exists AND this login may read it (a revoked
 * grant leaves the catalog entry in place). Not readable: every supplier is withheld.
 */
export const probeSupplierDisclosure = async (trx: Kysely<ProdDatabase>): Promise<boolean> => {
  const result = await sql<{ present: boolean }>`
    select coalesce(
      has_table_privilege(to_regclass(${SUPPLIER_DISCLOSURE_NAME}), 'SELECT'),
      false
    ) as present`.execute(trx);
  return result.rows[0]?.present === true;
};

/** Codes per name statement (a page holds at most a few hundred). */
const NAME_LOOKUP_CHUNK = 500;

/** Naming step 2: the names view the owner grants to the API (`supplier_names_public`). */
const SUPPLIER_NAMES = daV3Table('supplier_names_public');
export const SUPPLIER_NAMES_NAME = `${DA_RELEASE_SCHEMA}.supplier_names_public`;

/** Whether this login may read the names view: table-level SELECT, as for supplier_disclosure. */
const probeSupplierNames = async (trx: Kysely<ProdDatabase>): Promise<boolean> => {
  const result = await sql<{ names_readable: boolean }>`
    select coalesce(
      has_table_privilege(to_regclass(${SUPPLIER_NAMES_NAME}), 'SELECT'),
      false
    ) as names_readable`.execute(trx);
  return result.rows[0]?.names_readable === true;
};

/**
 * How each of these DISCLOSED supplier codes is named, by code only (never a join
 * or a scan: each view is fenced by `fiscal_code_clean = any($1)`). Every code
 * gets an entry. With `supplier_names_public` readable (probed in this
 * transaction, never cached): its naming, a code with no row being code only.
 * Without it, as before naming step 2: a company, named by its public registry
 * name (`party_public_names`) or with no name. See `core/supplier-naming.ts`.
 */
export const supplierNamesByCode = async (
  trx: Kysely<ProdDatabase>,
  codes: readonly string[]
): Promise<ReadonlyMap<string, SupplierNaming>> => {
  const unique = [...new Set(codes)];
  const names = new Map<string, SupplierNaming>();
  if (unique.length === 0) return names;
  const viewReadable = await probeSupplierNames(trx);
  for (let start = 0; start < unique.length; start += NAME_LOOKUP_CHUNK) {
    const chunk = unique.slice(start, start + NAME_LOOKUP_CHUNK);
    if (viewReadable) {
      const result = await sql<{
        code: string;
        naming: string | null;
        display_name: string | null;
        code_shown: boolean | null;
      }>`
        select v.fiscal_code_clean as code, v.naming, v.display_name, v.code_shown
        from ${SUPPLIER_NAMES} v
        where v.fiscal_code_clean = any(${chunk}::text[])`.execute(trx);
      const rows = new Map<string, SupplierNamesViewRow>();
      // One row per code in the view; should two ever come back, the stricter (any not
      // showing its code, else any not named) wins.
      for (const row of result.rows) {
        const next: SupplierNamesViewRow = {
          naming: row.naming,
          displayName: row.display_name,
          codeShown: row.code_shown,
        };
        const prior = rows.get(row.code);
        rows.set(row.code, prior === undefined ? next : stricterRow(prior, next));
      }
      for (const code of chunk) names.set(code, namingFromView(rows.get(code)));
    } else {
      const result = await sql<{ code: string; name: string | null }>`
        select n.fiscal_code_clean as code, n.registry_name as name
        from ${PUBLIC_NAMES} n
        where n.fiscal_code_clean = any(${chunk}::text[]) and n.supplier_name_public is true`.execute(
        trx
      );
      const registry = new Map<string, string>();
      for (const row of result.rows) if (row.name !== null) registry.set(row.code, row.name);
      for (const code of chunk) names.set(code, namingFromRegistry(registry.get(code)));
    }
  }
  return names;
};

const RANK: Record<string, number> = { hidden: 0, code_only: 1, person_masked: 2, company: 3 };
const stricterRow = (a: SupplierNamesViewRow, b: SupplierNamesViewRow): SupplierNamesViewRow =>
  (RANK[namingFromView(a).kind] ?? 0) <= (RANK[namingFromView(b).kind] ?? 0) ? a : b;
