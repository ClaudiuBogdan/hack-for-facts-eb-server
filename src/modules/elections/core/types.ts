import type { FilterInput } from '@/modules/shared/index.js';

/**
 * The contest scope types the production CHECK admits (`elections.contests`). A
 * scope is the source's reporting scope, not a verified jurisdiction: a polling
 * location's SIRUTA is not proof of the contest's territory.
 */
export const ELECTION_SCOPE_TYPES = [
  'siruta',
  'county',
  'diaspora',
  'national',
  'chamber',
  'source_constituency',
] as const;
export type ElectionScopeType = (typeof ELECTION_SCOPE_TYPES)[number];

/**
 * VERIFIED: a recorded review qualifies it. HELD: data may exist but its meaning
 * or access is not qualified, so it is not served. UNAVAILABLE: no qualified
 * projection exists. UNKNOWN: not determined.
 */
export type ElectionEvidenceStatus = 'VERIFIED' | 'HELD' | 'UNAVAILABLE' | 'UNKNOWN';

/** Why a source edition or contest is not a qualified result. Declaration order is output order. */
export const ELECTION_READINESS_ISSUES = [
  'EDITION_IDENTITY_UNVERIFIED',
  'CONTEST_IDENTITY_UNVERIFIED',
  'CONTEST_SCOPE_UNVERIFIED',
  'SOURCE_SELECTION_UNVERIFIED',
  'SOURCE_ARTIFACT_ACCESS_HELD',
  'RESULT_STATUS_UNQUALIFIED',
  'RESULTS_UNAVAILABLE',
  'MANDATES_UNAVAILABLE',
  'REPORTED_YEAR_MISSING',
  'REPORTED_DATE_MISSING',
  'EVENT_LINK_UNVERIFIED',
  'EVENT_LINK_UNAVAILABLE',
] as const;
export type ElectionReadinessIssue = (typeof ELECTION_READINESS_ISSUES)[number];

export interface ElectionReadiness {
  /** Reported year/family/office/scope against a recorded review. */
  readonly identity: ElectionEvidenceStatus;
  /** Which overlapping source edition represents an event. */
  readonly sourceSelection: ElectionEvidenceStatus;
  /** A client-openable original artifact. */
  readonly sourceOpening: ElectionEvidenceStatus;
  readonly results: ElectionEvidenceStatus;
  readonly mandates: ElectionEvidenceStatus;
  readonly issues: readonly ElectionReadinessIssue[];
}

// ── Repository records (named, governed columns only; privacy kept for the gate) ──

export interface ElectionEditionRecord {
  readonly electionKey: string;
  readonly privacyClass: string;
  readonly name: string;
  readonly family: string;
  readonly year: number | null;
  readonly round: string | null;
  readonly date: string | null;
  readonly authority: string;
  /** Null when the edition has no event link or the event is not public. */
  readonly eventKey: string | null;
  readonly eventPrivacyClass: string | null;
}

export interface ElectionContestRecord {
  readonly contestKey: string;
  readonly privacyClass: string;
  readonly electionKey: string;
  readonly electionPrivacyClass: string;
  readonly office: string;
  readonly chamber: string | null;
  readonly roundLabel: string | null;
  readonly scopeType: string;
  readonly scopeKey: string;
  readonly scopeLabel: string | null;
  readonly constituencyCode: string | null;
  readonly constituencyName: string | null;
  readonly eventKey: string | null;
  readonly eventPrivacyClass: string | null;
}

export interface ElectionRecordPage<T> {
  readonly items: readonly T[];
  /** Exact filtered count of source rows (editions or contests), from the same snapshot. */
  readonly total: number;
}

export interface ElectionPageRequest {
  readonly filter: FilterInput;
  readonly page: number;
  readonly pageSize: number;
}

export interface ElectionContestPageRequest extends ElectionPageRequest {
  readonly electionKey: string;
}

// ── Served views ──

/**
 * One SOURCE EDITION (`elections.elections` row), not a distinct real election:
 * two editions of one event are not two elections and not twice the votes.
 * `reported*` fields are stored source/loader labels; `verified*` stay null
 * until a recorded review establishes them. The stored `result_status` /
 * `is_final` labels are deliberately not read: finality is held, not served.
 */
export interface ElectionEdition {
  readonly electionKey: string;
  /** Platform event grouping (public events only); not a verified identity. */
  readonly eventKey: string | null;
  readonly reportedName: string;
  readonly reportedYear: number | null;
  readonly verifiedYear: null;
  readonly reportedFamily: string;
  readonly verifiedFamily: null;
  readonly reportedRound: string | null;
  readonly reportedDate: string | null;
  readonly reportedAuthority: string;
  readonly readiness: ElectionReadiness;
}

/** One source contest. `sourceScopeKey` is the source's scope, not a verified territory. */
export interface ElectionContest {
  readonly contestKey: string;
  readonly electionKey: string;
  readonly eventKey: string | null;
  readonly reportedOffice: string;
  readonly verifiedOffice: null;
  readonly chamber: string | null;
  readonly reportedRound: string | null;
  readonly scopeType: ElectionScopeType;
  readonly sourceScopeKey: string;
  readonly scopeLabel: string | null;
  readonly constituencyCode: string | null;
  readonly constituencyName: string | null;
  readonly readiness: ElectionReadiness;
}

export interface ElectionPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
}

// ── County source report (one qualified source; see county-source.ts) ──

export interface CountySourceReportRequest {
  readonly contestKey: string;
  /** Page of the competitor rows. */
  readonly page: number;
  readonly pageSize: number;
}

/** The contest, read only inside the qualified edition/office/scope. */
export interface CountySourceContestRecord {
  readonly contestKey: string;
  readonly privacyClass: string;
  readonly electionKey: string;
  readonly electionPrivacyClass: string;
  readonly office: string;
  readonly scopeType: string;
  readonly scopeKey: string;
  readonly scopeLabel: string | null;
}

/** One stored statement cell of the qualified carrier (duplicates are kept, to be refused). */
export interface CountySourceStatementRecord {
  readonly metricCode: string;
  /** `numeric_value::text`; null when stored without a number. */
  readonly value: string | null;
}

/**
 * One source label's cells of the qualified carrier, grouped by the label (the
 * source cell identity is label + column, whatever competitor id carries it),
 * with how many cells each column had.
 */
export interface CountySourceCompetitorRecord {
  readonly sourceLabel: string;
  readonly privacyClass: string;
  readonly voturiCells: number;
  readonly voturi: string | null;
  readonly mandateCells: number;
  readonly mandate: string | null;
}

/** Whole-report counts over every source label of the contest, taken before paging. */
export interface CountySourceIntegrityRecord {
  /** Labels with exactly one `voturi` and one `mandate` cell. */
  readonly completeLabels: number;
  /** Labels with more than one cell in a column. */
  readonly duplicatedLabels: number;
  readonly labelsWithNullCell: number;
  /** Labels with a stored number that is not canonical integer text. */
  readonly labelsWithNonIntegerCell: number;
}

export interface CountySourceReportRecord {
  readonly contest: CountySourceContestRecord;
  readonly statement: readonly CountySourceStatementRecord[];
  /** Source labels in `collate "C"` order; total counts distinct source labels. */
  readonly competitors: ElectionRecordPage<CountySourceCompetitorRecord>;
  readonly integrity: CountySourceIntegrityRecord;
}

export interface ElectionSourceCitation {
  readonly title: string;
  readonly url: string;
  readonly reportedElectionDate: string;
  readonly sourceFileVerifiedOn: string;
  readonly valuesComparedOn: string;
}

/**
 * A statement column of the file: its code, the legend's label and the
 * reported value, an integer as a decimal string (0 is a value). Always set:
 * a report missing a cell is withheld whole.
 */
export interface ElectionSourceStatementCell {
  readonly sourceCode: string;
  readonly sourceLabel: string;
  readonly value: string;
}

/** One competitor label of the file with its two cells, as reported (always both). */
export interface ElectionSourceCompetitor {
  readonly sourceLabel: string;
  readonly voturi: string;
  readonly mandate: string;
}

/**
 * The reported cells of one county contest of the qualified source: the file's
 * statement values and its competitor rows, served only complete. Reported
 * observations only: no finality, winner, seat, person, sector or derived
 * value (turnout, totals).
 */
export interface ElectionCountySourceReport {
  readonly contestKey: string;
  readonly electionKey: string;
  readonly reportedOffice: string;
  readonly scopeType: 'county';
  readonly sourceScopeKey: string;
  readonly scopeLabel: string | null;
  readonly notice: string;
  /** Set for the Municipiul București circumscription only. */
  readonly scopeNote: string | null;
  readonly source: ElectionSourceCitation;
  readonly statement: readonly ElectionSourceStatementCell[];
  readonly competitors: ElectionPage<ElectionSourceCompetitor>;
}
