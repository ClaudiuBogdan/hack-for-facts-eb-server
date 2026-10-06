import { GraphQLError } from 'graphql';

import {
  GRAPHQL_ERROR_CODE,
  buildNextCursor,
  toGraphQLInput,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  publicEnterpriseIndicatorFilterSpec,
  publicEnterpriseListFilterSpec,
  withoutNulls,
} from '../../core/filters.js';
import {
  getPublicEnterpriseProfile,
  listPublicEnterpriseIndicators,
  listPublicEnterprises,
  listPublicEnterpriseSources,
  type PublicEnterpriseDeps,
} from '../../core/usecases.js';
import {
  INDICATOR_SORT,
  indicatorCursorKeys,
  indicatorFilterHash,
} from '../repo/public-enterprise-repo.js';

import type { PublicEnterpriseProfile } from '../../core/types.js';
import type { Result } from 'neverthrow';

export const publicEnterpriseTypeDefs =
  toGraphQLInput(publicEnterpriseListFilterSpec) +
  '\n\n' +
  toGraphQLInput(publicEnterpriseIndicatorFilterSpec) +
  `
  """
  Registry observation family. amepip_company_year, amepip_form_group and s1001 are primary:
  a current one makes the enterprise a current member. json_apt is an overlay only.
  """
  enum PublicEnterpriseFamily { amepip_company_year amepip_form_group s1001 json_apt }
  "Source lane of the public-enterprise data."
  enum PublicEnterpriseSourceFamily { amepip s1001 json_apt }
  """
  available: the lane has a current accepted public snapshot. partial: the same, with a raw
  capture recorded as partial. unavailable: the lane is not loaded; this never means a CUI is
  absent from the source.
  """
  enum PublicEnterpriseLaneStatus { available partial unavailable }
  "How the AMEPIP parser classified the original cell."
  enum PublicEnterpriseValueKind { number boolean text empty }

  type PublicEnterpriseSource {
    family: PublicEnterpriseSourceFamily!
    scope: String
    laneStatus: PublicEnterpriseLaneStatus!
    snapshotId: String
    "Raw capture status recorded by the loader; null when none was recorded."
    rawStatus: String
    sourceUrl: String
    contentSha256: String
    "When the platform observed the source. Not a publication date."
    observedAt: DateTime
    sourceLastModifiedAt: DateTime
    acceptedAt: DateTime
    loadedAt: DateTime
  }
  "A registry row as its source reports it. Names and statuses are not verified."
  type PublicEnterpriseRegistryObservation {
    id: ID!
    snapshotId: String!
    sourceFamily: PublicEnterpriseFamily!
    sourceRecordKey: String!
    cui: CUI!
    rawCui: String
    cuiChecksumStatus: String!
    publishStatus: String!
    observedName: String
    observedYear: Int
    statusRaw: String
    statusNormalized: String
    rawSubordination: String
    derivedAuthorityLevel: String
    sourceEvidenceKey: String!
    sourceUrl: String
  }
  "A control edge as its source reports it. Not an ownership claim."
  type PublicEnterpriseAuthorityEdge {
    id: ID!
    snapshotId: String!
    sourceFamily: PublicEnterpriseSourceFamily!
    sourceRecordKey: String!
    enterpriseCui: CUI!
    authorityCui: CUI
    "The authority name exactly as the source wrote it, not a resolved identity."
    authorityName: String
    rawSubordination: String
    authorityLevel: String!
    authorityLevelMethod: String!
    aptTypeId: Int
    enterpriseStatusRaw: String
    effectiveFrom: Date
    effectiveTo: Date
    sourceEvidenceKey: String!
    sourceUrl: String
  }
  """
  One AMEPIP indicator cell of the current AMEPIP snapshot. numericValue is exact decimal
  text; rawValue is the original cell ('' and null differ); textValue is served null.
  """
  type PublicEnterpriseIndicator {
    id: ID!
    snapshotId: String!
    enterpriseCui: CUI!
    year: Int!
    sourceSheet: String!
    version: String!
    indicatorKey: String!
    kpiCode: String
    indicatorName: String!
    measureUnit: String
    valueKind: PublicEnterpriseValueKind!
    rawValue: String
    numericValue: String
    booleanValue: Boolean
    textValue: String
    sourceRowNumber: Int
    sourceEvidenceKey: String!
    sourceUrl: String
  }
  type PublicEnterpriseIndicatorEdge { cursor: String! node: PublicEnterpriseIndicator! }
  "Pinned to snapshotId, the current AMEPIP snapshot; a cursor fails after it changes."
  type PublicEnterpriseIndicatorConnection {
    edges: [PublicEnterpriseIndicatorEdge!]!
    pageInfo: PageInfo!
    snapshotId: String
  }
  type PublicEnterpriseSummary {
    cui: CUI!
    "Kernel identity; null when it is withheld or absent. The record is still listed."
    organization: Organization
    isCurrentMember: Boolean!
    currentFamilies: [PublicEnterpriseFamily!]!
  }
  type PublicEnterpriseProfile {
    cui: CUI!
    "Kernel identity; null when it is withheld or absent."
    organization: Organization
    isCurrentMember: Boolean!
    currentFamilies: [PublicEnterpriseFamily!]!
    registryObservations: [PublicEnterpriseRegistryObservation!]!
    authorityEdges: [PublicEnterpriseAuthorityEdge!]!
    sources: [PublicEnterpriseSource!]!
    indicators(
      filter: PublicEnterpriseIndicatorsFilter
      first: Int = 100
      after: String
    ): PublicEnterpriseIndicatorConnection!
  }
  type PublicEnterprisePage {
    items: [PublicEnterpriseSummary!]!
    page: Int!
    pageSize: Int!
    total: Int!
  }
  extend type Query {
    "Null when the CUI is not a public enterprise anchor."
    publicEnterprise(cui: CUI!): PublicEnterpriseProfile
    "CUI order. filter.currentOnly defaults to true; false includes historical anchors."
    publicEnterprises(filter: PublicEnterprisesFilter, page: Int = 1, pageSize: Int = 20): PublicEnterprisePage!
    "The three source lanes in fixed order, unavailable ones included."
    publicEnterpriseSources: [PublicEnterpriseSource!]!
  }
`;

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr())
    throw new GraphQLError(result.error.message, {
      extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
    });
  return result.value;
};

export const makePublicEnterpriseResolvers = (deps: PublicEnterpriseDeps) => ({
  Query: {
    publicEnterprise: async (_root: unknown, args: { cui: string }) =>
      unwrap(await getPublicEnterpriseProfile(deps, args.cui)),
    publicEnterprises: async (
      _root: unknown,
      args: { filter?: unknown; page?: number | null; pageSize?: number | null }
    ) =>
      unwrap(
        await listPublicEnterprises(deps, {
          filter: withoutNulls(args.filter),
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
        })
      ),
    publicEnterpriseSources: async () => unwrap(await listPublicEnterpriseSources(deps)),
  },
  PublicEnterpriseProfile: {
    indicators: async (
      parent: PublicEnterpriseProfile,
      args: { filter?: unknown; first?: number | null; after?: string | null }
    ) => {
      const filter = withoutNulls(args.filter);
      const page = unwrap(
        await listPublicEnterpriseIndicators(deps, {
          cui: parent.cui,
          filter,
          first: args.first ?? 100,
          ...(args.after == null ? {} : { after: args.after }),
        })
      );
      const fhash = indicatorFilterHash(parent.cui, page.snapshotId, filter);
      const edges = page.items.map((node) => ({
        node,
        cursor: buildNextCursor({
          sort: INDICATOR_SORT,
          dir: 'asc',
          fhash,
          lastKeys: indicatorCursorKeys(node),
        }),
      }));
      return {
        edges,
        snapshotId: page.snapshotId,
        pageInfo: { hasNextPage: page.next !== null, endCursor: edges.at(-1)?.cursor ?? null },
      };
    },
  },
});
