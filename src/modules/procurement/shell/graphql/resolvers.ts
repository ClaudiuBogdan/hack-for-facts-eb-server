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
 *   - `Entity.procurement` — the cross-source contributor slice.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  makeBatchLoader,
  makeEntityProfileSlice,
  type ApiError,
  type ContributorRegistry,
} from '@/modules/shared/index.js';

import { translateScope, translateSearchFilter, type RawScopeFilter, type RawSearchFilter } from './arg-translation.js';
import { PAGE_SIZE_DEFAULT } from '../../core/constants.js';
import { parseOffsetRequest } from '../../core/search.js';
import {
  authorityCpvSpend,
  getContractDetail,
  getDirectAcquisitionBundle,
  getProcedureDetail,
  getSupplierRecords,
  grainQuality,
  listCpvDivisions,
  repeatedPairs,
  resolveCpv,
  sameDaySplittingCandidates,
  scopeCategoryBreakdown,
  scopeSpendOverTime,
  scopeStats,
  scopeTopAuthorities,
  scopeTopSuppliers,
  supplierConcentration,
  topSuppliersByRegionCpv,
} from '../../core/usecases.js';
import { mapCapabilityGate } from '../repo/mappers.js';

import type { ProcurementAggregateRepo, ProcurementRepo } from '../../core/ports.js';
import type {
  CategoryRow,
  GrainQuality,
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementGrain,
  ProcurementModification,
  ProcurementProcedure,
  SupplierRecord,
  TopPartyRow,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface ProcurementResolverDeps {
  readonly repo: ProcurementRepo;
  readonly aggregate: ProcurementAggregateRepo;
  readonly registry: ContributorRegistry;
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
const party = (cui: string | null, name: string | null): { cui: string | null; name: string | null; displayName: string | null } => ({
  cui,
  name,
  displayName: name ?? cui,
});

const grainOf = (g: string | undefined): ProcurementGrain =>
  g === 'procurement_contract' ? 'procurement_contract' : 'direct_acquisition';

interface SearchArgs {
  filter?: RawSearchFilter | null;
  sort?: string;
  page?: number;
  pageSize?: number;
}

interface ScopeArgs {
  scope?: RawScopeFilter | null;
  grain?: string | null;
  topN?: number;
}

const TOP_N_DEFAULT = 10;

export const makeProcurementResolvers = (deps: ProcurementResolverDeps): Record<string, unknown> => {
  const { repo, aggregate, registry } = deps;

  /** The gate row for a grain, projected onto the client contract. */
  const gateFor = async (grain: ProcurementGrain): Promise<ReturnType<typeof mapCapabilityGate>> => {
    const rows = unwrap(await grainQuality(aggregate));
    const row = rows.find((g: GrainQuality) => g.grain === grain);
    if (row === undefined) throw toGraphqlError({ type: 'Database', message: `grain gate has no row for '${grain}'` });
    return mapCapabilityGate(row);
  };

  const modificationsLoader = makeBatchLoader<readonly ProcurementModification[]>(
    async (contractIds) => unwrap(await repo.modificationsForContracts(contractIds)),
    []
  );

  const contractLoader = makeBatchLoader<ProcurementContract | null>(
    async (contractIds) => unwrap(await repo.contractsByIds(contractIds)),
    null
  );

  const sliceLoader = makeBatchLoader<EntitySummaryShape | null>(async (cuis) => {
    const entries = await Promise.all(
      cuis.map(async (cui) => {
        const slice = unwrap(await makeEntityProfileSlice(registry, 'procurement', cui));
        return [cui, sliceToSummary(slice)] as const;
      })
    );
    return new Map(entries);
  }, null);

  /** Parse `filter`/`sort`/`page`/`pageSize` once, the same way for every grain. */
  const searchArgs = (a: SearchArgs, dateField: 'publicationDate' | 'contractDate' | 'modificationDate') => {
    const filter = unwrap(translateSearchFilter(a.filter, dateField));
    const page = unwrap(parseOffsetRequest(a.page, a.pageSize ?? PAGE_SIZE_DEFAULT, a.sort));
    return { filter, page };
  };

  const scopeArgs = (a: ScopeArgs) => ({
    scope: unwrap(translateScope(a.scope)),
    grain: a.grain ?? null,
  });

  /** `{ items, total, estimated }` → the SDL's page shape. */
  const toPage = <T>(result: { items: readonly T[]; total: number | null; estimated: boolean }) => ({
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
        const detail = unwrap(await getProcedureDetail(repo, a.id));
        if (detail === null) return null;
        return { ...detail, gate: await gateFor('procurement_contract') };
      },
      procurementContract: async (_r: unknown, a: { id: string }) => {
        const detail = unwrap(await getContractDetail(repo, a.id));
        if (detail === null) return null;
        return { ...detail, gate: await gateFor('procurement_contract') };
      },
      procurementDirectAcquisition: async (_r: unknown, a: { id: string }) => {
        const detail = unwrap(await getDirectAcquisitionBundle(repo, a.id));
        if (detail === null) return null;
        return { ...detail, gate: await gateFor('direct_acquisition') };
      },

      // ── scope aggregates ────────────────────────────────────────────────────
      procurementStats: async (_r: unknown, a: ScopeArgs) => {
        const { scope, grain } = scopeArgs(a);
        return unwrap(await scopeStats(aggregate, repo, scope, grain));
      },
      procurementTopAuthorities: async (_r: unknown, a: ScopeArgs) => {
        const { scope, grain } = scopeArgs(a);
        return unwrap(await scopeTopAuthorities(aggregate, scope, grain, a.topN ?? TOP_N_DEFAULT));
      },
      procurementTopSuppliers: async (_r: unknown, a: ScopeArgs) => {
        const { scope, grain } = scopeArgs(a);
        return unwrap(await scopeTopSuppliers(aggregate, scope, grain, a.topN ?? TOP_N_DEFAULT));
      },
      procurementCategoryBreakdown: async (_r: unknown, a: ScopeArgs) => {
        const { scope, grain } = scopeArgs(a);
        return unwrap(await scopeCategoryBreakdown(aggregate, scope, grain));
      },
      procurementSpendOverTime: async (_r: unknown, a: ScopeArgs) => {
        const { scope, grain } = scopeArgs(a);
        return unwrap(await scopeSpendOverTime(aggregate, scope, grain));
      },

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
      procurementGrainQuality: async () => unwrap(await grainQuality(aggregate)).map(mapCapabilityGate),
      procurementCpvDivisions: async () =>
        unwrap(await listCpvDivisions(repo)).map((d) => ({
          divisionCode: d.code,
          labelEn: d.labelEn,
          labelRo: d.labelRo,
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

      // ── the retained analyst / MCP surface ──────────────────────────────────
      procurementRepeatedPairs: async (
        _r: unknown,
        a: EdgeArgs & { authorityCui?: string; supplierCui?: string; minMonths?: number }
      ) => {
        if ((a.authorityCui === undefined) === (a.supplierCui === undefined)) {
          throw new GraphQLError('repeatedPairs requires exactly one of authorityCui / supplierCui', {
            extensions: { code: 'INVALID_INPUT', type: 'InvalidInput' },
          });
        }
        const side: 'authority' | 'supplier' = a.authorityCui !== undefined ? 'authority' : 'supplier';
        const cui = a.authorityCui ?? a.supplierCui ?? '';
        const r = unwrap(
          await repeatedPairs(aggregate, cui, side, {
            ...edgeFilter(a),
            ...(a.minMonths !== undefined && { minMonths: a.minMonths }),
          })
        );
        return edgeResult(r);
      },
      procurementConcentration: async (_r: unknown, a: EdgeArgs & { authorityCui: string }) =>
        unwrap(await supplierConcentration(aggregate, a.authorityCui, edgeFilter(a))),
      procurementAuthorityCpvSpend: async (
        _r: unknown,
        a: { authorityCui: string; grain?: string; cpvDivision?: string[]; monthFrom?: string; monthTo?: string; topN?: number }
      ) => {
        const r = unwrap(
          await authorityCpvSpend(aggregate, a.authorityCui, {
            grain: grainOf(a.grain),
            topN: a.topN ?? 50,
            ...(a.cpvDivision !== undefined && { cpvDivisions: a.cpvDivision }),
            ...(a.monthFrom !== undefined && { monthFrom: a.monthFrom }),
            ...(a.monthTo !== undefined && { monthTo: a.monthTo }),
          })
        );
        return { grain: r.grain, items: r.data, caveats: r.caveats, refreshedAt: r.gate.refreshedAt };
      },
      procurementTopSuppliersByRegionCpv: async (
        _r: unknown,
        a: { region: string; cpvDivision: string; grain?: string; monthFrom?: string; monthTo?: string; topN?: number }
      ) => {
        const r = unwrap(
          await topSuppliersByRegionCpv(aggregate, {
            region: a.region,
            cpvDivision: a.cpvDivision,
            grain: grainOf(a.grain),
            topN: a.topN ?? 20,
            ...(a.monthFrom !== undefined && { monthFrom: a.monthFrom }),
            ...(a.monthTo !== undefined && { monthTo: a.monthTo }),
          })
        );
        return { grain: r.grain, items: r.data, caveats: r.caveats };
      },
      procurementSameDayCandidates: async (
        _r: unknown,
        a: { authorityCui?: string; dateFrom?: string; dateTo?: string; cpvDivision?: string; minSameDayCount?: number; page?: number; pageSize?: number }
      ) => {
        const res = unwrap(
          await sameDaySplittingCandidates(
            aggregate,
            {
              minSameDayCount: a.minSameDayCount ?? 2,
              ...(a.authorityCui !== undefined && { authorityCui: a.authorityCui }),
              ...(a.dateFrom !== undefined && { candidateDateFrom: a.dateFrom }),
              ...(a.dateTo !== undefined && { candidateDateTo: a.dateTo }),
              ...(a.cpvDivision !== undefined && { cpvDivision: a.cpvDivision }),
            },
            { page: a.page ?? 1, pageSize: a.pageSize ?? 20 }
          )
        );
        return res.items;
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

    ProcurementTopPartyRow: {
      authority: (r: TopPartyRow) =>
        r.authorityCui === null ? null : party(r.authorityCui, r.authorityName),
      supplier: (r: TopPartyRow) => (r.supplierCui === null ? null : party(r.supplierCui, r.supplierName)),
      sourceGrain: (r: TopPartyRow) => r.grain,
    },
    ProcurementCategoryRow: { sourceGrain: (r: CategoryRow) => r.grain },

    ProcurementFlowRecord: {
      // The union members are the plain node objects; the surrogate PK discriminates.
      /* eslint-disable-next-line @typescript-eslint/naming-convention -- __resolveType is the GraphQL union discriminator hook */
      __resolveType: (node: Record<string, unknown>) =>
        'contractId' in node ? 'ProcurementContract' : 'ProcurementDirectAcquisition',
    },

    Entity: {
      procurement: async (parent: { cui: string }): Promise<EntitySummaryShape | null> =>
        sliceLoader.load(parent.cui),
    },
  };
};

// ── helpers ────────────────────────────────────────────────────────────────────

/** Unwrap the grain-tagged union member into the node the SDL resolves. */
const nodeOf = (record: SupplierRecord): ProcurementContract | ProcurementDirectAcquisition =>
  record.grain === 'procurement_contract' ? record.contract : record.directAcquisition;

interface EdgeArgs {
  grain?: string;
  monthFrom?: string;
  monthTo?: string;
  topN?: number;
}

const edgeFilter = (
  a: EdgeArgs
): { grain: ProcurementGrain; topN: number; monthFrom?: string; monthTo?: string } => ({
  grain: grainOf(a.grain),
  topN: a.topN ?? 20,
  ...(a.monthFrom !== undefined && { monthFrom: a.monthFrom }),
  ...(a.monthTo !== undefined && { monthTo: a.monthTo }),
});

const edgeResult = (r: {
  grain: ProcurementGrain;
  data: readonly unknown[];
  caveats: readonly string[];
  gate: { refreshedAt: string | null; projectionVersion: string };
}): {
  grain: ProcurementGrain;
  items: readonly unknown[];
  caveats: readonly string[];
  refreshedAt: string | null;
  projectionVersion: string;
} => ({
  grain: r.grain,
  items: r.data,
  caveats: r.caveats,
  refreshedAt: r.gate.refreshedAt,
  projectionVersion: r.gate.projectionVersion,
});

interface EntitySummaryShape {
  cui: string;
  asAuthority: unknown;
  asSupplier: unknown;
  spendByCpvDivision: unknown;
  caveats: unknown;
  refreshedAt: string | null;
}

/** Project a kernel profile slice into the GraphQL `ProcurementEntitySummary` shape. */
const sliceToSummary = (slice: { data?: Record<string, unknown> } | null): EntitySummaryShape | null => {
  const d = slice?.data;
  if (d === undefined) return null;
  return {
    cui: typeof d['cui'] === 'string' ? d['cui'] : '',
    asAuthority: d['asAuthority'] ?? null,
    asSupplier: d['asSupplier'] ?? null,
    spendByCpvDivision: d['spendByCpvDivision'] ?? [],
    caveats: d['caveats'] ?? [],
    refreshedAt: (d['refreshedAt'] as string | null) ?? null,
  };
};
