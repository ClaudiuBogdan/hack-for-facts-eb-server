/**
 * Companies module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase MCP would. `ApiError` → `GraphQLError` with `extensions.code`. The list
 * is a connection projection over the offset-backed usecase (REST would be offset;
 * GraphQL is connection — the two modes are not interchangeable, §6).
 * `Entity.company` resolves through the kernel `makeEntityProfileSlice`
 * (contributor parity §14.7) keyed by CUI — one path, not two.
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  decodeCursor,
  fhashFor,
  invalidInput,
  makeEntityProfileSlice,
  normalizeOffset,
  type ApiError,
  type ContributorRegistry,
  type FilterInput,
} from '@/modules/shared/index.js';

import { companiesFilterSpec } from '../../core/filters.js';
import {
  makeCompanyCountyProfile,
  makeCompanyFinancials,
  makeCompanyList,
  makeCompanyProfileData,
  makeCompanyPublicMoney,
  makeCompanyResolve,
  normalizeCuiFilter,
  toCompanyResolveHits,
  type CompanyUsecaseDeps,
} from '../../core/usecases.js';

import type { CompaniesRepository } from '../../core/ports.js';
import type {
  CompanyEntitySlice,
  CompanyGroupBy,
  CompanyResolveDim,
  CompanySort,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface CompaniesResolverDeps extends CompanyUsecaseDeps {
  readonly repo: CompaniesRepository;
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

const GQL_SORT: Readonly<Record<string, CompanySort>> = {
  NAME: 'name',
  REGISTRATION_DATE: 'registrationDate',
  CUI: 'cui',
};
const GQL_GROUP_BY: Readonly<Record<string, CompanyGroupBy>> = {
  COUNTY: 'county',
  STATUS: 'status',
  CAEN_DIVISION: 'caenDivision',
};
const GQL_RESOLVE_DIM: Readonly<Record<string, CompanyResolveDim>> = {
  NAME: 'name',
  REGNUM: 'regnum',
  CAEN: 'caen',
  COUNTY: 'county',
};

export const makeCompaniesResolvers = (deps: CompaniesResolverDeps): Record<string, unknown> => {
  return {
    Query: {
      // Returns the profile WITHOUT public money; `Company.publicMoney` resolves
      // it lazily so a query that does not select it skips the ~1.2s flows scan.
      company: async (_r: unknown, args: { cui: string }) =>
        unwrap(await makeCompanyProfileData(deps, args.cui)),

      companies: async (
        _r: unknown,
        args: { filter?: FilterInput; q?: string; sort?: string; first?: number; after?: string }
      ) => {
        const filter = args.filter ?? {};
        const sort = GQL_SORT[args.sort ?? 'NAME'] ?? 'name';
        const pageSize = Math.min(Math.max(args.first ?? 20, 1), 100);
        // Compute the cursor fhash from the NORMALIZED filter (the same the usecase
        // applies) so `RO2816464` and `2816464` page the SAME data under the SAME
        // hash — otherwise a re-formatted but equivalent CUI breaks pagination.
        const normForHash = normalizeCuiFilter(filter);
        if (normForHash.isErr()) throw toGraphqlError(normForHash.error);
        const fhash = fhashFor(companiesFilterSpec, normForHash.value);

        // The connection is offset-backed but the cursor is the kernel envelope:
        // `keys[0]` is the 1-based page index, validated against fhash/sort/dir so a
        // filter-mismatched cursor is rejected (§14.3) — not silently re-applied.
        let pageFromCursor: number | undefined;
        if (args.after != null) {
          const decoded = decodeCursor(args.after, { sort, dir: 'asc', fhash });
          if (decoded.isErr()) throw toGraphqlError(decoded.error);
          const prev = Number(decoded.value.keys[0]);
          if (!Number.isInteger(prev) || prev < 1) {
            throw toGraphqlError(invalidInput('malformed cursor; restart pagination', 'after'));
          }
          pageFromCursor = prev + 1;
        }

        const page = normalizeOffset(pageFromCursor, pageSize);
        const res = unwrap(
          await makeCompanyList(deps, {
            filter,
            ...(args.q !== undefined && { q: args.q }),
            sort,
            page,
          })
        );
        const edges = res.rows.map((node) => ({
          node,
          // offset-backed: the cursor encodes the page index so `after` advances one page.
          cursor: buildNextCursor({ sort, dir: 'asc', fhash, lastKeys: [String(page.page)] }),
        }));
        const consumed = page.page * page.pageSize;
        return {
          edges,
          pageInfo: {
            hasNextPage:
              res.rows.length === page.pageSize && (res.totalEstimated || res.total > consumed),
            endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
          },
          totalCount: res.total,
          totalEstimated: res.totalEstimated,
        };
      },

      companyFinancials: async (_r: unknown, args: { cui: string }) =>
        unwrap(await makeCompanyFinancials(deps, args.cui)),

      companyResolve: async (_r: unknown, args: { dim: string; q: string; limit?: number }) => {
        const dim = GQL_RESOLVE_DIM[args.dim] ?? 'name';
        const res = unwrap(await makeCompanyResolve(deps, dim, args.q, args.limit ?? 10));
        // Shared mapper — identical shape on GraphQL + MCP (audit M14).
        return toCompanyResolveHits(res);
      },

      companyCountyProfile: async (
        _r: unknown,
        args: { filter?: FilterInput; groupBy?: string }
      ) => {
        const groupBy = GQL_GROUP_BY[args.groupBy ?? 'COUNTY'] ?? 'county';
        const res = unwrap(await makeCompanyCountyProfile(deps, groupBy, args.filter ?? {}));
        return {
          groupBy: args.groupBy ?? 'COUNTY',
          groups: res.groups,
          denominator: res.denominator,
          coverage: res.coverage,
        };
      },
    },

    Company: {
      // Lazy public-money slice (kernel FlowsRepo, payee/`in`). Only the
      // ~1.2s-on-a-high-degree-payee flows scan runs when the client selects it.
      publicMoney: async (parent: { cui: string }) =>
        unwrap(await makeCompanyPublicMoney(deps, parent.cui)),
    },

    Entity: {
      // Contributor parity (§14.7): resolve through the registry. The contributor's
      // `profileSlice` carries the lean `CompanyEntitySlice` in `slice.data`.
      company: async (parent: { cui: string }): Promise<CompanyEntitySlice | null> => {
        const slice = unwrap(await makeEntityProfileSlice(deps.registry, 'companies', parent.cui));
        if (slice?.data === undefined) return null;
        return slice.data as unknown as CompanyEntitySlice;
      },
    },

    // Enum value mapping (@graphql-tools/schema convention): keys are the GraphQL
    // enum NAMES (SAFE/UNMATCHED), values are the INTERNAL representation the domain
    // model emits ('safe'/'unmatched'). graphql-tools matches an internal value to
    // its enum name via this map, so serialization of the lowercase domain value
    // succeeds. (The keys MUST be the enum names defined in the SDL.)
    CompanyMatchConfidence: { SAFE: 'safe', UNMATCHED: 'unmatched' },
  };
};
