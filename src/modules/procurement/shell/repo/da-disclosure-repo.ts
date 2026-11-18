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

  /**
   * Scrub a page: every enrichment first, then the LAST read of the public set
   * (intersected with `authorised`), so nothing runs between the decision and
   * the response.
   */
  const discloseAll = async (
    das: readonly ProcurementDirectAcquisition[],
    authorised: ReadonlySet<string> | null
  ): Promise<Result<ProcurementDirectAcquisition[], ApiError>> => {
    const labels = await labelsFor(das);
    const codes = authorised === null ? await publicCodes() : await settle(authorised);
    if (codes.isErr()) return err(codes.error);
    return ok(das.map((da) => discloseDirectAcquisition(da, codes.value, labels)));
  };

  /**
   * The public set AFTER a data read, intersected with the one the read was
   * authorised by: a code a nightly publish withheld mid-request stays withheld.
   */
  const settle = async (
    before: ReadonlySet<string>
  ): Promise<Result<ReadonlySet<string>, ApiError>> => {
    const now = await publicCodes();
    if (now.isErr()) return err(now.error);
    if (now.value === before) return ok(before);
    return ok(new Set([...before].filter((code) => now.value.has(code))));
  };

  return {
    ...repo,

    listDirectAcquisitions: async (filter, page) => {
      const run = async (codes: ReadonlySet<string>) => {
        const allowed = publicSupplierFilter(requestedSuppliers(filter), codes);
        if (allowed !== null && allowed.length === 0)
          return { allowed, result: ok({ items: [], next: null }) };
        const scoped: FilterInput =
          allowed === null ? filter : { ...filter, supplierCui: { in: [...allowed] } };
        return { allowed, result: await repo.listDirectAcquisitions(scoped, page) };
      };
      const before = await publicCodes();
      if (before.isErr()) return err(before.error);
      let read = await run(before.value);
      if (read.result.isErr()) return read.result;
      const after = await settle(before.value);
      if (after.isErr()) return err(after.error);
      // A filter code withheld mid-request: read again under the settled set.
      if (
        read.allowed !== null &&
        publicSupplierFilter(read.allowed, after.value)?.length !== read.allowed.length
      ) {
        read = await run(after.value);
        if (read.result.isErr()) return read.result;
        // Moved twice within one request: fail closed rather than chase it.
        const again = await settle(after.value);
        if (again.isErr()) return err(again.error);
        if (publicSupplierFilter(read.allowed, again.value)?.length !== read.allowed?.length)
          return ok({ items: [], next: null });
      }
      const value = read.result.value;
      const items = await discloseAll(value.items, after.value);
      if (items.isErr()) return err(items.error);
      return ok({ ...value, items: items.value });
    },

    searchDirectAcquisitionsOffset: async (filter, page, facets) => {
      if (filter.q !== undefined && filter.q.trim() !== '') return err(daFreeTextSearchRefused());
      if (filter.supplierGeo !== undefined) return err(daSupplierGeographyRefused('supplierGeo'));
      const geoFacet = facets?.find((facet) => SUPPLIER_GEO_FACETS.has(facet));
      if (geoFacet !== undefined) return err(daSupplierGeographyRefused('facets'));
      const empty = ok({ items: [], total: 0, estimated: false });
      const before = await publicCodes();
      if (before.isErr()) return err(before.error);
      if (filter.supplierCui !== undefined && !before.value.has(filter.supplierCui)) return empty;
      const result = await repo.searchDirectAcquisitionsOffset(filter, page, facets);
      if (result.isErr()) return result;
      const after = await settle(before.value);
      if (after.isErr()) return err(after.error);
      if (filter.supplierCui !== undefined && !after.value.has(filter.supplierCui)) return empty;
      // No highlights: q is refused, and a highlight could quote withheld text.
      const { total, estimated, facets: facetCounts, provenance } = result.value;
      const items = await discloseAll(result.value.items, after.value);
      if (items.isErr()) return err(items.error);
      return ok({
        items: items.value,
        total,
        estimated,
        ...(facetCounts !== undefined && { facets: facetCounts }),
        ...(provenance !== undefined && { provenance }),
      });
    },

    // Detail reads authorise nothing up front: the set is read after the row.
    getDirectAcquisition: async (id) => {
      const result = await repo.getDirectAcquisition(id);
      if (result.isErr() || result.value === null) return result;
      const disclosed = await discloseAll([result.value], null);
      if (disclosed.isErr()) return err(disclosed.error);
      return ok(disclosed.value[0] ?? null);
    },

    getDirectAcquisitionDetail: async (id) => {
      const result = await repo.getDirectAcquisitionDetail(id);
      if (result.isErr() || result.value === null) return result;
      const detail = result.value;
      const disclosedR = await discloseAll([detail.directAcquisition], null);
      if (disclosedR.isErr()) return err(disclosedR.error);
      const disclosed = disclosedR.value[0];
      if (disclosed === undefined) return ok(null);
      return ok({
        ...detail,
        directAcquisition: disclosed,
        detail: detail.detail === null ? null : discloseDaDetailBody(detail.detail),
      });
    },

    supplierRecords: async (supplierCui, first, after, includeCancelled, includeDas) => {
      const before = await publicCodes();
      if (before.isErr()) return err(before.error);
      const wanted = includeDas ?? true;
      let result = await repo.supplierRecords(
        supplierCui,
        first,
        after,
        includeCancelled,
        wanted && before.value.has(supplierCui)
      );
      if (result.isErr()) return result;
      const check = await settle(before.value);
      if (check.isErr()) return err(check.error);
      if (wanted && before.value.has(supplierCui) && !check.value.has(supplierCui)) {
        result = await repo.supplierRecords(supplierCui, first, after, includeCancelled, false);
        if (result.isErr()) return result;
      }
      const connection = result.value;
      const das = connection.edges.flatMap((edge) =>
        edge.node.grain === 'direct_acquisition' ? [edge.node.directAcquisition] : []
      );
      const labels = await labelsFor(das);
      // The last read of the set, after every enrichment.
      const settled = await settle(check.value);
      if (settled.isErr()) return err(settled.error);
      if (!settled.value.has(supplierCui) && das.length > 0)
        return ok({
          ...connection,
          edges: connection.edges.filter((e) => e.node.grain !== 'direct_acquisition'),
        });
      return ok({
        ...connection,
        edges: connection.edges.map((edge) =>
          edge.node.grain === 'direct_acquisition'
            ? {
                ...edge,
                node: {
                  grain: 'direct_acquisition',
                  directAcquisition: discloseDirectAcquisition(
                    edge.node.directAcquisition,
                    settled.value,
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
