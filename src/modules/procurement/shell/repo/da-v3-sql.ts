/**
 * Direct acquisitions release 1 — the SQL pieces every procurement_v3 reader
 * shares, so the supplier rule (D6, site-wide) exists in ONE place.
 *
 * D6: a supplier is named only when its code is in `supplier_privacy` with
 * `public = true` (and, defensively, present and valid). The classification
 * row joins as alias `sv` over the supplier party alias `s`. Without the table
 * the predicate is constant false: every supplier is withheld (fails closed).
 * The core re-checks every party it serves (`isNamedSupplier`).
 */

import { sql, type Kysely, type RawBuilder } from 'kysely';

import type { ProdDatabase } from '@/modules/shared/index.js';

/** The serving schema. Pending the owner's migration; the only name that may still change. */
export const DA_RELEASE_SCHEMA = 'procurement_v3';

export const daV3Table = (name: string) => sql.table(`${DA_RELEASE_SCHEMA}.${name}`);

const PRIVACY = daV3Table('supplier_privacy');

/** The supplier's classification row (`sv`); joined only when the table exists. */
export const supplierPrivacyJoin = (present: boolean): RawBuilder<unknown> =>
  present ? sql`left join ${PRIVACY} sv on sv.fiscal_code_clean = s.fiscal_code_clean` : sql``;

/** D6 in SQL over `s` and `sv`: see `isNamedSupplier` in core/da-release.ts. */
export const namedSupplierSql = (present: boolean): RawBuilder<unknown> =>
  present
    ? sql`(sv.public is true and s.fiscal_code_status = 'valid' and s.fiscal_code_clean is not null)`
    : sql`false`;

/**
 * Whether `supplier_privacy` exists AND this login may read it (a revoked grant
 * leaves the catalog entry in place). Not readable: every supplier is withheld.
 */
export const probeSupplierPrivacy = async (trx: Kysely<ProdDatabase>): Promise<boolean> => {
  const result = await sql<{ present: boolean }>`
    select coalesce(
      has_table_privilege(to_regclass(${`${DA_RELEASE_SCHEMA}.supplier_privacy`}), 'SELECT'),
      false
    ) as present`.execute(trx);
  return result.rows[0]?.present === true;
};
