/**
 * Learning Progress Module - Ports
 */

import type { LearningProgressError } from './errors.js';
import type {
  GetRecordsOptions,
  ListReviewRowsInput,
  ListReviewRowsOutput,
  LearningProgressRecordRow,
  UpsertInteractiveRecordInput,
  UpsertInteractiveRecordResult,
} from './types.js';
import type { Result } from 'neverthrow';

export interface LearningProgressRepository {
  getRecords(
    userId: string,
    options?: GetRecordsOptions
  ): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>>;

  getRecord(
    userId: string,
    recordKey: string
  ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>>;

  getRecordForUpdate(
    userId: string,
    recordKey: string
  ): Promise<Result<LearningProgressRecordRow | null, LearningProgressError>>;

  listReviewRows(
    input: ListReviewRowsInput
  ): Promise<Result<ListReviewRowsOutput, LearningProgressError>>;

  upsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>>;

  resetProgress(userId: string): Promise<Result<void, LearningProgressError>>;

  withTransaction<T>(
    callback: (repo: LearningProgressRepository) => Promise<Result<T, LearningProgressError>>
  ): Promise<Result<T, LearningProgressError>>;
}
