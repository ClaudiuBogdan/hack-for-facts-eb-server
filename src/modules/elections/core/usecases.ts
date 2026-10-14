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
  electionCatalogFilterSpec,
  electionContestsFilterSpec,
  isOpaqueText,
  MAX_KEY_LENGTH,
  validateFilter,
} from './filters.js';
import {
  ELECTION_READINESS_ISSUES,
  ELECTION_SCOPE_TYPES,
  type ElectionContest,
  type ElectionContestPageRequest,
  type ElectionContestRecord,
  type ElectionEdition,
  type ElectionEditionRecord,
  type ElectionPage,
  type ElectionPageRequest,
  type ElectionReadiness,
  type ElectionReadinessIssue,
  type ElectionRecordPage,
  type ElectionScopeType,
} from './types.js';

import type { ElectionsRepository } from './ports.js';

export interface ElectionsDeps {
  readonly repo: ElectionsRepository;
}

/**
 * No qualified identity review, source selection, artifact access, results or
 * mandate projection exists for any edition yet, so these are constants of this
 * slice, not per-row judgements. Results and mandates stay UNAVAILABLE until a
 * separately qualified projection is added; nothing here derives them.
 */
const SLICE_READINESS = {
  identity: 'HELD',
  sourceSelection: 'HELD',
  sourceOpening: 'HELD',
  results: 'UNAVAILABLE',
  mandates: 'UNAVAILABLE',
} as const;

const ordered = (issues: readonly ElectionReadinessIssue[]): ElectionReadinessIssue[] =>
  ELECTION_READINESS_ISSUES.filter((issue) => issues.includes(issue));

const ALWAYS_HELD: readonly ElectionReadinessIssue[] = [
  'SOURCE_SELECTION_UNVERIFIED',
  'SOURCE_ARTIFACT_ACCESS_HELD',
  'RESULTS_UNAVAILABLE',
  'MANDATES_UNAVAILABLE',
];

/** An event link is a platform grouping (resolver output), never a verified identity or selection. */
const eventLinkIssue = (eventKey: string | null): ElectionReadinessIssue =>
  eventKey === null ? 'EVENT_LINK_UNAVAILABLE' : 'EVENT_LINK_UNVERIFIED';

export const editionReadiness = (record: ElectionEditionRecord): ElectionReadiness => ({
  ...SLICE_READINESS,
  issues: ordered([
    ...ALWAYS_HELD,
    'EDITION_IDENTITY_UNVERIFIED',
    'RESULT_STATUS_UNQUALIFIED',
    ...(record.year === null ? (['REPORTED_YEAR_MISSING'] as const) : []),
    ...(record.date === null ? (['REPORTED_DATE_MISSING'] as const) : []),
    eventLinkIssue(record.eventKey),
  ]),
});

export const contestReadiness = (record: ElectionContestRecord): ElectionReadiness => ({
  ...SLICE_READINESS,
  issues: ordered([
    ...ALWAYS_HELD,
    'CONTEST_IDENTITY_UNVERIFIED',
    'CONTEST_SCOPE_UNVERIFIED',
    eventLinkIssue(record.eventKey),
  ]),
});

/**
 * Default-deny: the repository already reads public rows only; a row (or event
 * link) that is not exactly `public` reaching here fails the whole response
 * instead of being dropped, so a broken predicate is loud and never leaks.
 */
const nonPublic = (): ApiError =>
  databaseError('Elections reader returned a non-public row; response refused.');

const eventIsPublic = (eventKey: string | null, eventPrivacyClass: string | null): boolean =>
  eventKey === null || eventPrivacyClass === 'public';

const isMember = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value);

export const toEdition = (record: ElectionEditionRecord): Result<ElectionEdition, ApiError> => {
  if (record.privacyClass !== 'public' || !eventIsPublic(record.eventKey, record.eventPrivacyClass))
    return err(nonPublic());
  return ok({
    electionKey: record.electionKey,
    eventKey: record.eventKey,
    reportedName: record.name,
    reportedYear: record.year,
    verifiedYear: null,
    reportedFamily: record.family,
    verifiedFamily: null,
    reportedRound: record.round,
    reportedDate: record.date,
    reportedAuthority: record.authority,
    readiness: editionReadiness(record),
  });
};

export const toContest = (record: ElectionContestRecord): Result<ElectionContest, ApiError> => {
  if (
    record.privacyClass !== 'public' ||
    record.electionPrivacyClass !== 'public' ||
    !eventIsPublic(record.eventKey, record.eventPrivacyClass)
  )
    return err(nonPublic());
  if (!isMember<ElectionScopeType>(ELECTION_SCOPE_TYPES, record.scopeType))
    return err(databaseError('Unexpected elections contest scope_type value.'));
  return ok({
    contestKey: record.contestKey,
    electionKey: record.electionKey,
    eventKey: record.eventKey,
    reportedOffice: record.office,
    verifiedOffice: null,
    chamber: record.chamber,
    reportedRound: record.roundLabel,
    scopeType: record.scopeType,
    sourceScopeKey: record.scopeKey,
    scopeLabel: record.scopeLabel,
    constituencyCode: record.constituencyCode,
    constituencyName: record.constituencyName,
    readiness: contestReadiness(record),
  });
};

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

/** Source editions (not distinct elections); the total counts editions only. */
export const listElectionEditions = async (
  deps: ElectionsDeps,
  request: ElectionPageRequest
): Promise<Result<ElectionPage<ElectionEdition>, ApiError>> => {
  const bad = checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const filter = validateFilter(electionCatalogFilterSpec, request.filter);
  if (filter.isErr()) return err(filter.error);
  const records = await deps.repo.listEditions(request);
  if (records.isErr()) return err(records.error);
  return toPage(records.value, request, toEdition);
};

export const getElectionEdition = async (
  deps: ElectionsDeps,
  electionKey: string
): Promise<Result<ElectionEdition | null, ApiError>> => {
  const bad = checkKey(electionKey, 'electionKey');
  if (bad !== null) return err(bad);
  const record = await deps.repo.editionByKey(electionKey);
  if (record.isErr()) return err(record.error);
  return record.value === null ? ok(null) : toEdition(record.value);
};

/** An absent and a non-public edition answer the same NotFound. */
export const listElectionContests = async (
  deps: ElectionsDeps,
  request: ElectionContestPageRequest
): Promise<Result<ElectionPage<ElectionContest>, ApiError>> => {
  const bad =
    checkKey(request.electionKey, 'electionKey') ?? checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const filter = validateFilter(electionContestsFilterSpec, request.filter);
  if (filter.isErr()) return err(filter.error);
  const records = await deps.repo.listContests(request);
  if (records.isErr()) return err(records.error);
  if (records.value === null) return err(notFound('Election edition not found.', 'edition'));
  return toPage(records.value, request, toContest);
};

export const getElectionContest = async (
  deps: ElectionsDeps,
  contestKey: string
): Promise<Result<ElectionContest | null, ApiError>> => {
  const bad = checkKey(contestKey, 'contestKey');
  if (bad !== null) return err(bad);
  const record = await deps.repo.contestByKey(contestKey);
  if (record.isErr()) return err(record.error);
  return record.value === null ? ok(null) : toContest(record.value);
};
