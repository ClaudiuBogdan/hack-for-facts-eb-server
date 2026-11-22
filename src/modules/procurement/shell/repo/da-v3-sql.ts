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

/**
 * The public registry names of these supplier codes, by code only (never a
 * join or a scan: the view is fenced by `fiscal_code_clean = any($1)`). A code
 * whose supplier name is not public, or that has no registry row, is absent.
 */
export const supplierNamesByCode = async (
  trx: Kysely<ProdDatabase>,
  codes: readonly string[]
): Promise<ReadonlyMap<string, string>> => {
  const unique = [...new Set(codes)];
  const names = new Map<string, string>();
  for (let start = 0; start < unique.length; start += NAME_LOOKUP_CHUNK) {
    const chunk = unique.slice(start, start + NAME_LOOKUP_CHUNK);
    const result = await sql<{ code: string; name: string | null }>`
      select n.fiscal_code_clean as code, n.registry_name as name
      from ${PUBLIC_NAMES} n
      where n.fiscal_code_clean = any(${chunk}::text[]) and n.supplier_name_public is true`.execute(
      trx
    );
    for (const row of result.rows) if (row.name !== null) names.set(row.code, row.name);
  }
  return names;
};
