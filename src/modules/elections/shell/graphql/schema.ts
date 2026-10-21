import { GraphQLError } from 'graphql';

import { GRAPHQL_ERROR_CODE, toGraphQLInput, type ApiError } from '@/modules/shared/index.js';

import {
  electionCompetitorsFilterSpec,
  electionContestsFilterSpec,
  withoutNulls,
} from '../../core/filters.js';
import {
  ELECTION_ALLOCATION_PHASES,
  ELECTION_COMPETITOR_KINDS,
  ELECTION_COMPLETENESS,
  ELECTION_CONSTRUCTIONS,
  ELECTION_COUNTED_POPULATIONS,
  ELECTION_COVERAGE_STATES,
  ELECTION_FAMILIES,
  ELECTION_FIGURE_STATUSES,
  ELECTION_FINALITIES,
  ELECTION_OCCURRENCE_KINDS,
  ELECTION_PLACE_TYPES,
  ELECTION_ROUNDS,
  ELECTION_SOURCE_LEVELS,
  ELECTION_STATUSES,
  ELECTION_TALLY_MEASURES,
  ELECTION_TURNOUT_MEASURES,
  type ElectionPlaceType,
} from '../../core/types.js';
import {
  getElectionContest,
  getElectionEvent,
  getElectionResult,
  listElectionCompetitors,
  listElectionContests,
  listElectionEvents,
  listElectionResultScopes,
  type ElectionsDeps,
} from '../../core/usecases.js';

import type { Result } from 'neverthrow';

const enumOf = (name: string, values: readonly string[]) => `enum ${name} { ${values.join(' ')} }`;

export const electionsTypeDefs =
  toGraphQLInput(electionContestsFilterSpec) +
  '\n\n' +
  toGraphQLInput(electionCompetitorsFilterSpec) +
  `
  ${enumOf('ElectionFamily', ELECTION_FAMILIES)}
  ${enumOf('ElectionRound', ELECTION_ROUNDS)}
  ${enumOf('ElectionOccurrenceKind', ELECTION_OCCURRENCE_KINDS)}
  "held, or annulled: an annulled contest may have no figures; one annulled after its count keeps the counted figures."
  ${enumOf('ElectionStatus', ELECTION_STATUSES)}
  ${enumOf('ElectionPlaceType', ELECTION_PLACE_TYPES)}
  ${enumOf('ElectionCompetitorKind', ELECTION_COMPETITOR_KINDS)}
  ${enumOf('ElectionTallyMeasure', ELECTION_TALLY_MEASURES)}
  "none for votes; mandate allocation phases are separate and never summed."
  ${enumOf('ElectionAllocationPhase', ELECTION_ALLOCATION_PHASES)}
  ${enumOf('ElectionTurnoutMeasure', ELECTION_TURNOUT_MEASURES)}
  ${enumOf('ElectionConstruction', ELECTION_CONSTRUCTIONS)}
  ${enumOf('ElectionSourceLevel', ELECTION_SOURCE_LEVELS)}
  ${enumOf('ElectionFinality', ELECTION_FINALITIES)}
  ${enumOf('ElectionCountedPopulation', ELECTION_COUNTED_POPULATIONS)}
  ${enumOf('ElectionCompleteness', ELECTION_COMPLETENESS)}
  """
  VERIFIED: equals a separately published figure. UNCHECKED: no published counterpart.
  SUSPECT: a known defect (see issues).
  """
  ${enumOf('ElectionFigureStatus', ELECTION_FIGURE_STATUSES)}
  ${enumOf('ElectionCoverageState', ELECTION_COVERAGE_STATES)}

  type ElectionOfficeCount {
    office: String!
    contests: Int!
  }

  "One ballot day of an event; the date is its identity, the round an attribute."
  type ElectionOccurrence {
    occurrenceKey: ID!
    eventKey: ID!
    ballotDate: Date!
    round: ElectionRound!
    kind: ElectionOccurrenceKind!
    status: ElectionStatus!
    offices: [ElectionOfficeCount!]!
  }

  "The active, audited generation of an event's figures."
  type ElectionPublication {
    publicationId: BigInt!
    activatedAt: DateTime!
  }

  "An election event with published figures. family and year are parts of its key."
  type ElectionEvent {
    eventKey: ID!
    family: ElectionFamily!
    year: Int!
    publication: ElectionPublication!
    occurrences: [ElectionOccurrence!]!
  }

  """
  A place: uat:<SIRUTA>, county:<code>, diaspora or national. name is null for diaspora and
  national, and for a code the territory reference does not hold (a retired SIRUTA).
  """
  type ElectionPlace {
    placeKey: ID!
    placeType: ElectionPlaceType!
    sirutaCode: String
    countyCode: String
    name: String
    countyName: String
  }

  type ElectionCompetitor {
    competitorKey: ID!
    kind: ElectionCompetitorKind!
    "The party spine key, for a party or minority organisation."
    actorKey: String
    label: String!
    reportedLabels: [String!]!
  }

  "numerator / denominator as a percentage, rounded half-up to two decimals."
  type ElectionShare {
    percent: String!
    numerator: BigInt!
    denominator: BigInt!
    basis: String!
  }

  type ElectionTally {
    competitor: ElectionCompetitor!
    "The label as the source printed it for this figure."
    reportedLabel: String!
    measure: ElectionTallyMeasure!
    allocationPhase: ElectionAllocationPhase!
    "0 means the source printed 0; a missing figure has no row."
    value: BigInt!
    "Votes only: of the same scope's valid votes, when both count the same voters."
    share: ElectionShare
    construction: ElectionConstruction!
    sourceLevel: ElectionSourceLevel!
    finality: ElectionFinality!
    countedPopulation: ElectionCountedPopulation!
    geographicCompleteness: ElectionCompleteness!
    "Set on national figures."
    includesDiaspora: Boolean
    status: ElectionFigureStatus!
    issues: [String!]!
  }

  type ElectionTurnoutFigure {
    measure: ElectionTurnoutMeasure!
    value: BigInt!
    construction: ElectionConstruction!
    sourceLevel: ElectionSourceLevel!
    finality: ElectionFinality!
    geographicCompleteness: ElectionCompleteness!
    includesDiaspora: Boolean
    status: ElectionFigureStatus!
    issues: [String!]!
  }

  type ElectionCoverageCell {
    measure: String!
    allocationPhase: ElectionAllocationPhase!
    "False: the default for the scope type. True: this place's own cell."
    placeSpecific: Boolean!
    state: ElectionCoverageState!
    issues: [String!]!
  }

  type ElectionRaceEntry {
    competitor: ElectionCompetitor!
    votes: BigInt!
    share: ElectionShare
  }

  """
  Leader and runner-up by votes, computed at read time: never a winner or a mandate. Only when
  every vote tally of the place counts the same voters and none is SUSPECT.
  """
  type ElectionRace {
    competitorCount: Int!
    "VERIFIED when every vote tally is; UNCHECKED otherwise."
    status: ElectionFigureStatus!
    geographicCompleteness: ElectionCompleteness!
    finality: ElectionFinality!
    "The union of the vote tallies' issues."
    issues: [String!]!
    leader: ElectionRaceEntry!
    runnerUp: ElectionRaceEntry
    marginVotes: BigInt
    "Percentage points of the same valid votes."
    marginPoints: String
    tied: Boolean!
  }

  type ElectionContest {
    contestKey: ID!
    occurrenceKey: ID!
    eventKey: ID!
    office: String!
    "The place the office covers."
    jurisdiction: ElectionPlace!
    status: ElectionStatus!
    replacedBy: ID
    "Null without votes at the jurisdiction (mandates only, or annulled without figures). An annulled count keeps its race; a race never names a winner."
    race: ElectionRace
  }

  type ElectionScopeFigures {
    place: ElectionPlace!
    "Votes by value, then mandates by phase."
    tallies: [ElectionTally!]!
    turnout: [ElectionTurnoutFigure!]!
    "voted / registered, only when both are complete and unflagged; never for the diaspora."
    participation: ElectionShare
    "Inside a contest only."
    race: ElectionRace
  }

  type ElectionResult {
    occurrenceKey: ID!
    eventKey: ID!
    office: String!
    "Null for the office aggregate."
    contest: ElectionContest
    place: ElectionPlace!
    tallies: [ElectionTally!]!
    turnout: [ElectionTurnoutFigure!]!
    participation: ElectionShare
    race: ElectionRace
    coverage: [ElectionCoverageCell!]!
  }

  type ElectionEventPage {
    items: [ElectionEvent!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  type ElectionContestPage {
    items: [ElectionContest!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  type ElectionScopeFiguresPage {
    items: [ElectionScopeFigures!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  type ElectionCompetitorPage {
    items: [ElectionCompetitor!]!
    page: Int!
    pageSize: Int!
    total: Int!
    hasMore: Boolean!
  }

  extend type Query {
    "Events with published figures, in eventKey order. pageSize up to 100."
    electionEvents(page: Int = 1, pageSize: Int = 20): ElectionEventPage!
    "Null when the event has no published figures."
    electionEvent(eventKey: ID!): ElectionEvent
    "Contests of one occurrence in contestKey order, each with its race. NOT_FOUND when the occurrence is not published."
    electionContests(
      occurrenceKey: ID!
      filter: ElectionContestsFilter
      page: Int = 1
      pageSize: Int = 20
    ): ElectionContestPage!
    "Null when absent."
    electionContest(contestKey: ID!): ElectionContest
    """
    Every figure of one place: in a contest (contestKey), or the office aggregate (no contestKey,
    e.g. a county's mayor votes, or national). Null when the place has no figures there.
    """
    electionResult(occurrenceKey: ID!, office: String!, scopeKey: ID!, contestKey: ID): ElectionResult
    """
    The places of one type with figures: a contest's breakdown (contestKey; its own jurisdiction
    excluded) or the office aggregate's places. scopeKey order, pageSize up to 100.
    """
    electionResultScopes(
      occurrenceKey: ID!
      office: String!
      scopeType: ElectionPlaceType!
      contestKey: ID
      page: Int = 1
      pageSize: Int = 20
    ): ElectionScopeFiguresPage!
    "Competitors of one event, competitorKey order. NOT_FOUND when the event is not published."
    electionCompetitors(
      eventKey: ID!
      filter: ElectionCompetitorsFilter
      page: Int = 1
      pageSize: Int = 20
    ): ElectionCompetitorPage!
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
  page?: number | null;
  pageSize?: number | null;
}

const pageOf = (args: ElectionPageArgs) => ({
  page: args.page ?? 1,
  pageSize: args.pageSize ?? 20,
});

export const makeElectionsResolvers = (deps: ElectionsDeps) => ({
  Query: {
    electionEvents: async (_root: unknown, args: ElectionPageArgs) =>
      unwrap(await listElectionEvents(deps, pageOf(args))),
    electionEvent: async (_root: unknown, args: { eventKey: string }) =>
      unwrap(await getElectionEvent(deps, args.eventKey)),
    electionContests: async (
      _root: unknown,
      args: ElectionPageArgs & { occurrenceKey: string; filter?: unknown }
    ) =>
      unwrap(
        await listElectionContests(deps, {
          occurrenceKey: args.occurrenceKey,
          filter: withoutNulls(args.filter),
          ...pageOf(args),
        })
      ),
    electionContest: async (_root: unknown, args: { contestKey: string }) =>
      unwrap(await getElectionContest(deps, args.contestKey)),
    electionResult: async (
      _root: unknown,
      args: { occurrenceKey: string; office: string; scopeKey: string; contestKey?: string | null }
    ) =>
      unwrap(
        await getElectionResult(deps, {
          occurrenceKey: args.occurrenceKey,
          office: args.office,
          scopeKey: args.scopeKey,
          contestKey: args.contestKey ?? null,
        })
      ),
    electionResultScopes: async (
      _root: unknown,
      args: ElectionPageArgs & {
        occurrenceKey: string;
        office: string;
        scopeType: ElectionPlaceType;
        contestKey?: string | null;
      }
    ) =>
      unwrap(
        await listElectionResultScopes(deps, {
          occurrenceKey: args.occurrenceKey,
          office: args.office,
          scopeType: args.scopeType,
          contestKey: args.contestKey ?? null,
          ...pageOf(args),
        })
      ),
    electionCompetitors: async (
      _root: unknown,
      args: ElectionPageArgs & { eventKey: string; filter?: unknown }
    ) =>
      unwrap(
        await listElectionCompetitors(deps, {
          eventKey: args.eventKey,
          filter: withoutNulls(args.filter),
          ...pageOf(args),
        })
      ),
  },
});
