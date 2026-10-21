import { err, ok, type Result } from 'neverthrow';

import { databaseError, type ApiError } from '@/modules/shared/index.js';

import { parsePlaceKey } from './keys.js';
import {
  ELECTION_ALLOCATION_PHASES,
  ELECTION_COMPETITOR_KINDS,
  ELECTION_COMPLETENESS,
  ELECTION_CONSTRUCTIONS,
  ELECTION_COUNTED_POPULATIONS,
  ELECTION_COVERAGE_STATES,
  ELECTION_FIGURE_STATUSES,
  ELECTION_FINALITIES,
  ELECTION_ISSUE_CODES,
  ELECTION_SOURCE_LEVELS,
  ELECTION_STATUSES,
  ELECTION_TALLY_MEASURES,
  ELECTION_TURNOUT_MEASURES,
  type ElectionCompetitor,
  type ElectionCompetitorRecord,
  type ElectionContest,
  type ElectionContestRecord,
  type ElectionCoverageCell,
  type ElectionCoverageRecord,
  type ElectionFigureQualityRecord,
  type ElectionPlace,
  type ElectionPlaceRecord,
  type ElectionRace,
  type ElectionRaceEntry,
  type ElectionScopeFigures,
  type ElectionScopeFiguresRecord,
  type ElectionShare,
  type ElectionTally,
  type ElectionTallyRecord,
  type ElectionTurnoutFigure,
  type ElectionTurnoutRecord,
} from './types.js';

/**
 * Maps stored figures to served ones. Every stored vocabulary value is checked
 * against the migration's: an unknown value fails the response (500) rather
 * than reaching a client. Shares and race figures are integer arithmetic over
 * the figures of one scope; nothing is summed across scopes or measures.
 */

const INTEGER_TEXT = /^(?:0|[1-9][0-9]*)$/u;

const unexpected = (what: string): ApiError =>
  databaseError(`Unexpected elections ${what} value; response refused.`);

const member = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

const checked = <T extends string>(
  values: readonly T[],
  value: string,
  what: string
): Result<T, ApiError> => (member(values, value) ? ok(value) : err(unexpected(what)));

const MISSING_SCOPE = 'MISSING_SCOPE';

/** Stored issues as public codes: only MISSING_SCOPE keeps its (place key) detail. */
export const publicIssues = (issues: readonly string[]): Result<string[], ApiError> => {
  const out: string[] = [];
  for (const issue of issues) {
    const separator = issue.indexOf(':');
    const code = separator === -1 ? issue : issue.slice(0, separator);
    if (!member(ELECTION_ISSUE_CODES, code)) return err(unexpected('issue'));
    if (code === MISSING_SCOPE) {
      const place = issue.slice(separator + 1);
      if (separator === -1 || parsePlaceKey(place) === null) return err(unexpected('issue'));
      out.push(issue);
    } else out.push(code);
  }
  return ok([...new Set(out)]);
};

export const toPlace = (record: ElectionPlaceRecord): Result<ElectionPlace, ApiError> => {
  const parts = parsePlaceKey(record.placeKey);
  if (parts === null) return err(unexpected('place key'));
  return ok({
    placeKey: record.placeKey,
    placeType: parts.placeType,
    sirutaCode: parts.sirutaCode,
    countyCode: parts.countyCode ?? record.countyCode,
    name: record.name,
    countyName: record.countyName,
  });
};

export const toCompetitor = (
  record: ElectionCompetitorRecord
): Result<ElectionCompetitor, ApiError> =>
  checked(ELECTION_COMPETITOR_KINDS, record.kind, 'competitor kind').map((kind) => ({
    competitorKey: record.competitorKey,
    kind,
    actorKey: record.actorKey,
    label: record.label,
    reportedLabels: [...record.reportedLabels],
  }));

const toQuality = (record: ElectionFigureQualityRecord) => {
  if (!INTEGER_TEXT.test(record.value)) return err(unexpected('figure'));
  return checked(ELECTION_CONSTRUCTIONS, record.construction, 'construction').andThen(
    (construction) =>
      checked(ELECTION_SOURCE_LEVELS, record.sourceLevel, 'source level').andThen((sourceLevel) =>
        checked(ELECTION_FINALITIES, record.finality, 'finality').andThen((finality) =>
          checked(ELECTION_COMPLETENESS, record.geographicCompleteness, 'completeness').andThen(
            (geographicCompleteness) =>
              checked(ELECTION_FIGURE_STATUSES, record.status, 'status').andThen((status) =>
                publicIssues(record.issues).map((issues) => ({
                  value: record.value,
                  construction,
                  sourceLevel,
                  finality,
                  geographicCompleteness,
                  includesDiaspora: record.includesDiaspora,
                  status,
                  issues,
                }))
              )
          )
        )
      )
  );
};

/** The places a partial figure misses, as one comparable text. */
const missingScopes = (figure: { readonly issues: readonly string[] }): string =>
  figure.issues
    .filter((issue) => issue.startsWith(`${MISSING_SCOPE}:`))
    .sort()
    .join('\n');

/** Two figures cover the same voters: same completeness, same missing places, same diaspora inclusion. */
const sameCoverage = (
  left: Pick<ElectionTurnoutFigure, 'geographicCompleteness' | 'includesDiaspora' | 'issues'>,
  right: Pick<ElectionTurnoutFigure, 'geographicCompleteness' | 'includesDiaspora' | 'issues'>
): boolean =>
  left.geographicCompleteness === right.geographicCompleteness &&
  left.includesDiaspora === right.includesDiaspora &&
  missingScopes(left) === missingScopes(right);

/** numerator × 100 / denominator, rounded half-up to two decimals; null for a zero denominator. */
export const percentOf = (numerator: string, denominator: string): string | null => {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === 0n || n < 0n) return null;
  const hundredths = (n * 20000n + d) / (2n * d);
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
};

const share = (
  numerator: string,
  denominator: string,
  basis: ElectionShare['basis']
): ElectionShare | null => {
  const percent = percentOf(numerator, denominator);
  return percent === null ? null : { percent, numerator, denominator, basis };
};

/** A vote tally's share of the same scope's valid votes, when both count the same voters. */
const voteShare = (
  tally: Omit<ElectionTally, 'share'>,
  valid: ElectionTurnoutFigure | undefined
): ElectionShare | null =>
  tally.measure === 'votes' &&
  tally.countedPopulation === 'all' &&
  valid !== undefined &&
  sameCoverage(tally, valid)
    ? share(tally.value, valid.value, 'valid_votes_same_scope')
    : null;

/**
 * voted / registered of one place, only when both are complete, unflagged and
 * comparable. Never for the diaspora: its registration does not bound its
 * participation (supplementary lists).
 */
const participation = (
  place: ElectionPlace,
  turnout: readonly ElectionTurnoutFigure[]
): ElectionShare | null => {
  if (place.placeType === 'diaspora') return null;
  const voted = turnout.find((figure) => figure.measure === 'voted');
  const registered = turnout.find((figure) => figure.measure === 'registered');
  if (voted === undefined || registered === undefined) return null;
  const clean = (figure: ElectionTurnoutFigure) =>
    figure.geographicCompleteness === 'complete' &&
    figure.status !== 'SUSPECT' &&
    figure.issues.length === 0;
  if (!clean(voted) || !clean(registered) || !sameCoverage(voted, registered)) return null;
  return share(voted.value, registered.value, 'registered_same_scope');
};

export const toTurnout = (record: ElectionTurnoutRecord): Result<ElectionTurnoutFigure, ApiError> =>
  checked(ELECTION_TURNOUT_MEASURES, record.measure, 'turnout measure').andThen((measure) =>
    toQuality(record).map((quality) => ({ ...quality, measure }))
  );

const toTallyWithoutShare = (
  record: ElectionTallyRecord
): Result<Omit<ElectionTally, 'share'>, ApiError> =>
  checked(ELECTION_TALLY_MEASURES, record.measure, 'tally measure').andThen((measure) =>
    checked(ELECTION_ALLOCATION_PHASES, record.allocationPhase, 'allocation phase').andThen(
      (allocationPhase) =>
        checked(ELECTION_COUNTED_POPULATIONS, record.countedPopulation, 'population').andThen(
          (countedPopulation) =>
            toCompetitor(record.competitor).andThen((competitor) =>
              toQuality(record).map((quality) => ({
                ...quality,
                competitor,
                reportedLabel: record.reportedLabel,
                measure,
                allocationPhase,
                countedPopulation,
              }))
            )
        )
    )
  );

const PHASE_ORDER: Readonly<Record<string, number>> = { none: 0, man_1: 1, man_2: 2, final: 3 };

const byKey = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Larger value first, then competitor key: a stable total order. */
const byValueThenKey = (
  left: { readonly value: string; readonly competitor: ElectionCompetitor },
  right: { readonly value: string; readonly competitor: ElectionCompetitor }
): number => {
  const a = BigInt(left.value);
  const b = BigInt(right.value);
  if (a !== b) return a > b ? -1 : 1;
  return byKey(left.competitor.competitorKey, right.competitor.competitorKey);
};

/** Votes first (by value), then each mandate phase in order. */
export const orderTallies = <T extends Omit<ElectionTally, 'share'>>(tallies: readonly T[]): T[] =>
  [...tallies].sort((left, right) => {
    const phase =
      (PHASE_ORDER[left.allocationPhase] ?? 9) - (PHASE_ORDER[right.allocationPhase] ?? 9);
    return phase !== 0 ? phase : byValueThenKey(left, right);
  });

export const mapTallies = (
  records: readonly ElectionTallyRecord[],
  valid: ElectionTurnoutFigure | undefined
): Result<ElectionTally[], ApiError> => {
  const tallies: Omit<ElectionTally, 'share'>[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const tally = toTallyWithoutShare(record);
    if (tally.isErr()) return err(tally.error);
    const key = `${tally.value.measure}\u0000${tally.value.allocationPhase}\u0000${tally.value.competitor.competitorKey}`;
    if (seen.has(key))
      return err(databaseError('Elections figure is duplicated; response refused.'));
    seen.add(key);
    tallies.push(tally.value);
  }
  return ok(orderTallies(tallies).map((tally) => ({ ...tally, share: voteShare(tally, valid) })));
};

export const mapTurnout = (
  records: readonly ElectionTurnoutRecord[]
): Result<ElectionTurnoutFigure[], ApiError> => {
  const figures: ElectionTurnoutFigure[] = [];
  for (const record of records) {
    const figure = toTurnout(record);
    if (figure.isErr()) return err(figure.error);
    if (figures.some((other) => other.measure === figure.value.measure))
      return err(databaseError('Elections figure is duplicated; response refused.'));
    figures.push(figure.value);
  }
  const order = ELECTION_TURNOUT_MEASURES as readonly string[];
  return ok(
    figures.sort((left, right) => order.indexOf(left.measure) - order.indexOf(right.measure))
  );
};

const raceEntry = (tally: ElectionTally): ElectionRaceEntry => ({
  competitor: tally.competitor,
  votes: tally.value,
  share: tally.share,
});

/**
 * Leader, runner-up and margin among the vote tallies of one scope, in the
 * order of `mapTallies`. Null without votes, and null unless every vote tally
 * counts the same voters (same completeness, missing places and diaspora
 * inclusion, all voters) and none is SUSPECT: a margin between figures of
 * different coverage or a known defect is not served. A tie is reported,
 * never broken into a winner.
 */
export const raceOf = (tallies: readonly ElectionTally[]): ElectionRace | null => {
  const votes = tallies.filter((tally) => tally.measure === 'votes');
  const [leader, runnerUp] = votes;
  if (leader === undefined) return null;
  const comparable = votes.every(
    (tally) =>
      tally.countedPopulation === 'all' && tally.status !== 'SUSPECT' && sameCoverage(tally, leader)
  );
  if (!comparable) return null;
  const marginVotes =
    runnerUp === undefined ? null : (BigInt(leader.value) - BigInt(runnerUp.value)).toString();
  // Both shares must be of the same valid votes for the difference to be in points.
  const base = leader.share?.denominator;
  const marginPoints =
    marginVotes !== null && base !== undefined && runnerUp?.share?.denominator === base
      ? percentOf(marginVotes, base)
      : null;
  const finality = votes.every((tally) => tally.finality === leader.finality)
    ? leader.finality
    : 'unknown';
  return {
    competitorCount: votes.length,
    status: votes.every((tally) => tally.status === 'VERIFIED') ? 'VERIFIED' : 'UNCHECKED',
    geographicCompleteness: leader.geographicCompleteness,
    finality,
    issues: [...new Set(votes.flatMap((tally) => tally.issues))].sort(),
    leader: raceEntry(leader),
    runnerUp: runnerUp === undefined ? null : raceEntry(runnerUp),
    marginVotes,
    marginPoints,
    tied: runnerUp?.value === leader.value,
  };
};

/** All figures of one scope, with shares and participation computed within it. */
export const toScopeFigures = (
  record: ElectionScopeFiguresRecord,
  withRace: boolean
): Result<ElectionScopeFigures, ApiError> =>
  toPlace(record.place).andThen((place) =>
    mapTurnout(record.turnout).andThen((turnout) =>
      mapTallies(
        record.tallies,
        turnout.find((figure) => figure.measure === 'valid')
      ).map((tallies) => ({
        place,
        tallies,
        turnout,
        participation: participation(place, turnout),
        race: withRace ? raceOf(tallies) : null,
      }))
    )
  );

export const toContest = (
  record: ElectionContestRecord,
  race: ElectionRace | null
): Result<ElectionContest, ApiError> =>
  checked(ELECTION_STATUSES, record.status, 'contest status').andThen((status) =>
    toPlace(record.jurisdiction).map((jurisdiction) => ({
      contestKey: record.contestKey,
      occurrenceKey: record.occurrenceKey,
      eventKey: record.eventKey,
      office: record.office,
      jurisdiction,
      status,
      replacedBy: record.replacedBy,
      race,
    }))
  );

export const toCoverage = (
  records: readonly ElectionCoverageRecord[]
): Result<ElectionCoverageCell[], ApiError> => {
  const cells: ElectionCoverageCell[] = [];
  for (const record of records) {
    const phase = checked(ELECTION_ALLOCATION_PHASES, record.allocationPhase, 'allocation phase');
    if (phase.isErr()) return err(phase.error);
    const state = checked(ELECTION_COVERAGE_STATES, record.state, 'coverage state');
    if (state.isErr()) return err(state.error);
    const issues = publicIssues(record.issues);
    if (issues.isErr()) return err(issues.error);
    cells.push({
      measure: record.measure,
      allocationPhase: phase.value,
      placeSpecific: record.scopeKey !== null,
      state: state.value,
      issues: issues.value,
    });
  }
  return ok(cells);
};
