/**
 * Learning Progress Module - Ports
 */

import type { LearningProgressError } from './errors.js';
import type {
  CampaignEntityConfigCollectionCursor,
  CampaignEntityConfigCollectionSortBy,
  CampaignEntityConfigCollectionSortOrder,
  ListCampaignEntityConfigCollectionRowsOutput,
  CampaignEntityConfigRecordCursor,
  CampaignEntityConfigRecordSortBy,
  CampaignEntityConfigRecordSortOrder,
  CampaignAdminUsersMetaCounts,
  GetCampaignAdminStatsInput,
  GetCampaignAdminStatsOutput,
  GetCampaignAdminUsersMetaCountsInput,
  GetRecordsOptions,
  ListCampaignEntityConfigRowsOutput,
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

  acquireCampaignEntityConfigTransactionLock(input: {
    campaignKey: string;
    entityCui: string;
  }): Promise<Result<void, LearningProgressError>>;

  findLatestCampaignAdminReviewedExactKeyMatches(input: {
    recordKey: string;
    interactionId: string;
    entityCui: string;
  }): Promise<Result<readonly LearningProgressRecordRow[], LearningProgressError>>;

  listCampaignAdminInteractionRows(
    input: ListCampaignAdminInteractionRowsInput
  ): Promise<Result<ListCampaignAdminInteractionRowsOutput, LearningProgressError>>;

  listCampaignEntityConfigRows(input: {
    userId: string;
    recordKeyPrefix: string;
    entityCui?: string;
    updatedAtFrom?: string;
    updatedAtTo?: string;
    sortBy: CampaignEntityConfigRecordSortBy;
    sortOrder: CampaignEntityConfigRecordSortOrder;
    limit: number;
    cursor?: CampaignEntityConfigRecordCursor;
  }): Promise<Result<ListCampaignEntityConfigRowsOutput, LearningProgressError>>;

  listCampaignEntityConfigCollectionRows(input: {
    campaignKey: string;
    entityCui?: string;
    budgetPublicationDate?: string;
    hasBudgetPublicationDate?: boolean;
    officialBudgetUrl?: string;
    hasOfficialBudgetUrl?: boolean;
    updatedAtFrom?: string;
    updatedAtTo?: string;
    sortBy: CampaignEntityConfigCollectionSortBy;
    sortOrder: CampaignEntityConfigCollectionSortOrder;
    limit: number;
    cursor?: CampaignEntityConfigCollectionCursor;
  }): Promise<Result<ListCampaignEntityConfigCollectionRowsOutput, LearningProgressError>>;

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

  withTransaction<T, TError = LearningProgressError>(
    callback: (repo: LearningProgressRepository) => Promise<Result<T, TError>>
  ): Promise<Result<T, TError | LearningProgressError>>;
}
