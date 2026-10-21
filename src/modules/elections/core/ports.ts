import type {
  ElectionCompetitorPageRequest,
  ElectionCompetitorRecord,
  ElectionContestPageRequest,
  ElectionContestRaceRecord,
  ElectionEventRecord,
  ElectionPageRequest,
  ElectionRecordPage,
  ElectionResultRecord,
  ElectionResultRequest,
  ElectionResultScopesRequest,
  ElectionScopeFiguresRecord,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * Reads only the active generation of each event: `elections.serving_active`
 * and the `elections.active_*` views of the scrapper's serving model, plus
 * territory names from `core.territories`. Nothing reads an inactive or
 * unsealed generation, attrs, raw rows or candidate names. A disabled
 * repository refuses every call without querying.
 */
export interface ElectionsRepository {
  /** Events with an active generation, in `event_key` order, with their occurrences. */
  listEvents(
    request: ElectionPageRequest
  ): Promise<Result<ElectionRecordPage<ElectionEventRecord>, ApiError>>;
  /** Null when the event has no active generation. */
  eventByKey(eventKey: string): Promise<Result<ElectionEventRecord | null, ApiError>>;
  /**
   * Contests of one active occurrence in `contest_key` order, each with its
   * votes and valid votes at its own jurisdiction; null when the occurrence is
   * not active.
   */
  listContests(
    request: ElectionContestPageRequest
  ): Promise<Result<ElectionRecordPage<ElectionContestRaceRecord> | null, ApiError>>;
  /** Null when the contest is not in an active generation. */
  contestByKey(contestKey: string): Promise<Result<ElectionContestRaceRecord | null, ApiError>>;
  /**
   * Every figure of one scope and its coverage. Null when the occurrence is not
   * active, the contest is not one of its contests for that office, or the
   * scope has neither figures nor coverage (nor is the contest's jurisdiction).
   */
  result(request: ElectionResultRequest): Promise<Result<ElectionResultRecord | null, ApiError>>;
  /**
   * The scopes of one type that have figures, in `scope_key` order, each with
   * its figures. Inside a contest its own jurisdiction is not a child. Null
   * when the occurrence is not active or the contest is not one of its
   * contests for that office.
   */
  listResultScopes(
    request: ElectionResultScopesRequest
  ): Promise<Result<ElectionRecordPage<ElectionScopeFiguresRecord> | null, ApiError>>;
  /** Null when the event has no active generation. */
  listCompetitors(
    request: ElectionCompetitorPageRequest
  ): Promise<Result<ElectionRecordPage<ElectionCompetitorRecord> | null, ApiError>>;
}
