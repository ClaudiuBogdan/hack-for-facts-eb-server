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
  FiscalCodeSet,
  type ApiError,
  type FilterInput,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import {
  daFreeTextSearchRefused,
  daSupplierGeographyRefused,
  discloseDaDetailBody,
  discloseDirectAcquisition,
  publicSupplierFilter,
} from '../../core/da-disclosure.js';

import type { ProcurementRepo } from '../../core/ports.js';
import type { ProcurementDirectAcquisition } from '../../core/types.js';

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
   * The LAST decision: a fresh read of the public set (never a load that began
   * before the caller's facts), intersected with what authorised the read.
   */
  const settle = async (
    authorised: ReadonlySet<string> | null
  ): Promise<Result<ReadonlySet<string>, ApiError>> => {
    const now = await disclosure.publicSupplierCodes({ fresh: true });
    if (now.isErr()) return err(now.error);
    if (authorised === null) return ok(now.value);
    // Still a FiscalCodeSet: a padded legacy code matches the narrowed set as it did the first.
    return ok(new FiscalCodeSet([...authorised].filter((code) => now.value.has(code))));
  };

  /** Enrich a page first, then settle: the codes returned are the decision the page was scrubbed with. */
  const discloseAll = async (
    das: readonly ProcurementDirectAcquisition[],
    authorised: ReadonlySet<string> | null
  ): Promise<
    Result<{ items: ProcurementDirectAcquisition[]; codes: ReadonlySet<string> }, ApiError>
  > => {
    const labels = await labelsFor(das);
    const codes = await settle(authorised);
    if (codes.isErr()) return err(codes.error);
    return ok({
      items: das.map((da) => discloseDirectAcquisition(da, codes.value, labels)),
      codes: codes.value,
    });
  };

  /** A supplier filter that the final decision narrowed: the page (cursor, totals) is discarded. */
  const narrowed = (allowed: readonly string[] | null, codes: ReadonlySet<string>): boolean =>
    allowed?.some((code) => !codes.has(code)) === true;

  return {
    ...repo,

    listDirectAcquisitions: async (filter, page) => {
      const attempt = async (authorised: ReadonlySet<string>) => {
        const allowed = publicSupplierFilter(requestedSuppliers(filter), authorised);
        if (allowed !== null && allowed.length === 0)
          return ok({ page: { items: [], next: null }, allowed, codes: authorised });
        const scoped: FilterInput =
          allowed === null ? filter : { ...filter, supplierCui: { in: [...allowed] } };
        const read = await repo.listDirectAcquisitions(scoped, page);
        if (read.isErr()) return err(read.error);
        const disclosed = await discloseAll(read.value.items, authorised);
        if (disclosed.isErr()) return err(disclosed.error);
        return ok({
          page: { ...read.value, items: disclosed.value.items },
          allowed,
          codes: disclosed.value.codes,
        });
      };
      const before = await publicCodes();
      if (before.isErr()) return err(before.error);
      const first = await attempt(before.value);
      if (first.isErr()) return err(first.error);
      if (!narrowed(first.value.allowed, first.value.codes)) return ok(first.value.page);
      // A filter code withheld mid-request: read once more under the settled set;
      // if it moves again, fail closed rather than chase it.
      const second = await attempt(first.value.codes);
      if (second.isErr()) return err(second.error);
      return narrowed(second.value.allowed, second.value.codes)
        ? ok({ items: [], next: null })
        : ok(second.value.page);
    },

    searchDirectAcquisitionsOffset: async (filter, page, facets) => {
      if (filter.q !== undefined && filter.q.trim() !== '') return err(daFreeTextSearchRefused());
      if (filter.supplierGeo !== undefined) return err(daSupplierGeographyRefused('supplierGeo'));
      const geoFacet = facets?.find((facet) => SUPPLIER_GEO_FACETS.has(facet));
      if (geoFacet !== undefined) return err(daSupplierGeographyRefused('facets'));
      const empty = ok({ items: [], total: 0, estimated: false });
      const code = filter.supplierCui;
      const before = await publicCodes();
      if (before.isErr()) return err(before.error);
      if (code !== undefined && !before.value.has(code)) return empty;
      const result = await repo.searchDirectAcquisitionsOffset(filter, page, facets);
      if (result.isErr()) return result;
      const disclosed = await discloseAll(result.value.items, before.value);
      if (disclosed.isErr()) return err(disclosed.error);
      // Withheld by the final decision: no ids, total or facets tied to that supplier.
      if (code !== undefined && !disclosed.value.codes.has(code)) return empty;
      // No highlights: q is refused, and a highlight could quote withheld text.
      const { total, estimated, facets: facetCounts, provenance } = result.value;
      return ok({
        items: disclosed.value.items,
        total,
        estimated,
        ...(facetCounts !== undefined && { facets: facetCounts }),
        ...(provenance !== undefined && { provenance }),
      });
    },

    // Detail reads authorise nothing up front: the set is read fresh after the row.
    getDirectAcquisition: async (id) => {
      const result = await repo.getDirectAcquisition(id);
      if (result.isErr() || result.value === null) return result;
      const disclosed = await discloseAll([result.value], null);
      if (disclosed.isErr()) return err(disclosed.error);
      return ok(disclosed.value.items[0] ?? null);
    },

    getDirectAcquisitionDetail: async (id) => {
      const result = await repo.getDirectAcquisitionDetail(id);
      if (result.isErr() || result.value === null) return result;
      const detail = result.value;
      const disclosed = await discloseAll([detail.directAcquisition], null);
      if (disclosed.isErr()) return err(disclosed.error);
      const da = disclosed.value.items[0];
      if (da === undefined) return ok(null);
      return ok({
        ...detail,
        directAcquisition: da,
        detail: detail.detail === null ? null : discloseDaDetailBody(detail.detail),
      });
    },

    supplierRecords: async (supplierCui, first, after, includeCancelled, includeDas) => {
      const contractsOnly = () =>
        repo.supplierRecords(supplierCui, first, after, includeCancelled, false);
      const before = await publicCodes();
      if (before.isErr()) return err(before.error);
      if (!(includeDas ?? true) || !before.value.has(supplierCui)) return contractsOnly();
      const result = await repo.supplierRecords(supplierCui, first, after, includeCancelled, true);
      if (result.isErr()) return result;
      const connection = result.value;
      const das = connection.edges.flatMap((edge) =>
        edge.node.grain === 'direct_acquisition' ? [edge.node.directAcquisition] : []
      );
      const disclosed = await discloseAll(das, before.value);
      if (disclosed.isErr()) return err(disclosed.error);
      // Withheld by the final decision: the whole page, cursors included, is
      // rebuilt from the contract leg (a DA cursor names the supplier and purchase).
      if (!disclosed.value.codes.has(supplierCui)) return contractsOnly();
      const scrubbed = [...disclosed.value.items];
      return ok({
        ...connection,
        edges: connection.edges.map((edge) => {
          if (edge.node.grain !== 'direct_acquisition') return edge;
          const da = scrubbed.shift() ?? edge.node.directAcquisition;
          return { ...edge, node: { grain: 'direct_acquisition', directAcquisition: da } };
        }),
      });
    },
  };
};
