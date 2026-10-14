import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, toGraphQLInput, type ApiError } from '@/modules/shared/index.js';

import {
  electionCatalogFilterSpec,
  electionContestsFilterSpec,
  withoutNulls,
} from '../../core/filters.js';
import { ELECTION_READINESS_ISSUES } from '../../core/types.js';
import {
  getCountySourceReport,
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
  location), not a verified territory. Qualified results are not served (readiness); one source's
  reported county cells are, separately, in electionCountySourceReport.
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

  "Public provenance of the source file. Citing it does not open the stored copy."
  type ElectionSourceCitation {
    "The publisher's resource title."
    title: String!
    "The publisher's public resource URL."
    url: String!
    "The election date the title reports; not a publication or snapshot date."
    reportedElectionDate: Date!
    "When the original file was downloaded and its hash verified."
    sourceFileVerifiedOn: Date!
    "When every stored value was compared with that file and found exact."
    valuesComparedOn: Date!
  }

  "A statement column of the source file, labelled with the publisher legend's own text."
  type ElectionSourceStatementCell {
    "The file's column code (a, a1…a4, b, b1…b4, c, d)."
    sourceCode: String!
    sourceLabel: String!
    """
    As reported; 0 is a reported value. Always set in a served report: one that cannot serve
    every cell is withheld whole. Nullable for compatibility only; never a claim that the file
    lacks the cell.
    """
    value: BigInt
  }

  "One competitor label of the source file with its two cells, as reported."
  type ElectionSourceCompetitor {
    "The file's competitor label (a party, an alliance or the aggregate Candidat Independent)."
    sourceLabel: String!
    "The file's <label>-voturi cell; 0 is a reported value. Always set in a served report (nullable for compatibility only)."
    voturi: BigInt
    """
    The file's <label>-mandate cell, a reported count: not a confirmed seat, mayoralty or person.
    Always set in a served report (nullable for compatibility only).
    """
    mandate: BigInt
  }

  "total is the exact count of the report's distinct source labels, independent of the page."
  type ElectionSourceCompetitorPage {
    items: [ElectionSourceCompetitor!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  """
  The reported cells of one county contest of the one qualified source: the aep-local-2020
  edition's county rows of the publisher's mayor-results file, compared cell for cell with the
  original, served only complete (its 12 statement cells and every one of its 234 competitor
  labels with both cells). Reported observations only: no finality, winner, seat, person or
  derived value (turnout, totals). The file's e and f columns are not served.
  """
  type ElectionCountySourceReport {
    contestKey: ID!
    electionKey: ID!
    reportedOffice: String!
    scopeType: ElectionScopeType!
    "The file's county circumscription number (county_nce); not a verified territory."
    sourceScopeKey: String!
    "The file's circumscription name."
    scopeLabel: String
    "What these values are and are not."
    notice: String!
    "Set for the Municipiul București circumscription only."
    scopeNote: String
    source: ElectionSourceCitation!
    "The file's 12 admitted statement columns, in legend order."
    statement: [ElectionSourceStatementCell!]!
    "Competitor labels in source-label order (C collation)."
    competitors: ElectionSourceCompetitorPage!
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
    """
    The qualified source's reported cells for one county contest; page and pageSize (up to 100)
    page its competitor labels. Null (unavailable) when the contest is absent, not public or
    outside the source (only the aep-local-2020 county mayor-file contests are in it), or when
    any of its cells cannot be served (withheld, unreviewed, not public or not loaded): null
    never claims that the publisher's file lacks them. A duplicated or corrupt cell is an error.
    """
    electionCountySourceReport(
      contestKey: ID!
      page: Int = 1
      pageSize: Int = 20
    ): ElectionCountySourceReport
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
    electionCountySourceReport: async (
      _root: unknown,
      args: { contestKey: string; page?: number | null; pageSize?: number | null }
    ) =>
      unwrap(
        await getCountySourceReport(deps, {
          contestKey: args.contestKey,
          page: args.page ?? 1,
          pageSize: args.pageSize ?? 20,
        })
      ),
  },
});
