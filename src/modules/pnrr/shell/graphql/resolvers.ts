/**
 * PNRR module — GraphQL resolvers (plan §6). Thin: parse args → call the SAME
 * usecase REST/MCP would. `ApiError` → `GraphQLError` with `extensions.code`
 * (kernel convention). Cursor pages → Relay connections (edges carry the row's
 * own cursor via a per-edge re-encode bound to the active fhash). `Entity.pnrr`
 * goes through the kernel `makeEntityProfileSlice` (contributor parity, §14.7).
 *
 * `PnrrCommitment.progress` is NOT a list field (741k-row footgun); use
 * `progressCount`/`latestProgress` on the row + the dedicated
 * `pnrrCommitmentProgress` query. `PnrrAcquisition.contractors` is a bounded
 * child resolved via a DataLoader by acquisition_key (no N+1 on list pages).
 */

import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  filterHash,
  fhashFor,
  makeBatchLoader,
  makeEntityProfileSlice,
  type ApiError,
  type ContributorRegistry,
  type CursorPage,
  type FilterInput,
  type CollectionFilterSpec,
  isWithheldOrganizationIdentifier,
  normalizeCui,
} from '@/modules/shared/index.js';

import {
  pnrrAcquisitionsFilterSpec,
  pnrrCommitmentsFilterSpec,
  pnrrContractorsFilterSpec,
  pnrrEntitiesFilterSpec,
  pnrrPaymentsFilterSpec,
  pnrrProjectsFilterSpec,
  normalizePnrrFilter,
} from '../../core/filters.js';
import {
  aggregatePnrrPayments,
  getPnrrAcquisition,
  getPnrrCommitmentProgress,
  getPnrrCommitment,
  getPnrrCapabilities,
  getPnrrCurrentRelease,
  getPnrrEntity,
  getPnrrEntityProfile,
  getPnrrOverview,
  getPnrrPlaceProfile,
  getPnrrProject,
  getPnrrProjectFacets,
  getPnrrProjectHistory,
  getPnrrVerification,
  listPnrrPlaces,
  listPnrrAcquisitions,
  listPnrrCommitments,
  listPnrrComponents,
  listPnrrFundingApplicationListings,
  listPnrrFundingCalls,
  listPnrrCatalogResources,
  listPnrrDocumentReferences,
  listPnrrContractors,
  listPnrrEntities,
  listPnrrMeasures,
  listPnrrPayments,
  listPnrrProjects,
  listPnrrProgramIndicators,
  listPnrrProgramRevisions,
  rankPnrrContractors,
  resolvePnrrFilters,
} from '../../core/usecases.js';

import type { PnrrRepository } from '../../core/ports.js';
import type {
  PnrrAcquisition,
  PnrrCapability,
  PnrrCommitmentSnapshot,
  PnrrContractor,
  PnrrContractorRankBy,
  PnrrEntity,
  PnrrEntityProfile,
  PnrrPaymentGroupBy,
  PnrrResolveDim,
  PnrrAnalysisScope,
  PnrrGrain,
  PnrrFundingApplicationListing,
  PnrrFundingCall,
  PnrrCatalogResource,
  PnrrDocumentReference,
  PnrrProgramRevision,
} from '../../core/types.js';
import type { Result } from 'neverthrow';

export interface PnrrResolverDeps {
  readonly repo: PnrrRepository;
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

interface PageArgs {
  filter?: FilterInput;
  first?: number;
  after?: string;
}

const pageReq = (
  args: PageArgs,
  releaseId?: string
): { first: number; after?: string; releaseId?: string } => ({
  first: args.first ?? 20,
  ...(args.after != null && { after: args.after }),
  ...(releaseId !== undefined && { releaseId }),
});

type ScopeInput = Partial<PnrrAnalysisScope>;

const scopeOf = (
  raw: ScopeInput | undefined,
  defaults: {
    grain: PnrrGrain;
    measure: PnrrAnalysisScope['measure'];
    timeRole: PnrrAnalysisScope['timeRole'];
    geographyRole: PnrrAnalysisScope['geographyRole'];
  },
  options: { rejectFilters?: boolean } = {}
): PnrrAnalysisScope => {
  const rejectUnsupported = (
    field: 'grain' | 'measure' | 'timeRole' | 'geographyRole',
    supported: string
  ): void => {
    const requested = raw?.[field];
    if (requested !== undefined && requested !== supported) {
      throw new GraphQLError(
        `unsupported PNRR scope ${field}: ${requested}; supported value is ${supported}`,
        { extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput', field } }
      );
    }
  };
  rejectUnsupported('grain', defaults.grain);
  rejectUnsupported('measure', defaults.measure);
  rejectUnsupported('timeRole', defaults.timeRole);
  rejectUnsupported('geographyRole', defaults.geographyRole);
  if (raw?.currency !== undefined && raw.currency !== null) {
    throw new GraphQLError('currency-scoped PNRR analysis is not implemented for this operation', {
      extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput', field: 'currency' },
    });
  }
  if (raw?.from != null && raw.to != null && raw.from > raw.to) {
    throw new GraphQLError('PNRR scope end date precedes start date', {
      extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput', field: 'to' },
    });
  }
  if (
    options.rejectFilters === true &&
    [raw?.componentCode, raw?.beneficiaryCui, raw?.countySiruta, raw?.from, raw?.to].some(
      (value) => value !== undefined && value !== null
    )
  ) {
    throw new GraphQLError('filters are not implemented for this PNRR operation', {
      extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput', field: 'scope' },
    });
  }
  const hasBeneficiaryCui = typeof raw?.beneficiaryCui === 'string';
  const normalizedCui = hasBeneficiaryCui ? normalizeCui(raw.beneficiaryCui) : null;
  if (hasBeneficiaryCui && normalizedCui === null) {
    throw new GraphQLError('invalid CUI format', {
      extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput' },
    });
  }
  if (normalizedCui !== null && isWithheldOrganizationIdentifier(normalizedCui)) {
    throw new GraphQLError('organization identifier is not publicly served', {
      extensions: { code: 'BAD_USER_INPUT', type: 'InvalidInput' },
    });
  }
  return {
    grain: raw?.grain ?? defaults.grain,
    measure: raw?.measure ?? defaults.measure,
    componentCode: raw?.componentCode ?? null,
    beneficiaryCui: normalizedCui,
    countySiruta: raw?.countySiruta ?? null,
    from: raw?.from ?? null,
    to: raw?.to ?? null,
    timeRole: raw?.timeRole ?? defaults.timeRole,
    geographyRole: raw?.geographyRole ?? defaults.geographyRole,
    currency: null,
    resolutionPolicyVersion: 'pnrr-resolution-v1',
  };
};

const assertRelease = async (
  repo: PnrrRepository,
  expected: string | undefined,
  options: { allowAbstained?: boolean } = {}
): Promise<string> => {
  const release = unwrap(await getPnrrCurrentRelease(repo));
  if (release.state === 'abstained' && options.allowAbstained !== true) {
    throw new GraphQLError('PNRR serving release is unavailable.', {
      extensions: { code: 'PNRR_UNAVAILABLE' },
    });
  }
  if (expected !== undefined && release.releaseId !== expected) {
    throw new GraphQLError(
      `PNRR release changed from ${expected} to ${release.releaseId}; restart the query.`,
      {
        extensions: {
          code: 'RELEASE_MISMATCH',
          expectedReleaseId: expected,
          currentReleaseId: release.releaseId,
        },
      }
    );
  }
  return release.releaseId;
};

/**
 * Build a Relay connection from a CursorPage. Each edge carries a cursor
 * re-encoded from that node's sort tuple, bound to the active filter fhash — so
 * `edges[i].cursor` is a valid resume point (not just the page-level `next`).
 */
const toConnection = <T>(
  page: CursorPage<T>,
  spec: CollectionFilterSpec,
  filter: FilterInput,
  sort: string,
  dir: 'asc' | 'desc',
  keysOf: (node: T) => readonly (string | number | null)[],
  fhashOverride?: string
): {
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} => {
  const fhash = fhashOverride ?? fhashFor(spec, filter);
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({ sort, dir, fhash, lastKeys: keysOf(node) }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1]?.cursor ?? null) : null,
    },
  };
};

const toSourceConnection = <T>(
  page: CursorPage<T>,
  lane: string,
  releaseId: string | undefined,
  keyOf: (node: T) => string
): {
  edges: { node: T; cursor: string }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
} => {
  const fhash = filterHash(
    JSON.stringify({ base: filterHash(lane), releaseId: releaseId ?? null })
  );
  const edges = page.items.map((node) => ({
    node,
    cursor: buildNextCursor({
      sort: 'source_key',
      dir: 'asc',
      fhash,
      lastKeys: [keyOf(node)],
    }),
  }));
  return {
    edges,
    pageInfo: {
      hasNextPage: page.next !== null,
      endCursor: edges.at(-1)?.cursor ?? null,
    },
  };
};

const releaseConnectionFhash = (
  spec: CollectionFilterSpec,
  filter: FilterInput,
  releaseId: string
): string =>
  filterHash(
    JSON.stringify({
      base: fhashFor(spec, filter),
      releaseId,
    })
  );

export const makePnrrResolvers = (deps: PnrrResolverDeps): Record<string, unknown> => {
  const { repo, registry } = deps;
  const withinRelease = async <T>(
    expected: string | undefined,
    read: (releaseId: string) => Promise<T>
  ): Promise<T> => {
    const releaseId = await assertRelease(repo, expected);
    const value = await read(releaseId);
    await assertRelease(repo, releaseId);
    return value;
  };
  const withinLegacyRelease = async <T>(
    expected: string | undefined,
    read: (releaseId: string | undefined) => Promise<T>
  ): Promise<T> => {
    if (expected === undefined) return read(undefined);
    const releaseId = await assertRelease(repo, expected);
    const value = await read(releaseId);
    await assertRelease(repo, releaseId);
    return value;
  };
  const withinCapabilityRelease = async (
    expected: string | undefined
  ): Promise<readonly PnrrCapability[]> => {
    const releaseId = await assertRelease(repo, expected, { allowAbstained: true });
    const capabilities = unwrap(await getPnrrCapabilities(repo));
    const mismatched = capabilities.find((capability) => capability.releaseId !== releaseId);
    if (mismatched !== undefined) {
      throw new GraphQLError('PNRR capability manifest does not match the observed release.', {
        extensions: {
          code: 'RELEASE_MISMATCH',
          expectedReleaseId: releaseId,
          currentReleaseId: mismatched.releaseId,
        },
      });
    }
    await assertRelease(repo, releaseId, { allowAbstained: true });
    return capabilities;
  };

  // Per-process DataLoader for acquisition → contractors (bounded child fan-out).
  // (A per-request loader would be ideal; the batch is small and idempotent, so a
  // shared loader with no caching is acceptable for the read-only surface.)
  const contractorsLoader = makeBatchLoader<readonly PnrrContractor[]>(async (keys) => {
    const res = await repo.contractorsForAcquisitions(keys);
    if (res.isErr()) throw toGraphqlError(res.error);
    return res.value;
  }, []);

  return {
    Query: {
      pnrrCurrentRelease: async () => unwrap(await getPnrrCurrentRelease(repo)),
      pnrrCapabilities: async (_r: unknown, args: { assertReleaseId?: string }) =>
        withinCapabilityRelease(args.assertReleaseId),
      pnrrOverview: async (_r: unknown, args: { scope?: ScopeInput; assertReleaseId?: string }) => {
        return withinRelease(args.assertReleaseId, async () =>
          unwrap(
            await getPnrrOverview(
              repo,
              scopeOf(args.scope, {
                grain: 'program',
                measure: 'amount',
                timeRole: 'snapshot_date',
                geographyRole: 'implementation_county',
              })
            )
          )
        );
      },
      pnrrEntities: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async (releaseId) => {
          const filter = unwrap(normalizePnrrFilter(args.filter ?? {}));
          const page = unwrap(await listPnrrEntities(repo, filter, pageReq(args, releaseId)));
          return toConnection(
            page,
            pnrrEntitiesFilterSpec,
            filter,
            'cui',
            'asc',
            (n) => [n.cui],
            releaseId === undefined
              ? undefined
              : releaseConnectionFhash(pnrrEntitiesFilterSpec, filter, releaseId)
          );
        }),
      pnrrEntity: async (_r: unknown, args: { cui: string; assertReleaseId?: string }) => {
        return withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await getPnrrEntity(repo, args.cui))
        );
      },
      pnrrEntityProfile: async (_r: unknown, args: { cui: string; assertReleaseId?: string }) => {
        return withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await getPnrrEntityProfile(repo, args.cui))
        );
      },

      pnrrPayments: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async (releaseId) => {
          const filter = unwrap(normalizePnrrFilter(args.filter ?? {}));
          const page = unwrap(await listPnrrPayments(repo, filter, pageReq(args, releaseId)));
          return toConnection(
            page,
            pnrrPaymentsFilterSpec,
            filter,
            'payment_date',
            'desc',
            (n) => [n.paymentDate ?? '', n.paymentKey],
            releaseId === undefined
              ? undefined
              : releaseConnectionFhash(pnrrPaymentsFilterSpec, filter, releaseId)
          );
        }),
      pnrrPaymentAggregate: async (
        _r: unknown,
        args: {
          filter?: FilterInput;
          groupBy: PnrrPaymentGroupBy;
          assertReleaseId?: string;
        }
      ) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(
            await aggregatePnrrPayments(
              repo,
              unwrap(normalizePnrrFilter(args.filter ?? {})),
              args.groupBy
            )
          )
        ),

      pnrrCommitments: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async (releaseId) => {
          const filter = unwrap(normalizePnrrFilter(args.filter ?? {}));
          const page = unwrap(await listPnrrCommitments(repo, filter, pageReq(args, releaseId)));
          return toConnection(
            page,
            pnrrCommitmentsFilterSpec,
            filter,
            'commitment_date',
            'desc',
            (n) => [n.commitmentDate ?? '', n.commitmentKey],
            releaseId === undefined
              ? undefined
              : releaseConnectionFhash(pnrrCommitmentsFilterSpec, filter, releaseId)
          );
        }),
      pnrrProjects: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) => {
        const releaseId = await assertRelease(repo, args.assertReleaseId);
        const filter = unwrap(normalizePnrrFilter(args.filter ?? {}));
        const page = unwrap(
          await listPnrrProjects(repo, filter, pageReq(args, releaseId), releaseId)
        );
        await assertRelease(repo, releaseId);
        const cursorFhash = releaseConnectionFhash(pnrrProjectsFilterSpec, filter, releaseId);
        return toConnection(
          page,
          pnrrProjectsFilterSpec,
          filter,
          'snapshot_date',
          'desc',
          (n) => [n.snapshotDate, n.sourceObservationId],
          cursorFhash
        );
      },
      pnrrProject: async (_r: unknown, args: { key: string; assertReleaseId?: string }) => {
        const releaseId = await assertRelease(repo, args.assertReleaseId);
        const project = unwrap(await getPnrrProject(repo, args.key));
        await assertRelease(repo, releaseId);
        return project;
      },
      pnrrProjectHistory: async (_r: unknown, args: { key: string; assertReleaseId?: string }) => {
        const releaseId = await assertRelease(repo, args.assertReleaseId);
        const history = unwrap(await getPnrrProjectHistory(repo, args.key));
        await assertRelease(repo, releaseId);
        return history;
      },
      pnrrProjectFacets: async (
        _r: unknown,
        args: { filter?: FilterInput; assertReleaseId?: string }
      ) =>
        withinRelease(args.assertReleaseId, async () =>
          unwrap(await getPnrrProjectFacets(repo, unwrap(normalizePnrrFilter(args.filter ?? {}))))
        ),
      pnrrFundingCalls: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinRelease(args.assertReleaseId, async (releaseId) =>
          toSourceConnection(
            unwrap(await listPnrrFundingCalls(repo, pageReq(args, releaseId), releaseId)),
            'funding_calls',
            releaseId,
            (row: PnrrFundingCall) => row.callId
          )
        ),
      pnrrFundingApplicationListings: async (
        _r: unknown,
        args: PageArgs & { assertReleaseId?: string }
      ) =>
        withinRelease(args.assertReleaseId, async (releaseId) =>
          toSourceConnection(
            unwrap(
              await listPnrrFundingApplicationListings(repo, pageReq(args, releaseId), releaseId)
            ),
            'funding_application_listings',
            releaseId,
            (row: PnrrFundingApplicationListing) => row.listingId
          )
        ),
      pnrrProgramRevisions: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinRelease(args.assertReleaseId, async (releaseId) =>
          toSourceConnection(
            unwrap(await listPnrrProgramRevisions(repo, pageReq(args, releaseId), releaseId)),
            'program_revisions',
            releaseId,
            (row: PnrrProgramRevision) => row.revisionId
          )
        ),
      pnrrCatalogResources: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinRelease(args.assertReleaseId, async (releaseId) =>
          toSourceConnection(
            unwrap(await listPnrrCatalogResources(repo, pageReq(args, releaseId), releaseId)),
            'catalog_resources',
            releaseId,
            (row: PnrrCatalogResource) => row.resourceId
          )
        ),
      pnrrDocumentReferences: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinRelease(args.assertReleaseId, async (releaseId) =>
          toSourceConnection(
            unwrap(await listPnrrDocumentReferences(repo, pageReq(args, releaseId), releaseId)),
            'document_references',
            releaseId,
            (row: PnrrDocumentReference) => row.documentKey
          )
        ),
      pnrrCommitment: async (_r: unknown, args: { key: string; assertReleaseId?: string }) => {
        return withinRelease(args.assertReleaseId, async () =>
          unwrap(await getPnrrCommitment(repo, args.key))
        );
      },
      pnrrCommitmentProgress: async (
        _r: unknown,
        args: { commitmentKey: string; assertReleaseId?: string }
      ) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await getPnrrCommitmentProgress(repo, args.commitmentKey))
        ),

      pnrrAcquisitions: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async (releaseId) => {
          const filter = unwrap(normalizePnrrFilter(args.filter ?? {}));
          const page = unwrap(await listPnrrAcquisitions(repo, filter, pageReq(args, releaseId)));
          return toConnection(
            page,
            pnrrAcquisitionsFilterSpec,
            filter,
            'signed_at',
            'desc',
            (n) => [n.signedAt ?? '', n.acquisitionKey],
            releaseId === undefined
              ? undefined
              : releaseConnectionFhash(pnrrAcquisitionsFilterSpec, filter, releaseId)
          );
        }),
      pnrrAcquisition: async (_r: unknown, args: { key: string; assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await getPnrrAcquisition(repo, args.key))
        ),

      pnrrContractors: async (_r: unknown, args: PageArgs & { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async (releaseId) => {
          const filter = unwrap(normalizePnrrFilter(args.filter ?? {}));
          const page = unwrap(await listPnrrContractors(repo, filter, pageReq(args, releaseId)));
          return toConnection(
            page,
            pnrrContractorsFilterSpec,
            filter,
            'contractor_key',
            'desc',
            (n) => [n.contractorKey],
            releaseId === undefined
              ? undefined
              : releaseConnectionFhash(pnrrContractorsFilterSpec, filter, releaseId)
          );
        }),
      pnrrContractorRank: async (
        _r: unknown,
        args: {
          filter?: FilterInput;
          by?: PnrrContractorRankBy;
          limit?: number;
          assertReleaseId?: string;
        }
      ) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(
            await rankPnrrContractors(
              repo,
              unwrap(normalizePnrrFilter(args.filter ?? {})),
              args.by ?? 'relationships',
              args.limit ?? 20
            )
          )
        ),

      pnrrComponents: async (_r: unknown, args: { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await listPnrrComponents(repo))
        ),
      pnrrMeasures: async (_r: unknown, args: { filter?: FilterInput; assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await listPnrrMeasures(repo, args.filter ?? {}))
        ),
      pnrrProgramIndicators: async (_r: unknown, args: { assertReleaseId?: string }) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await listPnrrProgramIndicators(repo))
        ),
      pnrrPlace: async (
        _r: unknown,
        args: { countySiruta: string; scope?: ScopeInput; assertReleaseId?: string }
      ) => {
        return withinRelease(args.assertReleaseId, async () =>
          unwrap(
            await getPnrrPlaceProfile(
              repo,
              args.countySiruta,
              scopeOf(args.scope, {
                grain: 'place',
                measure: 'amount',
                timeRole: 'snapshot_date',
                geographyRole: 'implementation_county',
              })
            )
          )
        );
      },
      pnrrPlaces: async (_r: unknown, args: { scope?: ScopeInput; assertReleaseId?: string }) => {
        return withinRelease(args.assertReleaseId, async () =>
          unwrap(
            await listPnrrPlaces(
              repo,
              scopeOf(args.scope, {
                grain: 'place',
                measure: 'amount',
                timeRole: 'snapshot_date',
                geographyRole: 'implementation_county',
              })
            )
          )
        );
      },
      pnrrVerification: async (
        _r: unknown,
        args: { scope?: ScopeInput; assertReleaseId?: string }
      ) => {
        return withinRelease(args.assertReleaseId, async () =>
          unwrap(
            await getPnrrVerification(
              repo,
              scopeOf(
                args.scope,
                {
                  grain: 'verification',
                  measure: 'count',
                  timeRole: 'snapshot_date',
                  geographyRole: 'implementation_county',
                },
                { rejectFilters: true }
              )
            )
          )
        );
      },
      pnrrResolve: async (
        _r: unknown,
        args: {
          dim: PnrrResolveDim;
          q: string;
          limit?: number;
          assertReleaseId?: string;
        }
      ) =>
        withinLegacyRelease(args.assertReleaseId, async () =>
          unwrap(await resolvePnrrFilters(repo, args.dim, args.q, args.limit ?? 10))
        ),
    },

    PnrrEntity: {
      // Lazy profile via the SAME usecase the contributor + Entity.pnrr call.
      profile: async (parent: PnrrEntity): Promise<PnrrEntityProfile | null> =>
        withinLegacyRelease(undefined, async () =>
          unwrap(await getPnrrEntityProfile(repo, parent.cui))
        ),
    },

    PnrrAcquisition: {
      contractors: async (parent: PnrrAcquisition): Promise<readonly PnrrContractor[]> =>
        withinLegacyRelease(undefined, async () => contractorsLoader.load(parent.acquisitionKey)),
    },

    Entity: {
      // Contributor parity (§14.7): resolve through the registry, not a 2nd path.
      pnrr: async (parent: { cui: string }): Promise<PnrrEntityProfile | null> => {
        const slice = unwrap(await makeEntityProfileSlice(registry, 'pnrr', parent.cui));
        if (slice?.data === undefined) return null;
        return slice.data as unknown as PnrrEntityProfile;
      },
    },
  };
};

// Re-export the snapshot type so the resolver module's consumers can see it.
export type { PnrrCommitmentSnapshot };
