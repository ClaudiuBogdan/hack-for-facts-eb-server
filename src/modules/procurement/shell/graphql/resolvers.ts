/**
 * Procurement module — GraphQL resolvers (plan §6). Thin: parse args → call the
 * SAME usecase MCP calls → unwrap `Result` to a `GraphQLError`. Cursor pages →
 * Relay connections (per-edge cursor bound to the active fhash). `Entity.procurement`
 * goes through the kernel `makeEntityProfileSlice` (contributor parity, §14.7) via a
 * CUI DataLoader so an entity-list fan-out is one rollup probe per batch.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  makeBatchLoader,
  makeEntityProfileSlice,
  type ApiError,
  type CollectionFilterSpec,
  type ContributorRegistry,
  type CursorPage,
  type FilterInput,
} from '@/modules/shared/index.js';

import {
  contractFilterSpec,
  daFilterSpec,
  modificationFilterSpec,
  procedureFilterSpec,
} from '../../core/filters.js';
import {
  authorityCpvSpend,
  getContractDetail,
  getProcedureDetail,
  grainQuality,
  listCpvDivisions,
  listModifications,
  listModificationsAboveDelta,
  repeatedPairs,
  resolveCpv,
  sameDaySplittingCandidates,
  searchContracts,
  searchDirectAcquisitions,
  searchProcedures,
  supplierConcentration,
  topAuthorities,
  topSuppliers,
  topSuppliersByRegionCpv,
} from '../../core/usecases.js';

import type { ProcurementAggregateRepo, ProcurementRepo } from '../../core/ports.js';
import type {
  ProcurementContract,
  ProcurementDirectAcquisition,
  ProcurementGrain,
  ProcurementModification,
  ProcurementProcedure,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface ProcurementResolverDeps {
  readonly repo: ProcurementRepo;
  readonly aggregate: ProcurementAggregateRepo;
  readonly registry: ContributorRegistry;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, { extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type } });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

/** Build a Relay connection from a CursorPage (per-edge cursor bound to fhash). */
const toConnection = <T>(
  page: CursorPage<T>,
  spec: CollectionFilterSpec,
  filter: FilterInput,
  sortKey: string,
  keysOf: (node: T) => readonly (string | null)[]
): { edges: { node: T; cursor: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } => {
  const fhash = fhashFor(spec, filter);
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort: sortKey, dir: 'desc', fhash, lastKeys: keysOf(node) }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
  };
};

const grainOf = (g: string | undefined): ProcurementGrain =>
  g === 'procurement_contract' ? 'procurement_contract' : 'direct_acquisition';

interface ListArgs {
  filter?: FilterInput;
  first?: number;
  after?: string;
}

export const makeProcurementResolvers = (deps: ProcurementResolverDeps): Record<string, unknown> => {
  const { repo, aggregate, registry } = deps;

  // The CPV division catalog is 45 static rows — load once, cache for the process,
  // and resolve `cpvDivision` labels from the map (no per-row catalog read).
  let divisionMap: Map<string, { code: string; labelEn: string; labelRo: string | null }> | null = null;
  const divisions = async (): Promise<Map<string, { code: string; labelEn: string; labelRo: string | null }>> => {
    if (divisionMap !== null) return divisionMap;
    const r = await repo.listCpvDivisions();
    divisionMap = new Map(r.isOk() ? r.value.map((d) => [d.code, d]) : []);
    return divisionMap;
  };
  const resolveDivision = async (code: string | null): Promise<{ code: string; labelEn: string; labelRo: string | null } | null> => {
    if (code === null) return null;
    const hit = (await divisions()).get(code);
    return hit ?? { code, labelEn: '', labelRo: null };
  };

  // Batch + dedupe `Entity.procurement` fan-out → one rollup probe per CUI per tick.
  const sliceLoader = makeBatchLoader<EntitySummaryShape | null>(async (cuis) => {
    const entries = await Promise.all(
      cuis.map(async (cui) => {
        const slice = unwrap(await makeEntityProfileSlice(registry, 'procurement', cui));
        return [cui, sliceToSummary(slice)] as const;
      })
    );
    return new Map(entries);
  }, null);

  return {
    Query: {
      procurementProcedure: async (_r: unknown, a: { id: string }) => unwrap(await repo.getProcedure(a.id)),
      procurementProcedureDetail: async (_r: unknown, a: { id: string }) =>
        unwrap(await getProcedureDetail(repo, a.id)),
      procurementProcedures: async (_r: unknown, a: ListArgs) => {
        const filter = a.filter ?? {};
        const page = unwrap(
          await searchProcedures(repo, filter, { first: a.first ?? 20, ...(a.after !== undefined && { after: a.after }) })
        );
        return toConnection(page, procedureFilterSpec, filter, 'publication_date', (n: ProcurementProcedure) => [
          n.publicationDate,
          n.procedureId,
        ]);
      },

      procurementContract: async (_r: unknown, a: { id: string }) => unwrap(await repo.getContract(a.id)),
      procurementContractDetail: async (_r: unknown, a: { id: string }) =>
        unwrap(await getContractDetail(repo, a.id)),
      procurementContracts: async (_r: unknown, a: ListArgs) => {
        const filter = a.filter ?? {};
        const page = unwrap(
          await searchContracts(repo, filter, { first: a.first ?? 20, ...(a.after !== undefined && { after: a.after }) })
        );
        return toConnection(page, contractFilterSpec, filter, 'contract_date', (n: ProcurementContract) => [
          n.contractDate,
          n.contractId,
        ]);
      },

      procurementDirectAcquisitions: async (_r: unknown, a: { filter: FilterInput; first?: number; after?: string }) => {
        const filter = a.filter;
        const page = unwrap(
          await searchDirectAcquisitions(repo, filter, { first: a.first ?? 20, ...(a.after !== undefined && { after: a.after }) })
        );
        return toConnection(page, daFilterSpec, filter, 'finalization_date', (n: ProcurementDirectAcquisition) => [
          n.finalizationDate,
          n.daId,
        ]);
      },
      procurementDirectAcquisition: async (_r: unknown, a: { id: string }) =>
        unwrap(await repo.getDirectAcquisition(a.id)),

      procurementModifications: async (_r: unknown, a: ListArgs & { minDeltaPct?: number }) => {
        const filter = a.filter ?? {};
        const pageReq = { first: a.first ?? 20, ...(a.after !== undefined && { after: a.after }) };
        const page = unwrap(
          a.minDeltaPct !== undefined
            ? await listModificationsAboveDelta(repo, a.minDeltaPct, filter, pageReq)
            : await listModifications(repo, filter, pageReq)
        );
        // Sort key MUST mirror the repo (it binds minDeltaPct into the cursor — Codex #7).
        const sortKey = a.minDeltaPct !== undefined ? `modification_date|d${String(a.minDeltaPct)}` : 'modification_date';
        return toConnection(page, modificationFilterSpec, filter, sortKey, (n: ProcurementModification) => [
          n.modificationDate,
          n.modificationId,
        ]);
      },

      procurementTopSuppliers: async (_r: unknown, a: EdgeArgs & { authorityCui: string }) => {
        const r = unwrap(await topSuppliers(aggregate, a.authorityCui, edgeFilter(a)));
        return edgeResult(r);
      },
      procurementTopAuthorities: async (_r: unknown, a: EdgeArgs & { supplierCui: string }) => {
        const r = unwrap(await topAuthorities(aggregate, a.supplierCui, edgeFilter(a)));
        return edgeResult(r);
      },
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
        // Exactly one of authorityCui / supplierCui is defined (the XOR check above).
        const cui = a.authorityCui ?? a.supplierCui ?? '';
        const r = unwrap(
          await repeatedPairs(aggregate, cui, side, { ...edgeFilter(a), ...(a.minMonths !== undefined && { minMonths: a.minMonths }) })
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

      procurementGrainQuality: async () => unwrap(await grainQuality(aggregate)),
      procurementCpvDivisions: async () => unwrap(await listCpvDivisions(repo)),
      procurementResolve: async (_r: unknown, a: { dim: string; q: string; limit?: number }) => {
        // This module owns CPV resolution (cpvDivision/cpv → the reliable 45-row
        // hierarchy + best-effort 8-digit). Identity (authority/supplier) and
        // territory (region/county) dims resolve via the kernel's own resolve query.
        if (a.dim === 'cpvDivision' || a.dim === 'cpv') {
          const hits = unwrap(await resolveCpv(repo, a.q, a.limit ?? 10));
          return hits.map((m) => ({ value: m.code, label: m.label, kind: m.level, confidence: m.confidence }));
        }
        return [];
      },
    },

    // CPV division field on entity rows: resolve the full division from the cached
    // 45-row map (no per-row catalog read). `authority`/`supplier` hand the kernel
    // Entity resolver a { cui } so its own field resolvers take over (lazy join).
    ProcurementProcedure: {
      cpvDivision: (p: ProcurementProcedure) => resolveDivision(p.cpvDivisionCode),
      authority: (p: ProcurementProcedure) => (p.authorityCui !== null ? { cui: p.authorityCui } : null),
    },
    ProcurementContract: {
      cpvDivision: (p: ProcurementContract) => resolveDivision(p.cpvDivisionCode),
      authority: (p: ProcurementContract) => (p.authorityCui !== null ? { cui: p.authorityCui } : null),
      supplier: (p: ProcurementContract) => (p.supplierCui !== null ? { cui: p.supplierCui } : null),
      modifications: async (p: ProcurementContract) => unwrap(await repo.getContractModifications(p.contractId)),
    },
    ProcurementDirectAcquisition: {
      cpvDivision: (p: ProcurementDirectAcquisition) => resolveDivision(p.cpvDivisionCode),
      authority: (p: ProcurementDirectAcquisition) => (p.authorityCui !== null ? { cui: p.authorityCui } : null),
      supplier: (p: ProcurementDirectAcquisition) => (p.supplierCui !== null ? { cui: p.supplierCui } : null),
    },

    Entity: {
      procurement: async (parent: { cui: string }): Promise<EntitySummaryShape | null> =>
        sliceLoader.load(parent.cui),
    },
  };
};

// ── helpers ────────────────────────────────────────────────────────────────────

interface EdgeArgs {
  grain?: string;
  monthFrom?: string;
  monthTo?: string;
  topN?: number;
}

const edgeFilter = (a: EdgeArgs): { grain: ProcurementGrain; topN: number; monthFrom?: string; monthTo?: string } => ({
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
}): { grain: ProcurementGrain; items: readonly unknown[]; caveats: readonly string[]; refreshedAt: string | null; projectionVersion: string } => ({
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
