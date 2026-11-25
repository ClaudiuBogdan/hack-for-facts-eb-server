/**
 * A legacy supplier name as served (owner, 24 Nov: "Masked name"). A supplier whose code is longer
 * than an organization code (`MAX_SERVED_CUI_DIGITS`, the kernel's withheld-identifier rule), or that
 * has no code, may be a person: its name is served through the platform's buyer mask,
 * `procurement_v3.mask_person_name`
 * (migration 20261121T090096), never raw. The mask is the database's: the API keeps no copy. On a
 * database without the function the read fails, so a raw name is never the fallback.
 *
 * `carriesPersonalCode` still applies on top, at the output edges.
 */
import { sql, type RawBuilder } from 'kysely';

import { MAX_SERVED_CUI_DIGITS } from '@/modules/shared/index.js';

/**
 * The masked-or-raw supplier name of `alias`'s row (alias = the table alias). The code is the served
 * one, else the source code the loader kept as evidence when it withheld a personal code from
 * `supplier_cui` (PRJ-4VM4: `attrs.source_party_cuis.supplier`). A person's code masks the name, and
 * so does no code at all (root, 24 Nov: what is not shown to be an organization is not named in
 * full; some foreign companies are masked too, accepted for the legacy interim).
 */
export const servedSupplierNameSql = (alias: string): RawBuilder<string | null> => {
  const name = sql.ref(`${alias}.supplier_name`);
  const code = sql`coalesce(${sql.ref(`${alias}.supplier_cui`)}, ${sql.ref(
    `${alias}.attrs`
  )} #>> '{source_party_cuis,supplier}')`;
  return sql<string | null>`case when ${code} is null or length(${code}) > ${sql.lit(
    MAX_SERVED_CUI_DIGITS
  )} then procurement_v3.mask_person_name(${name}) else ${name} end`;
};

/** The same, as the `supplier_name` column of a select list. */
export const servedSupplierNameColumn = (alias: string) =>
  servedSupplierNameSql(alias).as('supplier_name');
