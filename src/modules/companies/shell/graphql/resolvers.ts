/**
 * Companies module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase MCP would. `ApiError` → `GraphQLError` with `extensions.code`. The list
 * is a connection projection over the offset-backed usecase (REST would be offset;
 * GraphQL is connection — the two modes are not interchangeable, §6).
 * `Entity.company` resolves through the kernel `makeEntityProfileSlice`
 * (contributor parity §14.7) keyed by CUI — one path, not two.
 */

import { GraphQLError, type GraphQLResolveInfo } from 'graphql';
import { err, type Result } from 'neverthrow';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  decodeCursor,
  fhashFor,
  guardServedFacts,
  invalidInput,
  isAccessRefusal,
  makeEntityProfileSlice,
  normalizeOffset,
  owningResultGuardOf,
  responsePathOf,
  serviceUnavailable,
  type ApiError,
  type ContributorRegistry,
  type FilterInput,
} from '@/modules/shared/index.js';

import { selectedFieldNames } from './selected-fields.js';
import { companiesFilterSpec } from '../../core/filters.js';
import {
  confirmServedScope,
  registryScopeKey,
  type CompanyRegistryEnvelope,
} from '../../core/registry.js';
import {
  makeCompanyComposition,
  makeCompanyCountyProfile,
  makeCompanyFinancials,
  makeCompanyList,
  makeCompanyRegistry,
  makeCompanyResolve,
  dropWithheldCuiInclusion,
  normalizeCuiFilter,
  toCompanyResolveHits,
  toCompanyResolveResult,
  type CompanyComposition,
  type CompanyUsecaseDeps,
} from '../../core/usecases.js';

import type { CompaniesRepository } from '../../core/ports.js';
import type {
  CompanyEntitySlice,
  CompanyGroupBy,
  CompanyResolveDim,
  CompanySort,
} from '../../core/types.js';
import type { HubStatsProvider } from '../hub-stats-cache.js';

export interface CompaniesResolverDeps extends CompanyUsecaseDeps {
  readonly repo: CompaniesRepository;
  readonly registry: ContributorRegistry;
  /** Shared with the MCP tool, so both surfaces read the SAME cached snapshot. */
  readonly hubStats: HubStatsProvider;
}

const toGraphqlError = (error: ApiError): GraphQLError =>
  new GraphQLError(error.message, {
    extensions: { code: GRAPHQL_ERROR_CODE[error.type], type: error.type },
  });

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr()) throw toGraphqlError(result.error);
  return result.value;
};

/**
 * The owning `company` root's composition, carried on the Company object it
 * returns (a symbol key: never a schema field, never serialized). The lazy
 * Company fields project their part from it: each was read inside the root's
 * pin and covered by its single final recheck.
 */
const PREPARED = Symbol('preparedCompany');

const NOT_PREPARED =
  'this company field is served only with its company(cui) read; select it under company(cui)';

const partsOf = (parent: object): CompanyComposition | undefined =>
  (parent as { [PREPARED]?: CompanyComposition })[PREPARED];

/** A part the owning root did not prepare is refused, never read outside its pin. */
const notPrepared = (): Result<never, ApiError> => err(serviceUnavailable(NOT_PREPARED));

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
  /**
   * The ONE resolve both GraphQL fields serve. NAME/REGNUM hits are read and
   * rechecked under one pin; like a Company root, the served answer (its
   * returned CUIs and its scope, zero hits included) is decided once more
   * when the whole operation settled, else this root is withheld. No re-read.
   */
  const resolveOwned = async (
    args: { dim: string; q: string; limit?: number; registryScope?: string | null },
    context: unknown,
    info: GraphQLResolveInfo | undefined
  ) => {
    const dim = GQL_RESOLVE_DIM[args.dim] ?? 'name';
    const expected = args.registryScope ?? undefined;
    const res = unwrap(
      await makeCompanyResolve(
        deps,
        dim,
        args.q,
        args.limit ?? 10,
        expected === undefined ? {} : { expectedScopeKey: expected }
      )
    );
    const scope = res.registry;
    const guard = owningResultGuardOf(context);
    if (scope !== null && guard !== null && info !== undefined) {
      const cuis = res.matches.flatMap((m) => (m.cui === null ? [] : [m.cui]));
      guard.confirm(responsePathOf(info.path), () => confirmServedScope(deps.repo, scope, cuis));
    }
    return res;
  };

  return {
    Query: {
      // ONE owning response per company root (aliases and repeated roots each
      // their own): the profile and only the SELECTED lazy parts (public
      // money, quality assessment, registration diff; fragments and
      // @skip/@include followed) are read inside one pin and rechecked once
      // after all of them. A refusal withholds this whole Company; a query
      // that selects no lazy part still skips the ~1.2s flows scan.
      company: async (
        _r: unknown,
        args: { cui: string },
        context?: unknown,
        info?: GraphQLResolveInfo
      ) => {
        const selected = selectedFieldNames(info);
        const composition = unwrap(
          await makeCompanyComposition(deps, args.cui, {
            publicMoney: selected.has('publicMoney'),
            financialQualityAssessment: selected.has('financialQualityAssessment'),
            registrationDiff: selected.has('registrationDiff'),
          })
        );
        if (composition === null) return null;
        // The served Company is decided once more when the whole operation
        // settled (another root may still be pending): its returned CUI and
        // the scope it was read under must still hold, or the transport
        // withholds THIS root (its own path, aliases included). No re-read.
        const guard = owningResultGuardOf(context);
        if (guard !== null && info !== undefined) {
          const { cui, registry } = composition.profile;
          guard.confirm(responsePathOf(info.path), () =>
            confirmServedScope(deps.repo, registry.registry, [cui])
          );
        }
        return { ...composition.profile, [PREPARED]: composition };
      },

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
        //
        // Withheld ids are dropped BEFORE the hash for the same reason: the
        // usecase drops them too, so hashing the raw list would key the cursor on
        // a filter that is never executed. `makeCompanyList` still receives the
        // RAW filter — it owns the empty-after-drop case, which must answer an
        // empty page rather than trip `rejectEmptyIn`.
        const normForHash = normalizeCuiFilter(dropWithheldCuiInclusion(filter).filter);
        if (normForHash.isErr()) throw toGraphqlError(normForHash.error);
        const fhash = fhashFor(companiesFilterSpec, normForHash.value);

        // The connection is offset-backed but the cursor is the kernel envelope:
        // `keys[0]` is the 1-based page index, validated against fhash/sort/dir so a
        // filter-mismatched cursor is rejected (§14.3) — not silently re-applied.
        // `keys[1]` is the registry scope key of the page that issued it: a
        // later page under another edition, publication or access epoch is
        // refused (restart pagination), never silently switched.
        let pageFromCursor: number | undefined;
        let expectedScopeKey: string | undefined;
        if (args.after != null) {
          const decoded = decodeCursor(args.after, { sort, dir: 'asc', fhash });
          if (decoded.isErr()) throw toGraphqlError(decoded.error);
          const prev = Number(decoded.value.keys[0]);
          const scopeKey = decoded.value.keys[1];
          if (!Number.isInteger(prev) || prev < 1 || scopeKey === undefined || scopeKey === '') {
            throw toGraphqlError(invalidInput('malformed cursor; restart pagination', 'after'));
          }
          pageFromCursor = prev + 1;
          expectedScopeKey = scopeKey;
        }

        const page = normalizeOffset(pageFromCursor, pageSize);
        const res = unwrap(
          await makeCompanyList(deps, {
            filter,
            ...(args.q !== undefined && { q: args.q }),
            sort,
            page,
            ...(expectedScopeKey !== undefined && { expectedScopeKey }),
          })
        );
        const edges = res.rows.map((node) => ({
          node,
          // offset-backed: the cursor encodes the page index so `after` advances one page.
          cursor: buildNextCursor({
            sort,
            dir: 'asc',
            fhash,
            lastKeys: [String(page.page), res.scopeKey],
          }),
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
          registry: res.registry,
        };
      },

      companyFinancials: async (_r: unknown, args: { cui: string }) =>
        unwrap(await makeCompanyFinancials(deps, args.cui)),

      // Shared mappers — identical shape on GraphQL + MCP (audit M14); the
      // array field is the result's hits, without its metadata.
      companyResolve: async (
        _r: unknown,
        args: { dim: string; q: string; limit?: number },
        context?: unknown,
        info?: GraphQLResolveInfo
      ) => toCompanyResolveHits(await resolveOwned(args, context, info)),

      companyResolveResult: async (
        _r: unknown,
        args: { dim: string; q: string; limit?: number; registryScope?: string | null },
        context?: unknown,
        info?: GraphQLResolveInfo
      ) => toCompanyResolveResult(await resolveOwned(args, context, info)),

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
          registry: res.registry,
        };
      },

      // Cache-bound: `hubStats.get()` rechecks the scope fresh and serves only
      // an entry of the current scope.
      companyHubStats: async () => unwrap(await deps.hubStats.get()),

      // Fresh, never cached: the client pins against it.
      companyRegistry: async () => unwrap(await makeCompanyRegistry(deps)),
    },

    Company: {
      // Prepared by the owning `company` root only when selected (the
      // ~1.2s-on-a-high-degree-payee flows scan included). An ordinary part
      // failure stays this nullable field's error while access holds.
      publicMoney: (parent: object) => unwrap(partsOf(parent)?.publicMoney ?? notPrepared()),
      // Advisory quality flags — same pattern.
      financialQualityAssessment: (parent: object) =>
        unwrap(partsOf(parent)?.financialQualityAssessment ?? notPrepared()),
      // Read under the root's pin; a moved scope refused the whole Company.
      registrationDiff: (parent: object) =>
        unwrap(partsOf(parent)?.registrationDiff ?? notPrepared()),
    },

    CompanyRegistryEnvelope: {
      scopeKey: (parent: CompanyRegistryEnvelope) => registryScopeKey(parent),
    },

    Entity: {
      // Contributor parity (§14.7): resolve through the registry. The contributor's
      // `profileSlice` carries the lean `CompanyEntitySlice` in `slice.data`.
      company: async (
        parent: { cui: string },
        _args?: unknown,
        context?: unknown,
        info?: GraphQLResolveInfo
      ): Promise<CompanyEntitySlice | null> => {
        const res = await makeEntityProfileSlice(deps.registry, 'companies', parent.cui);
        if (res.isErr()) {
          // A guard refusal withholds the owning Entity (its organization and
          // every other fact), not just this nullable field.
          const guard = owningResultGuardOf(context);
          if (guard !== null && info !== undefined && isAccessRefusal(res.error)) {
            guard.refuse(responsePathOf(info.path.prev), res.error);
          }
          throw toGraphqlError(res.error);
        }
        const slice = res.value;
        if (slice?.data === undefined) return null;
        const data = slice.data as unknown as CompanyEntitySlice;
        // The final decision for the slice's scope and the CUI's parent comes
        // after every selected field of the owning Entity settled.
        const contributor = deps.registry.get('companies');
        if (contributor?.confirmServed !== undefined) {
          const confirmServed = contributor.confirmServed.bind(contributor);
          await guardServedFacts(context, info, [() => confirmServed(data.cui, slice)]);
        }
        return data;
      },
    },

    // Enum value mapping (@graphql-tools/schema convention): keys are the GraphQL
    // enum NAMES (SAFE/UNMATCHED), values are the INTERNAL representation the domain
    // model emits ('safe'/'unmatched'). graphql-tools matches an internal value to
    // its enum name via this map, so serialization of the lowercase domain value
    // succeeds. (The keys MUST be the enum names defined in the SDL.)
    CompanyMatchConfidence: { SAFE: 'safe', UNMATCHED: 'unmatched' },
    CompanyRegistrationField: {
      LEGAL_NAME: 'legalName',
      LEGAL_FORM: 'legalForm',
      COUNTY: 'county',
      LOCALITY: 'locality',
    },
    CompanyRegistrationDiffStatus: {
      CHANGED: 'changed',
      UNCHANGED: 'unchanged',
      APPEARED: 'appeared',
      DISAPPEARED: 'disappeared',
      NOT_COMPARABLE: 'not_comparable',
      AMBIGUOUS: 'ambiguous',
    },
    CompanyRegistryState: {
      PUBLISHED: 'published',
      UNPUBLISHED: 'unpublished',
      WITHDRAWN: 'withdrawn',
      UNAVAILABLE: 'unavailable',
    },
    CompanyRegistryCuiState: {
      IN_EDITION: 'in_edition',
      NOT_IN_EDITION: 'not_in_edition',
      UNPUBLISHED: 'unpublished',
      WITHDRAWN: 'withdrawn',
      UNAVAILABLE: 'unavailable',
    },
    CompanyRegistryBasis: {
      SINGLE_OBSERVATION: 'single_observation',
      CONSISTENT_OBSERVATIONS: 'consistent_observations',
      PARTIAL_OBSERVATIONS: 'partial_observations',
      MULTIPLE_VALUES: 'multiple_values',
      MISSING: 'missing',
      UNRESOLVED: 'unresolved',
    },
    CompanyRegistryCoverage: {
      COMPLETE: 'complete',
      COMPLETE_EMPTY: 'complete_empty',
      PARTIAL: 'partial',
      UNRESOLVED: 'unresolved',
    },
    CompanyNameSource: { ONRC_EDITION: 'onrc_edition', CORE_ORGANIZATION: 'core_organization' },
    CompanyStatusLabelSource: { API_NOMENCLATURE: 'api_nomenclature', CODE: 'code' },
    CompanyLegalPersonEligibility: {
      ELIGIBLE: 'eligible',
      EXCLUDED: 'excluded',
      UNRESOLVED: 'unresolved',
    },
    CompanyQualificationAssessment: { ASSESSED: 'assessed', NOT_ASSESSED: 'not_assessed' },
    CompanyMetricStatus: {
      REPORTED: 'reported',
      MISSING: 'missing',
      NOT_ADMITTED: 'not_admitted',
      HELD_PROFILE: 'held_profile',
      HELD_OBSERVATION: 'held_observation',
      HELD_QUALITY: 'held_quality',
      HELD_COMPONENT: 'held_component',
    },
  };
};
