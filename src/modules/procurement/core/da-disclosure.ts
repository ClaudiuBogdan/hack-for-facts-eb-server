/**
 * Site-wide D6 and the free-text gate on the LEGACY direct-acquisition reads
 * (owner via root, 2026-11-18), applied while PROCUREMENT_SUPPLIER_DISCLOSURE_ENFORCED is on
 * (its own switch, independent of the DA release flag: a v3 rollback never re-exposes).
 *
 * - A supplier is named (code and name) only when its code is in the public
 *   set from `supplier_privacy`; otherwise it is `natural_person` with no code
 *   and no name. One rule with the v3 surface, so the two never disagree.
 * - Free text is restricted until reviewed (decision 2026-11-10), and legacy
 *   has no per-field public flags, so the title, the detail's free-text fields
 *   and the item lines' names and descriptions are withheld. The CPV label
 *   names the purchase instead.
 * - A free-text search over DAs would match withheld titles and names, so `q`
 *   is refused; supplier geography is dropped for the DA grain.
 *
 * Pure: the caller supplies the public set and the CPV labels.
 */

import { invalidInput, type ApiError } from '@/modules/shared/index.js';

import type { DaDetailBody, ProcurementDirectAcquisition } from './types.js';

export const discloseDirectAcquisition = (
  da: ProcurementDirectAcquisition,
  publicCodes: ReadonlySet<string>,
  cpvLabels: ReadonlyMap<string, string>
): ProcurementDirectAcquisition => {
  const named = da.supplierCui !== null && publicCodes.has(da.supplierCui);
  const hasSupplier = da.supplierCui !== null || da.supplierName !== null;
  return {
    ...da,
    supplierCui: named ? da.supplierCui : null,
    supplierName: named ? da.supplierName : null,
    ...(hasSupplier && { supplierDisplayKind: named ? 'company' : 'natural_person' }),
    title: null,
    titleWithheld: 'privacy',
    cpvLabel: da.cpvCode === null ? null : (cpvLabels.get(da.cpvCode) ?? null),
  };
};

/**
 * The detail body as an allowlist: dates, flags, counts, codes and amounts are
 * kept; every text the source typed is withheld, including the contract-type and
 * EU-fund labels and the item lines' unit and CPV text (the loader screens those
 * for contact data too). The CPV label comes from the catalogue, never the row.
 */
export const discloseDaDetailBody = (body: DaDetailBody): DaDetailBody => ({
  ...body,
  description: null,
  deliveryCondition: null,
  paymentCondition: null,
  contractTypeText: null,
  euFundText: null,
  caRejectionReason: null,
  supplierRejectionReason: null,
  correctionReason: null,
  textRedacted: true,
  items: body.items.map((item) => ({
    daItemId: item.daItemId,
    itemIndex: item.itemIndex,
    // Typed by the source and outside the loader's privacy scan: withheld.
    catalogItemCode: null,
    catalogItemName: null,
    catalogItemDescription: null,
    itemMeasureUnit: null,
    cpvCode: item.cpvCode,
    cpvText: null,
    itemQuantity: item.itemQuantity,
    unitPrice: item.unitPrice,
    unitEstimatedPrice: item.unitEstimatedPrice,
    catalogUnitPrice: item.catalogUnitPrice,
    lineValue: item.lineValue,
    sourceUrl: item.sourceUrl,
  })),
});

/**
 * The supplier codes a filter asks for that D6 lets it match. `null`: the
 * filter names no supplier. An empty array: it names only withheld suppliers,
 * so the DA answer is empty.
 */
export const publicSupplierFilter = (
  requested: readonly string[] | null,
  publicCodes: ReadonlySet<string>
): readonly string[] | null =>
  requested === null ? null : requested.filter((code) => publicCodes.has(code));

export const daFreeTextSearchRefused = (): ApiError =>
  invalidInput(
    'Free-text search over direct acquisitions is unavailable: their titles and supplier names are withheld until reviewed.',
    'q'
  );

export const daSupplierGeographyRefused = (field: string): ApiError =>
  invalidInput('Supplier geography is not available for direct acquisitions.', field);
