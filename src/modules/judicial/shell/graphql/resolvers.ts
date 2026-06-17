/**
 * Judicial module — GraphQL resolvers (plan 08 §3.3). Thin: parse args → call the
 * SAME usecase MCP calls. `ApiError` → `GraphQLError`. Cursor pages → Relay
 * connections. The `JudicialLegalRef.targetAct` field resolves through the kernel
 * `legalActLoader()` (the legal module 05 registers it; tolerates dangling → null).
 *
 * PRIVACY: no resolver reads a name column. `JudicialPartyView.name` is produced
 * by the usecase via the gated dictionary; the resolver just passes it through.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  fhashFor,
  normalizeCui,
  type ApiError,
  type CursorPage,
  type FilterInput,
  type LegalActByIdLoader,
} from '@/modules/shared/index.js';

import {
  getCaseDetail,
  getCompanyLitigation,
  getCourtCaseload,
  getCourtTree,
  listCases,
  listCasesCitingAct,
  listCompanyLitigationCases,
  listCourts,
  resolveJudicialFilters,
  type JudicialRepos,
} from '../../core/usecases.js';
import { judicialCasesSpec } from '../filters/judicial.spec.js';
import { companyCasesFhash } from '../repo/company-link-repo.js';

import type { CompanyLitigationFilter } from '../../core/ports.js';
import type {
  JudicialCase,
  JudicialCaseCitation,
  JudicialCaseLink,
  JudicialResolveDim,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface JudicialResolverDeps {
  readonly repos: JudicialRepos;
  /** Lazily fetched — the legal module registers the loader at boot; may be undefined. */
  readonly legalActLoader: () => LegalActByIdLoader | undefined;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, { extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type } });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

const sortValueOf = (c: JudicialCase, sort: 'modifiedAt' | 'openedAt'): string =>
  (sort === 'modifiedAt' ? c.latestSourceModifiedAt : c.sourceOpenedAt) ?? '';

/** Read the optional JD-1 narrowing filter off GraphQL args. */
const litigationFilter = (args: {
  courtLevel?: string[];
  yearFrom?: number;
  yearTo?: number;
  category?: string[];
}): CompanyLitigationFilter | undefined => {
  const f: { courtLevels?: string[]; yearFrom?: number; yearTo?: number; categories?: string[] } = {};
  if (args.courtLevel !== undefined) f.courtLevels = args.courtLevel;
  if (args.category !== undefined) f.categories = args.category;
  if (args.yearFrom !== undefined) f.yearFrom = args.yearFrom;
  if (args.yearTo !== undefined) f.yearTo = args.yearTo;
  return Object.keys(f).length > 0 ? f : undefined;
};

export const makeJudicialResolvers = (deps: JudicialResolverDeps): Record<string, unknown> => {
  const { repos } = deps;

  return {
    Query: {
      judicialCourts: async (_r: unknown, args: { filter?: FilterInput }) =>
        unwrap(await listCourts(repos, args.filter ?? {})),

      judicialCourt: async (_r: unknown, args: { institutionCode: string }) => {
        const tree = unwrap(await getCourtTree(repos, args.institutionCode));
        // Surface the court directly; `children` is a field resolver on JudicialCourt.
        return tree === null ? null : { ...tree.court, childrenPreloaded: tree.children };
      },

      judicialCase: async (
        _r: unknown,
        args: { caseId?: string; institutionCode?: string; caseNumber?: string }
      ) =>
        unwrap(
          await getCaseDetail(repos, {
            ...(args.caseId !== undefined && { caseId: args.caseId }),
            ...(args.institutionCode !== undefined && { institutionCode: args.institutionCode }),
            ...(args.caseNumber !== undefined && { caseNumber: args.caseNumber }),
          })
        ),

      judicialCases: async (
        _r: unknown,
        args: { filter?: FilterInput; sort?: string; dir?: string; first?: number; after?: string }
      ) => {
        const sort = args.sort === 'openedAt' ? 'openedAt' : 'modifiedAt';
        const dir = args.dir === 'ASC' ? 'asc' : 'desc';
        const filter = args.filter ?? {};
        const page = unwrap(
          await listCases(repos, {
            filter,
            sort,
            dir,
            page: { first: args.first ?? 20, ...(args.after !== undefined && { after: args.after }) },
          })
        );
        return toCaseConnection(page, filter, sort, dir);
      },

      judicialCaseload: async (_r: unknown, args: { groupBy: string; filter?: FilterInput }) => {
        const groupBy = args.groupBy as 'court' | 'category' | 'year' | 'courtLevel';
        return unwrap(await getCourtCaseload(repos, groupBy, args.filter ?? {}));
      },

      judicialCompanyLitigation: async (
        _r: unknown,
        args: { cui: string; courtLevel?: string[]; yearFrom?: number; yearTo?: number; category?: string[] }
      ) => unwrap(await getCompanyLitigation(repos, args.cui, litigationFilter(args))),

      judicialCompanyLitigationCases: async (
        _r: unknown,
        args: {
          cui: string;
          courtLevel?: string[];
          yearFrom?: number;
          yearTo?: number;
          category?: string[];
          first?: number;
          after?: string;
        }
      ) => {
        const filter = litigationFilter(args);
        const page = unwrap(
          await listCompanyLitigationCases(
            repos,
            args.cui,
            { first: args.first ?? 20, ...(args.after !== undefined && { after: args.after }) },
            filter
          )
        );
        return toCaseLinkConnection(page, args.cui, filter);
      },

      judicialCasesCitingAct: async (
        _r: unknown,
        args: { targetActId: string; first?: number; after?: string }
      ) => {
        const page = unwrap(
          await listCasesCitingAct(repos, args.targetActId, {
            first: args.first ?? 20,
            ...(args.after !== undefined && { after: args.after }),
          })
        );
        return toCaseCitationConnection(page, args.targetActId);
      },

      judicialResolve: async (_r: unknown, args: { dim: string; q: string; limit?: number }) =>
        unwrap(await resolveJudicialFilters(repos, args.dim as JudicialResolveDim, args.q, args.limit ?? 10)),
    },

    JudicialCourt: {
      // children: eagerly attached by judicialCourt; otherwise fetch on demand.
      children: async (parent: { institutionCode: string; childrenPreloaded?: unknown }) => {
        if (parent.childrenPreloaded !== undefined) return parent.childrenPreloaded;
        return unwrap(await repos.courts.listChildren(parent.institutionCode));
      },
    },

    JudicialLegalRef: {
      // Resolve targetAct via the kernel cross-module loader (tolerates dangling → null).
      targetAct: async (parent: { targetActId: string | null }) => {
        if (parent.targetActId === null) return null;
        const loader = deps.legalActLoader();
        if (loader === undefined) return null;
        return loader.load(parent.targetActId);
      },
    },
  };
};

// ── connection projections ──────────────────────────────────────────────────────

const toCaseConnection = (
  page: CursorPage<JudicialCase>,
  filter: FilterInput,
  sort: 'modifiedAt' | 'openedAt',
  dir: 'asc' | 'desc'
) => {
  // Per-edge keyset cursor bound to the SAME fhash the repo used (filter identity),
  // so each cursor round-trips through decodeCursor on the next page.
  const fhash = fhashFor(judicialCasesSpec, filter);
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort, dir, fhash, lastKeys: [sortValueOf(node, sort), node.caseId] }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
    totalCount: null,
  };
};

const toCaseLinkConnection = (
  page: CursorPage<JudicialCaseLink>,
  cui: string,
  filter: CompanyLitigationFilter | undefined
) => {
  // Match the repo's normalized-CUI + filter-bound fhash exactly so the per-edge
  // cursors round-trip through the repo's decodeCursor.
  const normalized = normalizeCui(cui) ?? cui;
  const fhash = companyCasesFhash(normalized, filter);
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort: 'caseId', dir: 'desc', fhash, lastKeys: [node.caseId] }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
    totalCount: null,
  };
};

const toCaseCitationConnection = (page: CursorPage<JudicialCaseCitation>, targetActId: string) => {
  const fhash = `judicial_cases_citing:${targetActId}`;
  // The citation cursor's keyset is the legal-reference id (the repo's sort key),
  // which is not on JudicialCaseCitation; use page.next for the endCursor (the only
  // cursor a client follows). Per-edge cursors mirror the case id for stability.
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort: 'caseId', dir: 'desc', fhash, lastKeys: [node.caseId] }),
  }));
  return {
    edges,
    pageInfo: { hasNextPage: page.next !== null, endCursor: page.next },
    totalCount: null,
  };
};
