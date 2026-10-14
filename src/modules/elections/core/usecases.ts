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
  BUCHAREST_SCOPE_NOTE,
  COUNT_CELL_PATTERN,
  COUNTY_SOURCE,
  COUNTY_SOURCE_CITATION,
  COUNTY_SOURCE_NOTICE,
  COUNTY_SOURCE_STATEMENT,
  COUNTY_SOURCE_STATEMENT_CODES,
} from './county-source.js';
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
  type CountySourceCompetitorRecord,
  type CountySourceReportRecord,
  type CountySourceReportRequest,
  type ElectionContest,
  type ElectionCountySourceReport,
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
  type ElectionSourceCompetitor,
  type ElectionSourceStatementCell,
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
  request: Pick<ElectionPageRequest, 'page' | 'pageSize'>,
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

/** A served count cell: canonical integer text, served exactly as read. */
const INTEGER_TEXT = new RegExp(COUNT_CELL_PATTERN, 'u');

/** A stored number that is present but not canonical integer text is corrupt; null is only missing. */
const isCorrupt = (value: string | null): boolean => value !== null && !INTEGER_TEXT.test(value);

const nonInteger = (): ApiError =>
  databaseError('Elections source cell is not a non-negative integer.');

const duplicated = (): ApiError =>
  databaseError('Elections source cell is duplicated; response refused.');

/** After the completeness check both cells exist; a missing one contradicts the integrity counts. */
const toSourceCompetitor = (
  row: CountySourceCompetitorRecord
): Result<ElectionSourceCompetitor, ApiError> =>
  row.voturi === null || row.mandate === null
    ? err(databaseError('Elections source report contradicts its integrity counts.'))
    : ok({ sourceLabel: row.sourceLabel, voturi: row.voturi, mandate: row.mandate });

/**
 * Faults first, refused whole (500): a contest outside the qualified source, a
 * non-public row, an unadmitted column, an inexact count, a duplicated or
 * corrupt cell anywhere in the report (the integrity counts cover the labels
 * off the requested page). Then the source is complete or unavailable: every
 * admitted statement cell and every one of the file's competitor labels with
 * both cells, or null. A withheld, unreviewed or missing cell holds the whole
 * report; it is never filled, and a smaller set is never served as the source.
 */
export const toCountySourceReport = (
  record: CountySourceReportRecord,
  request: CountySourceReportRequest
): Result<ElectionCountySourceReport | null, ApiError> => {
  const { contest, integrity, competitors } = record;
  if (contest.privacyClass !== 'public' || contest.electionPrivacyClass !== 'public')
    return err(nonPublic());
  if (
    contest.electionKey !== COUNTY_SOURCE.electionKey ||
    contest.office !== COUNTY_SOURCE.office ||
    contest.scopeType !== COUNTY_SOURCE.scopeType
  )
    return err(databaseError('Elections reader returned a contest outside the qualified source.'));
  const values = new Map<string, string | null>();
  for (const cell of record.statement) {
    if (!COUNTY_SOURCE_STATEMENT_CODES.includes(cell.metricCode))
      return err(databaseError('Elections reader returned an unadmitted source column.'));
    if (values.has(cell.metricCode)) return err(duplicated());
    if (isCorrupt(cell.value)) return err(nonInteger());
    values.set(cell.metricCode, cell.value);
  }
  if (!Number.isSafeInteger(competitors.total) || competitors.total < 0)
    return err(databaseError('Elections count is not an exact integer.'));
  if (integrity.duplicatedLabels > 0) return err(duplicated());
  if (integrity.labelsWithNonIntegerCell > 0) return err(nonInteger());
  for (const row of competitors.items) {
    if (row.privacyClass !== 'public') return err(nonPublic());
    if (row.voturiCells > 1 || row.mandateCells > 1) return err(duplicated());
    if (isCorrupt(row.voturi) || isCorrupt(row.mandate)) return err(nonInteger());
  }
  const statement: ElectionSourceStatementCell[] = [];
  for (const { code, label } of COUNTY_SOURCE_STATEMENT) {
    const value = values.get(code);
    if (value === undefined || value === null) return ok(null);
    statement.push({ sourceCode: code, sourceLabel: label, value });
  }
  if (
    competitors.total !== COUNTY_SOURCE.competitorLabels ||
    integrity.completeLabels !== competitors.total ||
    integrity.labelsWithNullCell > 0
  )
    return ok(null);
  const page = toPage(competitors, request, toSourceCompetitor);
  if (page.isErr()) return err(page.error);
  return ok({
    contestKey: contest.contestKey,
    electionKey: contest.electionKey,
    reportedOffice: contest.office,
    scopeType: COUNTY_SOURCE.scopeType,
    sourceScopeKey: contest.scopeKey,
    scopeLabel: contest.scopeLabel,
    notice: COUNTY_SOURCE_NOTICE,
    scopeNote: contest.scopeKey === COUNTY_SOURCE.bucharestScopeKey ? BUCHAREST_SCOPE_NOTE : null,
    source: { ...COUNTY_SOURCE_CITATION },
    statement,
    competitors: page.value,
  });
};

/**
 * The reported county cells of the one qualified source (see county-source.ts)
 * for one contest, its competitor labels paged in source-label order. Null when
 * the contest is absent, not public or outside that source, or when the
 * source's cells cannot all be served: unavailable, not a statement about the
 * publisher's file.
 */
export const getCountySourceReport = async (
  deps: ElectionsDeps,
  request: CountySourceReportRequest
): Promise<Result<ElectionCountySourceReport | null, ApiError>> => {
  const bad =
    checkKey(request.contestKey, 'contestKey') ?? checkPage(request.page, request.pageSize);
  if (bad !== null) return err(bad);
  const record = await deps.repo.countySourceReport(request);
  if (record.isErr()) return err(record.error);
  return record.value === null ? ok(null) : toCountySourceReport(record.value, request);
};
