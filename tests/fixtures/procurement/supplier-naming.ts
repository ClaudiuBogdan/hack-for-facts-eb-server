/**
 * Supplier naming fakes (naming step 2): a names port answer where each given
 * code is a `company` named by the given registry name, as before the
 * `supplier_names_public` grant.
 */
import type { SupplierNaming } from '@/modules/procurement/core/supplier-naming.js';

export const companyNames = (
  entries: Iterable<readonly [string, string]>
): ReadonlyMap<string, SupplierNaming> =>
  new Map([...entries].map(([code, name]) => [code, { kind: 'company', name }] as const));
