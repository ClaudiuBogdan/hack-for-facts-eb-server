/**
 * A legacy supplier name as served (owner, 24 Nov: "Masked name"). A supplier whose code is longer
 * than an organization code (`MAX_SERVED_CUI_DIGITS`, the kernel's withheld-identifier rule) is a
 * person: its name is served through the platform's buyer mask, `procurement_v3.mask_person_name`
 * (migration 20261121T090096), never raw. The mask is the database's: the API keeps no copy. On a
 * database without the function the read fails, so a raw name is never the fallback.
 *
 * `carriesPersonalCode` still applies on top, at the output edges.
 */
import { sql, type RawBuilder } from 'kysely';

import { MAX_SERVED_CUI_DIGITS } from '@/modules/shared/index.js';

/** The masked-or-raw supplier name of `alias`'s row (alias = the table alias). */
export const servedSupplierNameSql = (alias: string): RawBuilder<string | null> => {
  const name = sql.ref(`${alias}.supplier_name`);
  return sql<string | null>`case when length(${sql.ref(`${alias}.supplier_cui`)}) > ${sql.lit(
    MAX_SERVED_CUI_DIGITS
  )} then procurement_v3.mask_person_name(${name}) else ${name} end`;
};

/** The same, as the `supplier_name` column of a select list. */
export const servedSupplierNameColumn = (alias: string) =>
  servedSupplierNameSql(alias).as('supplier_name');
