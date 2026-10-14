import type {
  CountySourceReportRecord,
  CountySourceReportRequest,
  ElectionContestPageRequest,
  ElectionContestRecord,
  ElectionEditionRecord,
  ElectionPageRequest,
  ElectionRecordPage,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * The catalog reads only the `elections.elections`, `elections.contests` and
 * `elections.electoral_events` dimensions. Only `countySourceReport` reads
 * fact rows, and only the one qualified carrier's (`COUNTY_SOURCE`). Every
 * read takes `privacy_class = 'public'` rows only, and none selects `attrs`,
 * evidence or an artifact row. A disabled repository refuses every call
 * without querying.
 */
export interface ElectionsRepository {
  /** Editions in `election_key` order. */
  listEditions(
    request: ElectionPageRequest
  ): Promise<Result<ElectionRecordPage<ElectionEditionRecord>, ApiError>>;
  /** Null when absent or not public. */
  editionByKey(electionKey: string): Promise<Result<ElectionEditionRecord | null, ApiError>>;
  /** Contests of one edition in `contest_key` order; null when the edition is absent or not public. */
  listContests(
    request: ElectionContestPageRequest
  ): Promise<Result<ElectionRecordPage<ElectionContestRecord> | null, ApiError>>;
  /** Null when absent, or when the contest or its edition is not public. */
  contestByKey(contestKey: string): Promise<Result<ElectionContestRecord | null, ApiError>>;
  /**
   * The qualified carrier's public cells of one public contest of the
   * qualified edition, office and scope, from one snapshot: every statement
   * cell, one page of competitor cells grouped by source label, and integrity
   * counts over all of the contest's labels taken before paging. Null when the
   * contest is absent, not public or outside that source.
   */
  countySourceReport(
    request: CountySourceReportRequest
  ): Promise<Result<CountySourceReportRecord | null, ApiError>>;
}
