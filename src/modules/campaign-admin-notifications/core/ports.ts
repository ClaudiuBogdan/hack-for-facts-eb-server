import type { CampaignAdminNotificationError } from './errors.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationFieldDescriptor,
  CampaignNotificationTriggerCapabilities,
  CampaignNotificationMetaCounts,
  CampaignNotificationTemplateDescriptor,
  CampaignNotificationTemplatePreview,
  CampaignNotificationTriggerBulkExecutionResult,
  CampaignNotificationTriggerDescriptor,
  CampaignNotificationTriggerExecutionResult,
  ListCampaignNotificationAuditInput,
  ListCampaignNotificationAuditOutput,
} from './types.js';
import type { TSchema } from '@sinclair/typebox';
import type { Result } from 'neverthrow';

export interface CampaignNotificationAuditRepository {
  listCampaignNotificationAudit(
    input: ListCampaignNotificationAuditInput
  ): Promise<Result<ListCampaignNotificationAuditOutput, CampaignAdminNotificationError>>;

  getCampaignNotificationMetaCounts(input: {
    campaignKey: CampaignNotificationAdminCampaignKey;
  }): Promise<Result<CampaignNotificationMetaCounts, CampaignAdminNotificationError>>;
}

export interface CampaignNotificationTriggerExecutionInput {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly triggerId: string;
  readonly actorUserId: string;
  readonly payload: unknown;
}

export interface CampaignNotificationTriggerBulkExecutionInput {
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly triggerId: string;
  readonly actorUserId: string;
  readonly payload: unknown;
}

export interface CampaignNotificationTriggerDefinition {
  readonly triggerId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly familyId?: string;
  readonly templateId: string;
  readonly description: string;
  readonly inputSchema: TSchema;
  readonly inputFields: readonly CampaignNotificationFieldDescriptor[];
  readonly targetKind: string;
  readonly capabilities?: CampaignNotificationTriggerCapabilities;
  readonly bulkInputSchema?: TSchema;
  execute(
    input: CampaignNotificationTriggerExecutionInput
  ): Promise<Result<CampaignNotificationTriggerExecutionResult, CampaignAdminNotificationError>>;
  executeBulk?(
    input: CampaignNotificationTriggerBulkExecutionInput
  ): Promise<
    Result<CampaignNotificationTriggerBulkExecutionResult, CampaignAdminNotificationError>
  >;
}

export interface CampaignNotificationTriggerRegistry {
  list(
    campaignKey: CampaignNotificationAdminCampaignKey
  ): readonly CampaignNotificationTriggerDescriptor[];
  get(
    campaignKey: CampaignNotificationAdminCampaignKey,
    triggerId: string
  ): CampaignNotificationTriggerDefinition | null;
}

export interface CampaignNotificationTemplatePreviewService {
  listTemplates(
    campaignKey: CampaignNotificationAdminCampaignKey
  ): Promise<
    Result<readonly CampaignNotificationTemplateDescriptor[], CampaignAdminNotificationError>
  >;
  getTemplatePreview(input: {
    campaignKey: CampaignNotificationAdminCampaignKey;
    templateId: string;
  }): Promise<Result<CampaignNotificationTemplatePreview, CampaignAdminNotificationError>>;
}
