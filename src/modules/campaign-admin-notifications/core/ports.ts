import type { CampaignAdminNotificationError } from './errors.js';
import type {
  CampaignNotificationAdminCampaignKey,
  CampaignNotificationFieldDescriptor,
  CampaignNotificationTriggerCapabilities,
  CampaignNotificationMetaCounts,
  CampaignNotificationRunnablePlanSummary,
  CampaignNotificationRunnableTemplateDescriptor,
  CampaignNotificationStoredPlan,
  CampaignNotificationStoredPlanRow,
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

export interface CampaignNotificationRunnablePlanCreationInput {
  readonly actorUserId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly runnableId: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly payloadHash: string;
  readonly watermark: string;
  readonly summary: CampaignNotificationRunnablePlanSummary;
  readonly rows: readonly CampaignNotificationStoredPlanRow[];
  readonly expiresAt: string;
}

export interface CampaignNotificationRunnablePlanRepository {
  createPlan(
    input: CampaignNotificationRunnablePlanCreationInput
  ): Promise<Result<CampaignNotificationStoredPlan, CampaignAdminNotificationError>>;

  findPlanById(
    planId: string
  ): Promise<Result<CampaignNotificationStoredPlan | null, CampaignAdminNotificationError>>;

  consumePlan(input: {
    readonly planId: string;
    readonly now: string;
  }): Promise<Result<boolean, CampaignAdminNotificationError>>;

  releasePlan(input: {
    readonly planId: string;
  }): Promise<Result<boolean, CampaignAdminNotificationError>>;
}

export interface CampaignNotificationRunnableTemplateDefinition {
  readonly runnableId: string;
  readonly campaignKey: CampaignNotificationAdminCampaignKey;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly description: string;
  readonly selectorSchema: TSchema;
  readonly filterSchema: TSchema;
  readonly selectors: readonly CampaignNotificationFieldDescriptor[];
  readonly filters: readonly CampaignNotificationFieldDescriptor[];
  readonly targetKind: string;
  readonly dryRunRequired: boolean;
  readonly maxPlanRowCount: number;
  readonly defaultPageSize: number;
  readonly maxPageSize: number;
  dryRun(input: {
    readonly actorUserId: string;
    readonly selectors: unknown;
    readonly filters: unknown;
  }): Promise<
    Result<
      {
        readonly watermark: string;
        readonly summary: CampaignNotificationRunnablePlanSummary;
        readonly rows: readonly CampaignNotificationStoredPlanRow[];
      },
      CampaignAdminNotificationError
    >
  >;
  executeStoredRow(input: {
    readonly actorUserId: string;
    readonly row: CampaignNotificationStoredPlanRow;
  }): Promise<
    Result<
      | { readonly outcome: 'queued' }
      | { readonly outcome: 'already_sent' }
      | { readonly outcome: 'already_pending' }
      | { readonly outcome: 'ineligible' }
      | { readonly outcome: 'missing_data' }
      | { readonly outcome: 'enqueue_failed' },
      CampaignAdminNotificationError
    >
  >;
}

export interface CampaignNotificationRunnableTemplateRegistry {
  list(
    campaignKey: CampaignNotificationAdminCampaignKey
  ): readonly CampaignNotificationRunnableTemplateDescriptor[];
  get(
    campaignKey: CampaignNotificationAdminCampaignKey,
    runnableId: string
  ): CampaignNotificationRunnableTemplateDefinition | null;
}
