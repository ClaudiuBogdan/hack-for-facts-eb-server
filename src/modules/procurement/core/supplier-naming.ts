/**
 * How a direct-acquisition supplier that D6 discloses is named (naming step 2,
 * decision 20261124-name-suppliers-by-registry-legal-form-and-mask-persons).
 *
 * The D6 gate (`supplier_disclosure`) decides WHICH suppliers are served, and
 * stays the one source for counting, filters and rankings. This only decides the
 * NAME a disclosed supplier is served with:
 *
 * - With `procurement_v3.supplier_names_public` readable (the owner's grant):
 *   `named` → `company` with the registry name; `masked` → `person_masked` with
 *   the masked name; `code_only`, `withheld`, no row, a missing name or any
 *   other value → `code_only` (the code, no name). A row whose code may not be
 *   shown (`code_shown` not true) is `hidden`: served like a D6-withheld
 *   supplier, or refused where its code would key a ranking.
 * - Without it, exactly as before step 2: `company`, named by its public
 *   registry name (`party_public_names.registry_name` where
 *   `supplier_name_public`), or with no name.
 *
 * Every served name still passes the personal-code screen (`publicPartyName`), and
 * a name from the view also any run of 11+ digits (`hasPersonCodeRun`); a name
 * either withholds leaves the code only.
 */

import { hasPersonCodeRun, publicPartyName } from './free-text-rule.js';

export type SupplierNamingKind = 'company' | 'person_masked' | 'code_only' | 'hidden';

export interface SupplierNaming {
  readonly kind: SupplierNamingKind;
  /** Null for `code_only` and `hidden`; for `company`, null when no public name exists. */
  readonly name: string | null;
}

/** One row of `procurement_v3.supplier_names_public`, as read by code. */
export interface SupplierNamesViewRow {
  readonly naming: string | null;
  readonly displayName: string | null;
  readonly codeShown: boolean | null;
}

const CODE_ONLY: SupplierNaming = { kind: 'code_only', name: null };
const HIDDEN: SupplierNaming = { kind: 'hidden', name: null };

/** A disclosed supplier's naming from its view row; `undefined` (no row) is code only. */
export const namingFromView = (row: SupplierNamesViewRow | undefined): SupplierNaming => {
  if (row === undefined) return CODE_ONLY;
  if (row.codeShown !== true) return HIDDEN;
  // The view's names are screened for any run of more than an organization code's digits (11+, as
  // the kernel withholds such identifiers), not only the 13-digit personal-code rule.
  const name = publicPartyName(row.displayName);
  if (name === null || hasPersonCodeRun(name)) return CODE_ONLY;
  if (row.naming === 'named') return { kind: 'company', name };
  if (row.naming === 'masked') return { kind: 'person_masked', name };
  return CODE_ONLY;
};

/** Before the view is readable: a company, by its public registry name when it has one. */
export const namingFromRegistry = (registryName: string | undefined): SupplierNaming => ({
  kind: 'company',
  name: publicPartyName(registryName ?? null),
});

/** The display kinds a disclosed supplier can be served with (never `hidden`). */
export type ServedSupplierKind = Exclude<SupplierNamingKind, 'hidden'>;

/** The name a served kind may carry: none for `code_only`. */
export const servedSupplierName = (naming: SupplierNaming): string | null =>
  naming.kind === 'company' || naming.kind === 'person_masked'
    ? publicPartyName(naming.name)
    : null;
