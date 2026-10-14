import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, toGraphQLInput, type ApiError } from '@/modules/shared/index.js';

import {
  electionCatalogFilterSpec,
  electionContestsFilterSpec,
  withoutNulls,
} from '../../core/filters.js';
import { ELECTION_READINESS_ISSUES } from '../../core/types.js';
import {
  getElectionContest,
  getElectionEdition,
  listElectionContests,
  listElectionEditions,
  type ElectionsDeps,
} from '../../core/usecases.js';

import type { Result } from 'neverthrow';

export const electionsTypeDefs =
  toGraphQLInput(electionCatalogFilterSpec) +
  '\n\n' +
  toGraphQLInput(electionContestsFilterSpec) +
  `
  """
  VERIFIED: a recorded review qualifies it. HELD: data may exist but its meaning or access is not
  qualified, so it is not served. UNAVAILABLE: no qualified projection exists. UNKNOWN: not determined.
  """
  enum ElectionEvidenceStatus { VERIFIED HELD UNAVAILABLE UNKNOWN }
  "The source's reporting scope type; not a verified jurisdiction."
  enum ElectionScopeType { siruta county diaspora national chamber source_constituency }
  "Why a source edition or contest is not a qualified result."
  enum ElectionReadinessIssue { ${ELECTION_READINESS_ISSUES.join(' ')} }

  """
  What is qualified for this row. In this release identity, source selection and source opening are
  HELD and results and mandates are UNAVAILABLE for every row.
  """
  type ElectionReadiness {
    identity: ElectionEvidenceStatus!
    sourceSelection: ElectionEvidenceStatus!
    sourceOpening: ElectionEvidenceStatus!
    results: ElectionEvidenceStatus!
    mandates: ElectionEvidenceStatus!
    issues: [ElectionReadinessIssue!]!
  }

  """
  One SOURCE EDITION of election data, not a distinct election: editions of one event overlap and
  are not additive. reported* fields are stored source labels; verified* stay null until a recorded
  review establishes them. No result or finality status is served (RESULT_STATUS_UNQUALIFIED).
  """
  type ElectionEdition {
    electionKey: ID!
    "Platform event grouping; null when unlinked or not public. Unverified: not identity or source selection."
    eventKey: ID
    reportedName: String!
    reportedYear: Int
    verifiedYear: Int
    reportedFamily: String!
    verifiedFamily: String
    "Round label as stored (e.g. tur1, final). Not finality."
    reportedRound: String
    reportedDate: Date
    reportedAuthority: String!
    readiness: ElectionReadiness!
  }

  """
  One source contest of an edition. sourceScopeKey is the source's scope (it may be a reporting
  location), not a verified territory. Results are not served.
  """
  type ElectionContest {
    contestKey: ID!
    electionKey: ID!
    eventKey: ID
    reportedOffice: String!
    verifiedOffice: String
    chamber: String
    reportedRound: String
    scopeType: ElectionScopeType!
    sourceScopeKey: String!
    scopeLabel: String
    constituencyCode: String
    constituencyName: String
    readiness: ElectionReadiness!
  }

  "total is the exact count of matching source editions, independent of the page."
  type ElectionEditionPage {
    items: [ElectionEdition!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  "total is the exact count of matching source contests of the edition, independent of the page."
  type ElectionContestPage {
    items: [ElectionContest!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  extend type Query {
    "Source editions in electionKey order. pageSize up to 100."
    electionCatalog(filter: ElectionCatalogFilter, page: Int = 1, pageSize: Int = 20): ElectionEditionPage!
    "Null when absent or not public."
    electionEdition(electionKey: ID!): ElectionEdition
    "Contests of one source edition in contestKey order. NOT_FOUND when the edition is absent or not public."
    electionContests(
      electionKey: ID!
      filter: ElectionContestsFilter
      page: Int = 1
      pageSize: Int = 20
    ): ElectionContestPage!
    "Null when absent or not public."
    electionContest(contestKey: ID!): ElectionContest
  }
`;

const unwrap = <T>(result: Result<T, ApiError>): T => {
  if (result.isErr())
    throw new GraphQLError(result.error.message, {
      extensions: { code: GRAPHQL_ERROR_CODE[result.error.type] },
    });
  return result.value;
};

export interface ElectionPageArgs {
  filter?: unknown;
  page?: number | null;
  pageSize?: number | null;
}

export const makeElectionsResolvers = (deps: ElectionsDeps) => ({
  Query: {
    electionCatalog: async (_root: unknown, args: ElectionPageArgs) =>
      unwrap(
        await listElectionEditions(deps, {
          filter: withoutNulls(args.filter),
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
        })
      ),
    electionEdition: async (_root: unknown, args: { electionKey: string }) =>
      unwrap(await getElectionEdition(deps, args.electionKey)),
    electionContests: async (_root: unknown, args: ElectionPageArgs & { electionKey: string }) =>
      unwrap(
        await listElectionContests(deps, {
          electionKey: args.electionKey,
          filter: withoutNulls(args.filter),
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
        })
      ),
    electionContest: async (_root: unknown, args: { contestKey: string }) =>
      unwrap(await getElectionContest(deps, args.contestKey)),
  },
});
