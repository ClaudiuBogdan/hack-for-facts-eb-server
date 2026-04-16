import type { InstitutionCorrespondenceError } from './errors.js';
import type {
  CampaignAdminThreadLookupInput,
  CampaignAdminThreadPage,
  CorrespondenceEntry,
  CorrespondenceThreadRecord,
  ListCampaignAdminThreadsInput,
  ListPendingRepliesInput,
  PendingReplyPage,
  ResolutionCode,
  ThreadPhase,
  ThreadRecord,
} from './types.js';
import type { EmailSender, ReceivedEmailFetcher } from '@/infra/email/client.js';
import type { Result } from 'neverthrow';

export interface CreateThreadInput {
  entityCui: string;
  campaignKey: string | null;
  threadKey: string;
  phase: ThreadPhase;
  lastEmailAt?: Date | null;
  lastReplyAt?: Date | null;
  nextActionAt?: Date | null;
  closedAt?: Date | null;
  record: CorrespondenceThreadRecord;
}

export interface UpdateThreadInput {
  phase?: ThreadPhase;
  lastEmailAt?: Date | null;
  lastReplyAt?: Date | null;
  nextActionAt?: Date | null;
  closedAt?: Date | null;
  record?: CorrespondenceThreadRecord;
}

export interface AppendCorrespondenceEntryInput {
  threadId: string;
  entry: CorrespondenceEntry;
  phase?: ThreadPhase;
  lastEmailAt?: Date | null;
  lastReplyAt?: Date | null;
  nextActionAt?: Date | null;
  closedAt?: Date | null;
}

export interface LockedThreadMutation {
  phase?: ThreadPhase;
  lastEmailAt?: Date | null;
  lastReplyAt?: Date | null;
  nextActionAt?: Date | null;
  closedAt?: Date | null;
  record: CorrespondenceThreadRecord;
}

export interface InstitutionCorrespondenceRepository {
  createThread(
    input: CreateThreadInput
  ): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>>;
  findThreadById(id: string): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  findThreadByKey(
    threadKey: string
  ): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  findSelfSendThreadByInteractionKey(
    interactionKey: string
  ): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  findPlatformSendThreadByEntity(input: {
    entityCui: string;
    campaign: string;
  }): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  findLatestPlatformSendThreadByEntity(input: {
    entityCui: string;
    campaign: string;
  }): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  findCampaignAdminThreadById(
    input: CampaignAdminThreadLookupInput
  ): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  listCampaignAdminThreads(
    input: ListCampaignAdminThreadsInput
  ): Promise<Result<CampaignAdminThreadPage, InstitutionCorrespondenceError>>;
  listPlatformSendThreadsPendingSuccessConfirmation(
    olderThanMinutes: number
  ): Promise<Result<ThreadRecord[], InstitutionCorrespondenceError>>;
  updateThread(
    threadId: string,
    input: UpdateThreadInput
  ): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>>;
  appendCorrespondenceEntry(
    input: AppendCorrespondenceEntryInput
  ): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>>;
  mutateThread(
    threadId: string,
    mutator: (thread: ThreadRecord) => Result<LockedThreadMutation, InstitutionCorrespondenceError>
  ): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>>;
  mutateCampaignAdminThread(
    input: {
      threadId: string;
      campaignKey: string;
      expectedUpdatedAt: Date;
    },
    mutator: (thread: ThreadRecord) => Result<LockedThreadMutation, InstitutionCorrespondenceError>
  ): Promise<Result<ThreadRecord, InstitutionCorrespondenceError>>;
  attachMessageIdToCorrespondenceByResendEmail(
    threadKey: string,
    resendEmailId: string,
    messageId: string
  ): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
  listPendingReplies(
    input: ListPendingRepliesInput
  ): Promise<Result<PendingReplyPage, InstitutionCorrespondenceError>>;
}

export interface InstitutionOfficialEmailLookup {
  findEntitiesByOfficialEmails(
    emails: string[]
  ): Promise<
    Result<{ entityCui: string; officialEmail: string }[], InstitutionCorrespondenceError>
  >;
}

export interface MessageReferenceThreadLookup {
  findThreadKeyByMessageReferences(
    messageReferences: string[]
  ): Promise<Result<string | null, InstitutionCorrespondenceError>>;
}

export interface PublicDebateSelfSendContext {
  userId: string;
  recordKey: string;
  entityCui: string;
  institutionEmail: string;
  requesterOrganizationName: string | null;
  ngoSenderEmail: string | null;
  preparedSubject: string;
  submittedAt: string | null;
}

export interface PublicDebateSelfSendContextMatch {
  context: PublicDebateSelfSendContext;
  interactionKey: string;
  matchCount: number;
}

export interface PublicDebateSelfSendContextLookup {
  findByInteractionKey(
    interactionKey: string
  ): Promise<Result<PublicDebateSelfSendContextMatch | null, InstitutionCorrespondenceError>>;
}

export interface PublicDebateEntitySubscriptionService {
  ensureSubscribed(
    userId: string,
    entityCui: string
  ): Promise<Result<void, InstitutionCorrespondenceError>>;
}

interface PublicDebateEntityUpdateNotificationBase {
  thread: ThreadRecord;
  occurredAt: Date;
  failureMessage?: string | null;
  reply?: CorrespondenceEntry;
  basedOnEntryId?: string;
  resolutionCode?: ResolutionCode;
  reviewNotes?: string | null;
}

export type PublicDebateEntityUpdateNotification =
  | (PublicDebateEntityUpdateNotificationBase & {
      eventType: 'thread_started';
      requesterUserId: string | null;
    })
  | (PublicDebateEntityUpdateNotificationBase & {
      eventType: 'thread_failed' | 'reply_received' | 'reply_reviewed';
    });

export type PublicDebateEntityUpdatePublishStatus = 'queued' | 'partial' | 'none' | 'failed';

export interface PublicDebateEntityUpdatePublishResult {
  status: PublicDebateEntityUpdatePublishStatus;
  notificationIds: string[];
  createdOutboxIds: string[];
  reusedOutboxIds: string[];
  queuedOutboxIds: string[];
  enqueueFailedOutboxIds: string[];
}

export interface PublicDebateEntityUpdatePublisher {
  publish(
    input: PublicDebateEntityUpdateNotification
  ): Promise<Result<PublicDebateEntityUpdatePublishResult, InstitutionCorrespondenceError>>;
}

export interface PublicDebateSelfSendApprovalService {
  approvePendingRecord(
    input: Pick<PublicDebateSelfSendContext, 'userId' | 'recordKey'>
  ): Promise<Result<void, InstitutionCorrespondenceError>>;
}

export interface CorrespondenceTemplateRenderer {
  renderPublicDebateRequest(input: {
    institutionEmail: string;
    requesterOrganizationName: string | null;
    ngoIdentity: string;
    budgetYear: number;
    entityName?: string | null;
    threadKey: string;
  }): {
    subject: string;
    text: string;
    html: string;
  };
}

export type CorrespondenceEmailSender = EmailSender;
export type CorrespondenceReceivedEmailFetcher = ReceivedEmailFetcher;
