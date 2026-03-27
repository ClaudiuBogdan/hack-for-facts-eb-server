import type { InstitutionCorrespondenceError } from './errors.js';
import type {
  CorrespondenceEntry,
  CorrespondenceThreadRecord,
  ListPendingRepliesInput,
  PendingReplyPage,
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
  findPlatformSendThreadByEntity(input: {
    entityCui: string;
    campaign: string;
  }): Promise<Result<ThreadRecord | null, InstitutionCorrespondenceError>>;
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
  threadKey: string;
  submittedAt: string | null;
}

export interface PublicDebateSelfSendContextLookup {
  findByThreadKey(
    threadKey: string
  ): Promise<Result<PublicDebateSelfSendContext | null, InstitutionCorrespondenceError>>;
}

export interface CorrespondenceTemplateRenderer {
  renderPublicDebateRequest(input: {
    institutionEmail: string;
    requesterOrganizationName: string | null;
    ngoIdentity: string;
    budgetYear: number;
    threadKey: string;
  }): {
    subject: string;
    text: string;
    html: string;
  };
}

export type CorrespondenceEmailSender = EmailSender;
export type CorrespondenceReceivedEmailFetcher = ReceivedEmailFetcher;
