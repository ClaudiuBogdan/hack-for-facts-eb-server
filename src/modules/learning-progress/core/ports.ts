/**
 * Learning Progress Module - Ports
 */

import type { LearningProgressError } from './errors.js';
import type {
  CampaignAdminUsersMetaCounts,
  GetCampaignAdminStatsInput,
  GetCampaignAdminStatsOutput,
  GetCampaignAdminUsersMetaCountsInput,
  GetRecordsOptions,
  ListCampaignAdminInteractionRowsInput,
  ListCampaignAdminInteractionRowsOutput,
  ListCampaignAdminUsersInput,
  ListCampaignAdminUsersOutput,
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

  acquireAutoReviewReuseTransactionLock(input: {
    recordKey: string;
  }): Promise<Result<void, LearningProgressError>>;

  findLatestCampaignAdminReviewedExactKeyMatches(input: {
    recordKey: string;
    interactionId: string;
    entityCui: string;
  }): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>>;

  listCampaignAdminInteractionRows(
    input: ListCampaignAdminInteractionRowsInput
  ): Promise<Result<ListCampaignAdminInteractionRowsOutput, LearningProgressError>>;

  listCampaignAdminUsers(
    input: ListCampaignAdminUsersInput
  ): Promise<Result<ListCampaignAdminUsersOutput, LearningProgressError>>;

  getCampaignAdminUsersMetaCounts(
    input: GetCampaignAdminUsersMetaCountsInput
  ): Promise<Result<CampaignAdminUsersMetaCounts, LearningProgressError>>;

  getCampaignAdminStats(
    input: GetCampaignAdminStatsInput
  ): Promise<Result<GetCampaignAdminStatsOutput, LearningProgressError>>;

  upsertInteractiveRecord(
    input: UpsertInteractiveRecordInput
  ): Promise<Result<UpsertInteractiveRecordResult, LearningProgressError>>;

  resetProgress(userId: string): Promise<Result<void, LearningProgressError>>;

  withTransaction<T>(
    callback: (repo: LearningProgressRepository) => Promise<Result<T, LearningProgressError>>
  ): Promise<Result<T, LearningProgressError>>;
}
