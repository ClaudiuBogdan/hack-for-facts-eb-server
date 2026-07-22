/**
 * Procurement module — GraphQL resolvers. Thin: translate args → call the SAME
 * usecase the MCP tools call → unwrap `Result` into a `GraphQLError`.
 *
 * N+1 discipline. Three fan-out points are batched through `makeBatchLoader` (one
 * statement per microtask tick):
 *   - `ProcurementContract.modifications` — a procedure detail selects up to 50
 *     contracts, and the supplier connection up to 100, each asking for its trail.
 *   - `ProcurementContractModification.parentContract` — a modifications page of
 *     100 rows would otherwise be 100 contract reads.
 */

import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, makeBatchLoader, type ApiError } from '@/modules/shared/index.js';

import {
  translateAnalysisScope,
  translateSearchFilter,
  type RawAnalysisScopeInput,
  type RawSearchFilter,
} from './arg-translation.js';
import {
  analysisBreakdown,
  analysisConcentration,
  analysisFacets,
  analysisSeries,
  analysisShare,
  analysisStats,
  type AnalysisDeps,
} from '../../core/analysis-usecases.js';
import {
  PAGE_SIZE_DEFAULT,
  type BreakdownDimension,
  type MeasureId,
  type SeriesBucket,
} from '../../core/constants.js';
import { parseOffsetRequest } from '../../core/search.js';
import {
  getContractDetail,
  getDirectAcquisitionBundle,
  getProcedureDetail,
  getSupplierRecords,
  listCpvDivisions,
  listCpvCodeLabels,
  resolveCpv,
} from '../../core/usecases.js';

import type { AnalysisRepo, ProcurementRepo } from '../../core/ports.js';
import type {
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementModification,
  ProcurementProcedure,
  SupplierRecord,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface ProcurementResolverDeps {
  readonly repo: ProcurementRepo;
  readonly analysis: AnalysisRepo;
  /** Route override for alternate analytics backends (ClickHouse dev path). */
  readonly routeAnalysis?: AnalysisDeps['routeAnalysis'];
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

/** A party block. `displayName` prefers the source's own name over the bare CUI. */
const party = (
  cui: string | null,
  name: string | null
): { cui: string | null; name: string | null; displayName: string | null } => ({
  cui,
  name,
  displayName: name ?? cui,
});

interface SearchArgs {
  filter?: RawSearchFilter | null;
  sort?: string;
  page?: number;
  pageSize?: number;
}

export const makeProcurementResolvers = (
  deps: ProcurementResolverDeps
): Record<string, unknown> => {
  const { repo, analysis } = deps;
  const analysisDeps = {
    analysisRepo: analysis,
    ...(deps.routeAnalysis !== undefined && { routeAnalysis: deps.routeAnalysis }),
  };

  const modificationsLoader = makeBatchLoader<readonly ProcurementModification[]>(
    async (contractIds) => unwrap(await repo.modificationsForContracts(contractIds)),
    []
  );

  const contractLoader = makeBatchLoader<ProcurementContract | null>(
    async (contractIds) => unwrap(await repo.contractsByIds(contractIds)),
    null
  );

  /** Parse `filter`/`sort`/`page`/`pageSize` once, the same way for every grain. */
  const searchArgs = (
    a: SearchArgs,
    dateField: 'publicationDate' | 'contractDate' | 'modificationDate'
  ) => {
    const filter = unwrap(translateSearchFilter(a.filter, dateField));
    const page = unwrap(parseOffsetRequest(a.page, a.pageSize ?? PAGE_SIZE_DEFAULT, a.sort));
    return { filter, page };
  };

  const analysisScope = (raw: RawAnalysisScopeInput | null | undefined) =>
    unwrap(translateAnalysisScope(raw));

  /** `{ items, total, estimated }` → the SDL's page shape. */
  const toPage = <T>(result: {
    items: readonly T[];
    total: number | null;
    estimated: boolean;
  }) => ({
    total: result.total,
    totalEstimated: result.estimated,
    items: result.items,
  });

  return {
    Query: {
      // ── search ──────────────────────────────────────────────────────────────
      procurementProcedures: async (_r: unknown, a: SearchArgs) => {
        const { filter, page } = searchArgs(a, 'publicationDate');
        return toPage(unwrap(await repo.searchProceduresOffset(filter, page)));
      },
      procurementContracts: async (_r: unknown, a: SearchArgs) => {
        const { filter, page } = searchArgs(a, 'contractDate');
        return toPage(unwrap(await repo.searchContractsOffset(filter, page)));
      },
      procurementDirectAcquisitions: async (_r: unknown, a: SearchArgs) => {
        // The DA filter's `publicationDate` facet binds to `finalization_date`.
        const { filter, page } = searchArgs(a, 'publicationDate');
        return toPage(unwrap(await repo.searchDirectAcquisitionsOffset(filter, page)));
      },
      procurementModifications: async (_r: unknown, a: SearchArgs) => {
        const { filter, page } = searchArgs(a, 'modificationDate');
        return toPage(unwrap(await repo.searchModificationsOffset(filter, page)));
      },

      // ── detail bundles ──────────────────────────────────────────────────────
      procurementProcedure: async (_r: unknown, a: { id: string }) => {
        return unwrap(await getProcedureDetail(repo, a.id));
      },
      procurementContract: async (_r: unknown, a: { id: string }) => {
        return unwrap(await getContractDetail(repo, a.id));
      },
      procurementDirectAcquisition: async (_r: unknown, a: { id: string }) => {
        return unwrap(await getDirectAcquisitionBundle(repo, a.id));
      },

      // ── analysis surface (one scope, six shapes; design §5.3) ───────────────
      procurementStats: async (_r: unknown, a: { scope?: RawAnalysisScopeInput | null }) =>
        unwrap(await analysisStats(analysisDeps, { scope: analysisScope(a.scope) })),
      procurementSeries: async (
        _r: unknown,
        a: { scope?: RawAnalysisScopeInput | null; bucket: SeriesBucket; measure: MeasureId }
      ) =>
        unwrap(
          await analysisSeries(analysisDeps, {
            scope: analysisScope(a.scope),
            bucket: a.bucket,
            measure: a.measure,
          })
        ),
      procurementBreakdown: async (
        _r: unknown,
        a: {
          scope?: RawAnalysisScopeInput | null;
          dimension: BreakdownDimension;
          topN?: number | null;
          rankBy?: 'value' | 'count' | null;
        }
      ) =>
        unwrap(
          await analysisBreakdown(analysisDeps, {
            scope: analysisScope(a.scope),
            dimension: a.dimension,
            ...(a.topN !== undefined && a.topN !== null && { topN: a.topN }),
            ...(a.rankBy !== undefined && a.rankBy !== null && { rankBy: a.rankBy }),
          })
        ),
      procurementShare: async (
        _r: unknown,
        a: { numerator: RawAnalysisScopeInput; denominator: RawAnalysisScopeInput }
      ) =>
        unwrap(
          await analysisShare(analysisDeps, {
            numerator: analysisScope(a.numerator),
            denominator: analysisScope(a.denominator),
          })
        ),
      procurementFacets: async (
        _r: unknown,
        a: {
          scope?: RawAnalysisScopeInput | null;
          dimensions: readonly BreakdownDimension[];
          topN?: number | null;
          rankBy?: 'value' | 'count' | null;
        }
      ) =>
        unwrap(
          await analysisFacets(analysisDeps, {
            scope: analysisScope(a.scope),
            dimensions: a.dimensions,
            ...(a.topN !== undefined && a.topN !== null && { topN: a.topN }),
            ...(a.rankBy !== undefined && a.rankBy !== null && { rankBy: a.rankBy }),
          })
        ),

      // ── supplier records ────────────────────────────────────────────────────
      procurementSupplierRecords: async (
        _r: unknown,
        a: { supplierCui: string; first?: number; after?: string }
      ) => {
        const connection = unwrap(
          await getSupplierRecords(repo, a.supplierCui, a.first ?? 20, a.after ?? undefined)
        );
        return {
          total: connection.total,
          edges: connection.edges.map((edge) => ({ cursor: edge.cursor, node: nodeOf(edge.node) })),
          pageInfo: { hasNextPage: connection.hasNextPage, endCursor: connection.endCursor },
        };
      },

      // ── meta ────────────────────────────────────────────────────────────────
      procurementCpvDivisions: async () =>
        unwrap(await listCpvDivisions(repo)).map((d) => ({
          divisionCode: d.code,
          labelEn: d.labelEn,
          labelRo: d.labelRo,
        })),
      procurementCpvCodes: async (_r: unknown, a: { codes: readonly string[] }) =>
        unwrap(await listCpvCodeLabels(repo, a.codes)).map((c) => ({
          cpvCode: c.code,
          labelRo: c.labelRo,
          labelEn: c.labelEn,
          divisionCode: c.divisionCode,
        })),
      procurementResolve: async (_r: unknown, a: { dim: string; q: string; limit?: number }) => {
        // This module owns CPV resolution; identity + territory dims resolve through
        // the kernel's own resolver.
        if (a.dim !== 'cpvDivision' && a.dim !== 'cpv') return [];
        const hits = unwrap(await resolveCpv(repo, a.q, a.limit ?? 10));
        return hits.map((m) => ({
          dim: a.dim,
          value: m.code,
          // `label` is non-null in the contract; `cpv_codes.label_ro` coverage is
          // poor, so an unlabelled code echoes its own code rather than inventing one.
          label: m.label ?? m.code,
          kind: m.level,
          score: m.confidence,
        }));
      },

      // ── concentration (generation-stamped analysis package) ────────────────
      procurementConcentration: async (
        _r: unknown,
        a: { scope?: RawAnalysisScopeInput | null; basis?: string | null }
      ) => {
        const basis = a.basis ?? undefined;
        if (basis !== undefined && basis !== 'value' && basis !== 'count') {
          throw toGraphqlError({
            type: 'InvalidInput',
            message: "basis must be 'value' or 'count'",
            field: 'basis',
          });
        }
        return unwrap(
          await analysisConcentration(analysisDeps, {
            scope: analysisScope(a.scope),
            ...(basis !== undefined && { basis }),
          })
        );
      },
    },

    // ── node field resolvers (the surrogate PK is exposed as `id`) ────────────

    ProcurementProcedure: {
      id: (p: ProcurementProcedure) => p.procedureId,
      authority: (p: ProcurementProcedure) => party(p.authorityCui, p.authorityName),
      // Structural, not fabricated: the table has no dedup columns (see schema.ts).
      isCanonical: () => true,
      dupGroupId: () => null,
    },
    ProcurementContract: {
      id: (c: ProcurementContract) => c.contractId,
      authority: (c: ProcurementContract) => party(c.authorityCui, c.authorityName),
      supplier: (c: ProcurementContract) => party(c.supplierCui, c.supplierName),
      modifications: (c: ProcurementContract) => modificationsLoader.load(c.contractId),
    },
    ProcurementDirectAcquisition: {
      id: (d: ProcurementDirectAcquisition) => d.daId,
      authority: (d: ProcurementDirectAcquisition) => party(d.authorityCui, d.authorityName),
      supplier: (d: ProcurementDirectAcquisition) => party(d.supplierCui, d.supplierName),
    },
    ProcurementContractModification: {
      id: (m: ProcurementModification) => m.modificationId,
      authority: (m: ProcurementModification) => party(m.authorityCui, null),
      supplier: (m: ProcurementModification) => party(m.supplierCui, null),
      parentContract: (m: ProcurementModification) =>
        m.contractId === null ? null : contractLoader.load(m.contractId),
    },

    ProcurementFlowRecord: {
      // The union members are the plain node objects; the surrogate PK discriminates.
      /* eslint-disable-next-line @typescript-eslint/naming-convention -- __resolveType is the GraphQL union discriminator hook */
      __resolveType: (node: Record<string, unknown>) =>
        'contractId' in node ? 'ProcurementContract' : 'ProcurementDirectAcquisition',
    },
  };
};

// ── helpers ────────────────────────────────────────────────────────────────────

/** Unwrap the grain-tagged union member into the node the SDL resolves. */
const nodeOf = (record: SupplierRecord): ProcurementContract | ProcurementDirectAcquisition =>
  record.grain === 'procurement_contract' ? record.contract : record.directAcquisition;
