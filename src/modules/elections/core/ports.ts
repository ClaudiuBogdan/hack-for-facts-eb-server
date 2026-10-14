import type {
  ElectionContestPageRequest,
  ElectionContestRecord,
  ElectionEditionRecord,
  ElectionPageRequest,
  ElectionRecordPage,
} from './types.js';
import type { ApiError } from '@/modules/shared/index.js';
import type { Result } from 'neverthrow';

/**
 * Reads only the `elections.elections`, `elections.contests` and
 * `elections.electoral_events` dimensions — never a fact table, `attrs`,
 * evidence or artifact row — and only `privacy_class = 'public'` rows. A
 * disabled repository refuses every call without querying.
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
}
