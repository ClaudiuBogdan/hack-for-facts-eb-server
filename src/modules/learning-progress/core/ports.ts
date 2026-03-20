/**
 * Learning Progress Module - Ports
 */

import type { LearningProgressError } from './errors.js';
import type {
  LearningProgressRecordRow,
  UpsertInteractiveRecordInput,
  UpsertInteractiveRecordResult,
} from './types.js';
import type { Result } from 'neverthrow';

export interface LearningProgressRepository {
  getRecords(
    userId: string
  ): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>>;

  upsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>>;

  resetProgress(userId: string): Promise<Result<void, LearningProgressError>>;

  withTransaction<T>(
    callback: (repo: LearningProgressRepository) => Promise<Result<T, LearningProgressError>>
  ): Promise<Result<T, LearningProgressError>>;
}
