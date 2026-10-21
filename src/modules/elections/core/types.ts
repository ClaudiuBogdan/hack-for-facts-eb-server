import type { FilterInput } from '@/modules/shared/index.js';

/**
 * Elections results over the scrapper's serving model (scrapper prod migration
 * 20261020T140000): one active, audited generation per event, read only through
 * the `elections.active_*` views. Vocabularies mirror that migration's CHECKs.
 */

export const ELECTION_FAMILIES = [
  'local',
  'parliamentary',
  'presidential',
  'european',
  'referendum',
] as const;
export type ElectionFamily = (typeof ELECTION_FAMILIES)[number];

export const ELECTION_ROUNDS = ['r1', 'r2', 'r3', 'unknown'] as const;
export type ElectionRound = (typeof ELECTION_ROUNDS)[number];

export const ELECTION_OCCURRENCE_KINDS = ['general', 'runoff', 'repeat', 'partial'] as const;
export type ElectionOccurrenceKind = (typeof ELECTION_OCCURRENCE_KINDS)[number];

/**
 * An occurrence or contest that was held, or annulled. An annulled contest may have no
 * figures; an occurrence annulled after its count keeps the counted figures it annulled.
 */
export const ELECTION_STATUSES = ['held', 'annulled'] as const;
export type ElectionStatus = (typeof ELECTION_STATUSES)[number];

export const ELECTION_PLACE_TYPES = ['uat', 'county', 'national', 'diaspora'] as const;
export type ElectionPlaceType = (typeof ELECTION_PLACE_TYPES)[number];

export const ELECTION_COMPETITOR_KINDS = [
  'party',
  'minority_org',
  'list',
  'independent',
  'independents_bucket',
] as const;
export type ElectionCompetitorKind = (typeof ELECTION_COMPETITOR_KINDS)[number];

export const ELECTION_TALLY_MEASURES = ['votes', 'mandates'] as const;
export type ElectionTallyMeasure = (typeof ELECTION_TALLY_MEASURES)[number];

/** `none` for votes; mandate phases stay separate (never summed). */
export const ELECTION_ALLOCATION_PHASES = ['none', 'man_1', 'man_2', 'final'] as const;
export type ElectionAllocationPhase = (typeof ELECTION_ALLOCATION_PHASES)[number];

export const ELECTION_TURNOUT_MEASURES = [
  'registered',
  'voted',
  'valid',
  'invalid',
  'blank',
] as const;
export type ElectionTurnoutMeasure = (typeof ELECTION_TURNOUT_MEASURES)[number];

export const ELECTION_CONSTRUCTIONS = ['published', 'summed_leaves'] as const;
export const ELECTION_SOURCE_LEVELS = ['pv_lines', 'published_total'] as const;
export const ELECTION_FINALITIES = ['final', 'provisional', 'unknown'] as const;
export const ELECTION_COUNTED_POPULATIONS = ['all', 'linked_only'] as const;
export const ELECTION_COMPLETENESS = ['complete', 'partial'] as const;
/** VERIFIED: equals a separately published figure. UNCHECKED: no counterpart. SUSPECT: known defect. */
export const ELECTION_FIGURE_STATUSES = ['VERIFIED', 'UNCHECKED', 'SUSPECT'] as const;
export const ELECTION_COVERAGE_STATES = [
  'usable',
  'absent',
  'links_missing',
  'links_wrong',
] as const;

export type ElectionConstruction = (typeof ELECTION_CONSTRUCTIONS)[number];
export type ElectionSourceLevel = (typeof ELECTION_SOURCE_LEVELS)[number];
export type ElectionFinality = (typeof ELECTION_FINALITIES)[number];
export type ElectionCountedPopulation = (typeof ELECTION_COUNTED_POPULATIONS)[number];
export type ElectionCompleteness = (typeof ELECTION_COMPLETENESS)[number];
export type ElectionFigureStatus = (typeof ELECTION_FIGURE_STATUSES)[number];
export type ElectionCoverageState = (typeof ELECTION_COVERAGE_STATES)[number];

/**
 * The public issue codes. A stored issue is `CODE` or `CODE:<detail>`; only
 * MISSING_SCOPE keeps its detail (a place key). Any other detail can name an
 * internal decision and is dropped; an unknown code fails the response.
 */
export const ELECTION_ISSUE_CODES = [
  'MISSING_SCOPE',
  'MEASURE_NOT_IN_INPUT',
  'UAT_UNMAPPED',
  'OFFICIAL_TOTAL_DIFFERS',
  'REFERENCE_SECONDARY_SOURCE',
  'CONTAINS_ANNULLED_CONTEST',
  'PROTOCOL_HEADER_INCONSISTENT',
  'POSTAL_REGISTRATIONS_NOT_IN_SOURCE',
  'POSTAL_VOTED_ENVELOPES',
  'SUPERSEDED_IN_EXPORT',
  'CAPITAL_UNPUBLISHED',
  'NOT_IN_SOURCE',
  'NO_ALLOCATION_EVIDENCE',
] as const;

// ── Repository records: stored values as read, validated in core ──

export interface ElectionOfficeCountRecord {
  readonly office: string;
  readonly contests: number;
}

export interface ElectionOccurrenceRecord {
  readonly occurrenceKey: string;
  readonly eventKey: string;
  readonly ballotDate: string;
  readonly round: string;
  readonly kind: string;
  readonly status: string;
  readonly offices: readonly ElectionOfficeCountRecord[];
}

export interface ElectionEventRecord {
  readonly eventKey: string;
  readonly publicationId: string;
  readonly activatedAt: string;
  readonly occurrences: readonly ElectionOccurrenceRecord[];
}

/** A place key with the territory names that match it (none for diaspora/national or an unmapped code). */
export interface ElectionPlaceRecord {
  readonly placeKey: string;
  readonly name: string | null;
  readonly countyCode: string | null;
  readonly countyName: string | null;
}

export interface ElectionCompetitorRecord {
  readonly competitorKey: string;
  readonly kind: string;
  readonly actorKey: string | null;
  readonly label: string;
  readonly reportedLabels: readonly string[];
}

/** Shared provenance and quality columns of a stored figure. */
export interface ElectionFigureQualityRecord {
  readonly value: string;
  readonly construction: string;
  readonly sourceLevel: string;
  readonly finality: string;
  readonly geographicCompleteness: string;
  readonly includesDiaspora: boolean | null;
  readonly status: string;
  readonly issues: readonly string[];
}

export interface ElectionTallyRecord extends ElectionFigureQualityRecord {
  readonly competitor: ElectionCompetitorRecord;
  readonly reportedLabel: string;
  readonly measure: string;
  readonly allocationPhase: string;
  readonly countedPopulation: string;
}

export interface ElectionTurnoutRecord extends ElectionFigureQualityRecord {
  readonly measure: string;
}

export interface ElectionCoverageRecord {
  readonly measure: string;
  readonly allocationPhase: string;
  /** Null for the scope-type default cell. */
  readonly scopeKey: string | null;
  readonly state: string;
  readonly issues: readonly string[];
}

export interface ElectionContestRecord {
  readonly contestKey: string;
  readonly occurrenceKey: string;
  readonly eventKey: string;
  readonly office: string;
  readonly status: string;
  readonly replacedBy: string | null;
  readonly jurisdiction: ElectionPlaceRecord;
}

/** A contest with its votes and valid votes at its own jurisdiction (the race inputs). */
export interface ElectionContestRaceRecord extends ElectionContestRecord {
  readonly votes: readonly ElectionTallyRecord[];
  readonly valid: ElectionTurnoutRecord | null;
}

/** Every figure at one scope of an office (in a contest, or the office aggregate). */
export interface ElectionScopeFiguresRecord {
  readonly place: ElectionPlaceRecord;
  readonly tallies: readonly ElectionTallyRecord[];
  readonly turnout: readonly ElectionTurnoutRecord[];
}

export interface ElectionResultRecord extends ElectionScopeFiguresRecord {
  readonly occurrenceKey: string;
  readonly eventKey: string;
  readonly office: string;
  readonly contest: ElectionContestRecord | null;
  readonly coverage: readonly ElectionCoverageRecord[];
}

export interface ElectionRecordPage<T> {
  readonly items: readonly T[];
  /** Exact filtered count from the same snapshot. */
  readonly total: number;
}

// ── Requests ──

export interface ElectionPageRequest {
  readonly page: number;
  readonly pageSize: number;
}

export interface ElectionContestPageRequest extends ElectionPageRequest {
  readonly occurrenceKey: string;
  readonly filter: FilterInput;
}

export interface ElectionCompetitorPageRequest extends ElectionPageRequest {
  readonly eventKey: string;
  readonly filter: FilterInput;
}

/** One scope's figures: in a contest (contestKey) or the office aggregate (contestKey null). */
export interface ElectionResultRequest {
  readonly occurrenceKey: string;
  readonly office: string;
  readonly contestKey: string | null;
  readonly scopeKey: string;
}

/** The child scopes of one type: a contest's breakdown, or the office aggregate's places. */
export interface ElectionResultScopesRequest extends ElectionPageRequest {
  readonly occurrenceKey: string;
  readonly office: string;
  readonly contestKey: string | null;
  readonly scopeType: ElectionPlaceType;
}

// ── Served views ──

export interface ElectionPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

export interface ElectionOfficeCount {
  readonly office: string;
  readonly contests: number;
}

/** One ballot day of an event. The round is an attribute; the date is the identity. */
export interface ElectionOccurrence {
  readonly occurrenceKey: string;
  readonly eventKey: string;
  readonly ballotDate: string;
  readonly round: ElectionRound;
  readonly kind: ElectionOccurrenceKind;
  readonly status: ElectionStatus;
  readonly offices: readonly ElectionOfficeCount[];
}

export interface ElectionPublication {
  readonly publicationId: string;
  readonly activatedAt: string;
}

/** An event with a published, audited generation. `family` and `year` are parts of its key. */
export interface ElectionEvent {
  readonly eventKey: string;
  readonly family: ElectionFamily;
  readonly year: number;
  readonly publication: ElectionPublication;
  readonly occurrences: readonly ElectionOccurrence[];
}

/**
 * A place: `uat:<SIRUTA>`, `county:<code>`, `diaspora` or `national`. Names come
 * from the territory reference; null for diaspora and national (the client
 * names them) and for a code the reference does not hold (a retired SIRUTA).
 */
export interface ElectionPlace {
  readonly placeKey: string;
  readonly placeType: ElectionPlaceType;
  readonly sirutaCode: string | null;
  readonly countyCode: string | null;
  readonly name: string | null;
  readonly countyName: string | null;
}

export interface ElectionCompetitor {
  readonly competitorKey: string;
  readonly kind: ElectionCompetitorKind;
  /** The party spine key, for a party or minority organisation. */
  readonly actorKey: string | null;
  readonly label: string;
  readonly reportedLabels: readonly string[];
}

/** numerator / denominator as a percentage, rounded half-up to two decimals. */
export interface ElectionShare {
  readonly percent: string;
  readonly numerator: string;
  readonly denominator: string;
  readonly basis: 'valid_votes_same_scope' | 'registered_same_scope';
}

interface ElectionFigureQuality {
  /** A non-negative integer as a decimal string; 0 means the source printed 0. */
  readonly value: string;
  readonly construction: ElectionConstruction;
  readonly sourceLevel: ElectionSourceLevel;
  readonly finality: ElectionFinality;
  readonly geographicCompleteness: ElectionCompleteness;
  /** Set on national figures; null elsewhere. */
  readonly includesDiaspora: boolean | null;
  readonly status: ElectionFigureStatus;
  readonly issues: readonly string[];
}

export interface ElectionTally extends ElectionFigureQuality {
  readonly competitor: ElectionCompetitor;
  /** The label as the source printed it for this figure. */
  readonly reportedLabel: string;
  readonly measure: ElectionTallyMeasure;
  readonly allocationPhase: ElectionAllocationPhase;
  readonly countedPopulation: ElectionCountedPopulation;
  /** Votes only: of the valid votes of the same scope, when they are comparable. */
  readonly share: ElectionShare | null;
}

export interface ElectionTurnoutFigure extends ElectionFigureQuality {
  readonly measure: ElectionTurnoutMeasure;
}

export interface ElectionCoverageCell {
  readonly measure: string;
  readonly allocationPhase: ElectionAllocationPhase;
  /** The scope-type default when false; this place's own cell when true. */
  readonly placeSpecific: boolean;
  readonly state: ElectionCoverageState;
  readonly issues: readonly string[];
}

export interface ElectionRaceEntry {
  readonly competitor: ElectionCompetitor;
  readonly votes: string;
  readonly share: ElectionShare | null;
}

/**
 * Computed at read time from the vote tallies of one scope: never a mandate or a
 * winner (mandates come only from allocation evidence). Only when every vote
 * tally there counts the same voters (completeness, missing places, diaspora
 * inclusion, all voters) and none is SUSPECT; it carries their quality.
 */
export interface ElectionRace {
  readonly competitorCount: number;
  /** VERIFIED when every vote tally is; UNCHECKED otherwise. */
  readonly status: 'VERIFIED' | 'UNCHECKED';
  readonly geographicCompleteness: ElectionCompleteness;
  /** The tallies' finality when they agree; unknown otherwise. */
  readonly finality: ElectionFinality;
  /** The union of the vote tallies' issues. */
  readonly issues: readonly string[];
  readonly leader: ElectionRaceEntry;
  readonly runnerUp: ElectionRaceEntry | null;
  /** Leader minus runner-up votes; null without a runner-up. */
  readonly marginVotes: string | null;
  /** Leader share minus runner-up share, in percentage points; null when either share is. */
  readonly marginPoints: string | null;
  readonly tied: boolean;
}

export interface ElectionContest {
  readonly contestKey: string;
  readonly occurrenceKey: string;
  readonly eventKey: string;
  readonly office: string;
  readonly jurisdiction: ElectionPlace;
  readonly status: ElectionStatus;
  readonly replacedBy: string | null;
  /**
   * Null when the contest has no votes at its jurisdiction (mandates only, or annulled
   * without figures). An annulled count keeps its race; a race never names a winner.
   */
  readonly race: ElectionRace | null;
}

export interface ElectionScopeFigures {
  readonly place: ElectionPlace;
  /** Votes by value (descending), then mandates by phase. */
  readonly tallies: readonly ElectionTally[];
  readonly turnout: readonly ElectionTurnoutFigure[];
  /** voted / registered of this scope, when both are comparable. */
  readonly participation: ElectionShare | null;
  readonly race: ElectionRace | null;
}

export interface ElectionResult extends ElectionScopeFigures {
  readonly occurrenceKey: string;
  readonly eventKey: string;
  readonly office: string;
  readonly contest: ElectionContest | null;
  readonly coverage: readonly ElectionCoverageCell[];
}
