import { err, ok, type Result } from 'neverthrow';

import {
  databaseError,
  invalidInput,
  MAX_PAGE_SIZE,
  notFound,
  offsetFor,
  type ApiError,
} from '@/modules/shared/index.js';

import {
  mapTallies,
  mapTurnout,
  raceOf,
  toCompetitor,
  toContest,
  toCoverage,
  toScopeFigures,
} from './figures.js';
import {
  electionCompetitorsFilterSpec,
  electionContestsFilterSpec,
  isOffice,
  isOpaqueText,
  MAX_KEY_LENGTH,
  validateFilter,
} from './filters.js';
import { parseEventKey, parsePlaceKey } from './keys.js';
import {
  ELECTION_OCCURRENCE_KINDS,
  ELECTION_PLACE_TYPES,
  ELECTION_ROUNDS,
  ELECTION_STATUSES,
  type ElectionCompetitor,
  type ElectionCompetitorPageRequest,
  type ElectionContest,
  type ElectionContestPageRequest,
  type ElectionContestRaceRecord,
  type ElectionEvent,
  type ElectionEventRecord,
  type ElectionOccurrence,
  type ElectionOccurrenceRecord,
  type ElectionPage,
  type ElectionPageRequest,
  type ElectionRecordPage,
  type ElectionResult,
  type ElectionResultRequest,
  type ElectionResultScopesRequest,
  type ElectionScopeFigures,
} from './types.js';

import type { ElectionsRepository } from './ports.js';

export interface ElectionsDeps {
  readonly repo: ElectionsRepository;
}

const unexpected = (what: string): ApiError =>
  databaseError(`Unexpected elections ${what} value; response refused.`);

const member = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

const checkPage = (page: number, pageSize: number): ApiError | null => {
  if (!Number.isSafeInteger(page) || page < 1)
    return invalidInput('page must be an integer >= 1', 'page');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE)
    return invalidInput(
      `pageSize must be an integer from 1 to ${String(MAX_PAGE_SIZE)}`,
      'pageSize'
    );
  // The SQL OFFSET is bound from this product; each factor being safe does not make it safe.
  if (!Number.isSafeInteger(offsetFor({ page, pageSize })))
    return invalidInput('page is beyond the largest safe offset', 'page');
  return null;
};

const checkKey = (key: string, field: string): ApiError | null =>
  isOpaqueText(key, MAX_KEY_LENGTH) ? null : invalidInput(`Invalid ${field}.`, field);

const checkOffice = (office: string): ApiError | null =>
  isOffice(office) ? null : invalidInput('Invalid office.', 'office');

const toPage = <R, V>(
  records: ElectionRecordPage<R>,
  request: ElectionPageRequest,
  map: (record: R) => Result<V, ApiError>
): Result<ElectionPage<V>, ApiError> => {
  if (!Number.isSafeInteger(records.total) || records.total < 0)
    return err(databaseError('Elections count is not an exact integer.'));
  const items: V[] = [];
  for (const record of records.items) {
    const mapped = map(record);
    if (mapped.isErr()) return err(mapped.error);
    items.push(mapped.value);
  }
  return ok({
    items,
    page: request.page,
    pageSize: request.pageSize,
    total: records.total,
    hasMore: offsetFor(request) + items.length < records.total,
  });
};

const toOccurrence = (record: ElectionOccurrenceRecord): Result<ElectionOccurrence, ApiError> => {
  if (
    !member(ELECTION_ROUNDS, record.round) ||
    !member(ELECTION_OCCURRENCE_KINDS, record.kind) ||
    !member(ELECTION_STATUSES, record.status)
  )
    return err(unexpected('occurrence'));
  return ok({
    occurrenceKey: record.occurrenceKey,
    eventKey: record.eventKey,
    ballotDate: record.ballotDate,
    round: record.round,
    kind: record.kind,
    status: record.status,
    offices: record.offices.map(({ office, contests }) => ({ office, contests })),
  });
};

export const toEvent = (record: ElectionEventRecord): Result<ElectionEvent, ApiError> => {
  const parts = parseEventKey(record.eventKey);
  if (parts === null) return err(unexpected('event key'));
  const occurrences: ElectionOccurrence[] = [];
  for (const occurrence of record.occurrences) {
    if (occurrence.eventKey !== record.eventKey) return err(unexpected('occurrence event'));
    const mapped = toOccurrence(occurrence);
    if (mapped.isErr()) return err(mapped.error);
    occurrences.push(mapped.value);
  }
  return ok({
    eventKey: record.eventKey,
    family: parts.family,
    year: parts.year,
    publication: { publicationId: record.publicationId, activatedAt: record.activatedAt },
    occurrences,
  });
};

/** Events with an active, audited generation, in `eventKey` order. */
export const listElectionEvents = async (
  deps: ElectionsDeps,
  request: ElectionPageRequest
): Promise<Result<ElectionPage<ElectionEvent>, ApiError>> => {
  const bad = checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const records = await deps.repo.listEvents(request);
  if (records.isErr()) return err(records.error);
  return toPage(records.value, request, toEvent);
};

/** One event with its occurrences; null when not published. */
export const getElectionEvent = async (
  deps: ElectionsDeps,
  eventKey: string
): Promise<Result<ElectionEvent | null, ApiError>> => {
  const bad = checkKey(eventKey, 'eventKey');
  if (bad !== null) return err(bad);
  const record = await deps.repo.eventByKey(eventKey);
  if (record.isErr()) return err(record.error);
  return record.value === null ? ok(null) : toEvent(record.value);
};

/** A contest with the race at its own jurisdiction. */
export const toContestWithRace = (
  record: ElectionContestRaceRecord
): Result<ElectionContest, ApiError> =>
  mapTurnout(record.valid === null ? [] : [record.valid]).andThen((valid) => {
    if (valid.some((figure) => figure.measure !== 'valid'))
      return err(unexpected('race denominator'));
    if (record.votes.some((tally) => tally.measure !== 'votes'))
      return err(unexpected('race tally'));
    return mapTallies(record.votes, valid[0]).andThen((votes) => toContest(record, raceOf(votes)));
  });

/** Contests of one occurrence; NotFound when the occurrence is not published. */
export const listElectionContests = async (
  deps: ElectionsDeps,
  request: ElectionContestPageRequest
): Promise<Result<ElectionPage<ElectionContest>, ApiError>> => {
  const bad =
    checkKey(request.occurrenceKey, 'occurrenceKey') ?? checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const filter = validateFilter(electionContestsFilterSpec, request.filter);
  if (filter.isErr()) return err(filter.error);
  const records = await deps.repo.listContests(request);
  if (records.isErr()) return err(records.error);
  if (records.value === null) return err(notFound('Election occurrence not found.', 'occurrence'));
  return toPage(records.value, request, toContestWithRace);
};

export const getElectionContest = async (
  deps: ElectionsDeps,
  contestKey: string
): Promise<Result<ElectionContest | null, ApiError>> => {
  const bad = checkKey(contestKey, 'contestKey');
  if (bad !== null) return err(bad);
  const record = await deps.repo.contestByKey(contestKey);
  if (record.isErr()) return err(record.error);
  return record.value === null ? ok(null) : toContestWithRace(record.value);
};

const checkResultRequest = (request: {
  readonly occurrenceKey: string;
  readonly office: string;
  readonly contestKey: string | null;
}): ApiError | null =>
  checkKey(request.occurrenceKey, 'occurrenceKey') ??
  checkOffice(request.office) ??
  (request.contestKey === null ? null : checkKey(request.contestKey, 'contestKey'));

/**
 * Every figure of one scope: the contest's (contestKey) or the office
 * aggregate's (no contestKey). A race only inside a contest: an aggregate
 * buckets independents and is a standing, not a race.
 */
export const getElectionResult = async (
  deps: ElectionsDeps,
  request: ElectionResultRequest
): Promise<Result<ElectionResult | null, ApiError>> => {
  const bad =
    checkResultRequest(request) ??
    (parsePlaceKey(request.scopeKey) === null
      ? invalidInput('Invalid scopeKey.', 'scopeKey')
      : null);
  if (bad !== null) return err(bad);
  const record = await deps.repo.result(request);
  if (record.isErr()) return err(record.error);
  if (record.value === null) return ok(null);
  const found = record.value;
  if (found.place.placeKey !== request.scopeKey) return err(unexpected('result scope'));
  const figures = toScopeFigures(found, found.contest !== null);
  if (figures.isErr()) return err(figures.error);
  const coverage = toCoverage(found.coverage);
  if (coverage.isErr()) return err(coverage.error);
  const contest =
    found.contest === null
      ? ok(null)
      : toContest(
          found.contest,
          found.contest.jurisdiction.placeKey === request.scopeKey ? figures.value.race : null
        );
  if (contest.isErr()) return err(contest.error);
  return ok({
    occurrenceKey: found.occurrenceKey,
    eventKey: found.eventKey,
    office: found.office,
    contest: contest.value,
    ...figures.value,
    coverage: coverage.value,
  });
};

/** The child scopes of one type with their figures; NotFound when the occurrence or contest is not published. */
export const listElectionResultScopes = async (
  deps: ElectionsDeps,
  request: ElectionResultScopesRequest
): Promise<Result<ElectionPage<ElectionScopeFigures>, ApiError>> => {
  const bad =
    checkResultRequest(request) ??
    (member(ELECTION_PLACE_TYPES, request.scopeType)
      ? null
      : invalidInput('Invalid scopeType.', 'scopeType')) ??
    checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const records = await deps.repo.listResultScopes(request);
  if (records.isErr()) return err(records.error);
  if (records.value === null)
    return err(notFound('Election occurrence or contest not found.', 'result'));
  return toPage(records.value, request, (record) => {
    const parts = parsePlaceKey(record.place.placeKey);
    if (parts?.placeType !== request.scopeType) return err(unexpected('result scope'));
    return toScopeFigures(record, request.contestKey !== null);
  });
};

/** Competitors of one event's generation; NotFound when the event is not published. */
export const listElectionCompetitors = async (
  deps: ElectionsDeps,
  request: ElectionCompetitorPageRequest
): Promise<Result<ElectionPage<ElectionCompetitor>, ApiError>> => {
  const bad = checkKey(request.eventKey, 'eventKey') ?? checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const filter = validateFilter(electionCompetitorsFilterSpec, request.filter);
  if (filter.isErr()) return err(filter.error);
  const records = await deps.repo.listCompetitors(request);
  if (records.isErr()) return err(records.error);
  if (records.value === null) return err(notFound('Election event not found.', 'event'));
  return toPage(records.value, request, toCompetitor);
};
