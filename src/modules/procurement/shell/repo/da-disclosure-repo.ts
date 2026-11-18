/**
 * Site-wide D6 and the free-text gate on the legacy direct-acquisition reads,
 * as one decorator over the procurement repository. Every legacy DA surface
 * (GraphQL lists, detail and supplier records, the MCP search tool) reads DAs
 * through these methods, so the rule is applied once here. Rules:
 * core/da-disclosure.ts. Inactive (`disclosure.enforced` false) it returns the
 * repository unchanged.
 */

import { err, ok, type Result } from 'neverthrow';

import {
  daFreeTextSearchRefused,
  daSupplierGeographyRefused,
  discloseDaDetailBody,
  discloseDirectAcquisition,
  publicSupplierFilter,
} from '../../core/da-disclosure.js';

import type { ProcurementRepo } from '../../core/ports.js';
import type { ProcurementDirectAcquisition } from '../../core/types.js';
import type { ApiError, FilterInput, SupplierDisclosurePort } from '@/modules/shared/index.js';

const SUPPLIER_GEO_FACETS = new Set(['supplierRegion', 'supplierCounty', 'supplierSiruta']);

/** The supplier codes a cursor-list filter names (`{ in }` or `{ eq }`), or null. */
const requestedSuppliers = (filter: FilterInput): readonly string[] | null => {
  const clause = filter['supplierCui'] as { in?: unknown; eq?: unknown } | undefined;
  if (clause === undefined) return null;
  const values = Array.isArray(clause.in) ? clause.in : clause.eq !== undefined ? [clause.eq] : [];
  return values.filter((value): value is string => typeof value === 'string');
};

export const withDaDisclosure = (
  repo: ProcurementRepo,
  disclosure: SupplierDisclosurePort | undefined
): ProcurementRepo => {
  if (disclosure?.enforced !== true) return repo;

  const publicCodes = async (): Promise<Result<ReadonlySet<string>, ApiError>> =>
    disclosure.publicSupplierCodes();

  /** CPV labels for a page (one batched read); a failed lookup leaves the label null. */
  const labelsFor = async (
    das: readonly ProcurementDirectAcquisition[]
  ): Promise<ReadonlyMap<string, string>> => {
    const codes = [...new Set(das.flatMap((da) => (da.cpvCode === null ? [] : [da.cpvCode])))];
    if (codes.length === 0) return new Map();
    const labels = await repo.listCpvCodeLabels(codes);
    if (labels.isErr()) return new Map();
    return new Map(
      labels.value.flatMap((label) => (label.labelRo === null ? [] : [[label.code, label.labelRo]]))
    );
  };

  const discloseAll = async (
    das: readonly ProcurementDirectAcquisition[],
    codes: ReadonlySet<string>
  ): Promise<ProcurementDirectAcquisition[]> => {
    const labels = await labelsFor(das);
    return das.map((da) => discloseDirectAcquisition(da, codes, labels));
  };

  return {
    ...repo,

    listDirectAcquisitions: async (filter, page) => {
      const codes = await publicCodes();
      if (codes.isErr()) return err(codes.error);
      const allowed = publicSupplierFilter(requestedSuppliers(filter), codes.value);
      if (allowed !== null && allowed.length === 0) return ok({ items: [], next: null });
      const scoped: FilterInput =
        allowed === null ? filter : { ...filter, supplierCui: { in: [...allowed] } };
      const result = await repo.listDirectAcquisitions(scoped, page);
      if (result.isErr()) return result;
      return ok({ ...result.value, items: await discloseAll(result.value.items, codes.value) });
    },

    searchDirectAcquisitionsOffset: async (filter, page, facets) => {
      if (filter.q !== undefined && filter.q.trim() !== '') return err(daFreeTextSearchRefused());
      if (filter.supplierGeo !== undefined) return err(daSupplierGeographyRefused('supplierGeo'));
      const geoFacet = facets?.find((facet) => SUPPLIER_GEO_FACETS.has(facet));
      if (geoFacet !== undefined) return err(daSupplierGeographyRefused('facets'));
      const codes = await publicCodes();
      if (codes.isErr()) return err(codes.error);
      if (filter.supplierCui !== undefined && !codes.value.has(filter.supplierCui))
        return ok({ items: [], total: 0, estimated: false });
      const result = await repo.searchDirectAcquisitionsOffset(filter, page, facets);
      if (result.isErr()) return result;
      // No highlights: q is refused, and a highlight could quote withheld text.
      const { total, estimated, facets: facetCounts, provenance } = result.value;
      return ok({
        items: await discloseAll(result.value.items, codes.value),
        total,
        estimated,
        ...(facetCounts !== undefined && { facets: facetCounts }),
        ...(provenance !== undefined && { provenance }),
      });
    },

    getDirectAcquisition: async (id) => {
      const codes = await publicCodes();
      if (codes.isErr()) return err(codes.error);
      const result = await repo.getDirectAcquisition(id);
      if (result.isErr() || result.value === null) return result;
      const [disclosed] = await discloseAll([result.value], codes.value);
      return ok(disclosed ?? null);
    },

    getDirectAcquisitionDetail: async (id) => {
      const codes = await publicCodes();
      if (codes.isErr()) return err(codes.error);
      const result = await repo.getDirectAcquisitionDetail(id);
      if (result.isErr() || result.value === null) return result;
      const detail = result.value;
      const [disclosed] = await discloseAll([detail.directAcquisition], codes.value);
      if (disclosed === undefined) return ok(null);
      return ok({
        ...detail,
        directAcquisition: disclosed,
        detail: detail.detail === null ? null : discloseDaDetailBody(detail.detail),
      });
    },

    supplierRecords: async (supplierCui, first, after, includeCancelled, includeDas) => {
      const codes = await publicCodes();
      if (codes.isErr()) return err(codes.error);
      const result = await repo.supplierRecords(
        supplierCui,
        first,
        after,
        includeCancelled,
        (includeDas ?? true) && codes.value.has(supplierCui)
      );
      if (result.isErr()) return result;
      const das = result.value.edges.flatMap((edge) =>
        edge.node.grain === 'direct_acquisition' ? [edge.node.directAcquisition] : []
      );
      const labels = await labelsFor(das);
      return ok({
        ...result.value,
        edges: result.value.edges.map((edge) =>
          edge.node.grain === 'direct_acquisition'
            ? {
                ...edge,
                node: {
                  grain: 'direct_acquisition',
                  directAcquisition: discloseDirectAcquisition(
                    edge.node.directAcquisition,
                    codes.value,
                    labels
                  ),
                },
              }
            : edge
        ),
      });
    },
  };
};
