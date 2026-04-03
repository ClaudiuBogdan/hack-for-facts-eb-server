import { randomUUID } from 'crypto';

import { err, ok, type Result } from 'neverthrow';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import {
  createEmailSendError,
  createValidationError,
  type InstitutionCorrespondenceError,
} from '../errors.js';
import {
  DEFAULT_NGO_IDENTITY,
  DEFAULT_REQUEST_TYPE,
  EMAIL_REGEX,
  encodeThreadKeyForTag,
  computeContestationDeadline,
  getBudgetYear,
  normalizeOptionalString,
  parseOptionalDate,
  toIsoString,
} from './helpers.js';

import type {
  CorrespondenceEmailSender,
  CorrespondenceTemplateRenderer,
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';
import type {
  CorrespondenceEntry,
  CorrespondenceThreadRecord,
  SendPlatformRequestInput,
  SendPlatformRequestOutput,
} from '../types.js';

export interface SendPlatformRequestDeps {
  repo: InstitutionCorrespondenceRepository;
  emailSender: CorrespondenceEmailSender;
  templateRenderer: CorrespondenceTemplateRenderer;
  auditCcRecipients: string[];
  platformBaseUrl: string;
  captureAddress: string;
  updatePublisher?: PublicDebateEntityUpdatePublisher;
}

const buildThreadKey = (): string => `funky:thread:${randomUUID()}`;

const createThreadRecord = (input: {
  ownerUserId: string | null;
  institutionEmail: string;
  requesterOrganizationName: string | null;
  budgetPublicationDate: Date | null;
  consentCapturedAt: Date | null;
  contestationDeadlineAt: Date | null;
  captureAddress: string;
  subject: string;
}): CorrespondenceThreadRecord => ({
  version: 1,
  campaign: DEFAULT_REQUEST_TYPE,
  campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
  ownerUserId: input.ownerUserId,
  subject: input.subject,
  submissionPath: 'platform_send',
  institutionEmail: input.institutionEmail,
  ngoIdentity: DEFAULT_NGO_IDENTITY,
  requesterOrganizationName: input.requesterOrganizationName,
  budgetPublicationDate: toIsoString(input.budgetPublicationDate),
  consentCapturedAt: toIsoString(input.consentCapturedAt),
  contestationDeadlineAt: toIsoString(input.contestationDeadlineAt),
  captureAddress: input.captureAddress,
  correspondence: [],
  latestReview: null,
  metadata: {},
});

const createOutboundEntry = (input: {
  threadKey: string | null;
  resendEmailId: string;
  fromAddress: string;
  institutionEmail: string;
  auditCcRecipients: string[];
  subject: string;
  html: string;
  text: string;
  sentAt: Date;
}): CorrespondenceEntry => ({
  id: randomUUID(),
  campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
  direction: 'outbound',
  source: 'platform_send',
  resendEmailId: input.resendEmailId,
  messageId: null,
  fromAddress: input.fromAddress,
  toAddresses: [input.institutionEmail],
  ccAddresses: input.auditCcRecipients,
  bccAddresses: [],
  subject: input.subject,
  textBody: input.text,
  htmlBody: input.html,
  headers: {},
  attachments: [],
  occurredAt: input.sentAt.toISOString(),
  metadata: input.threadKey !== null ? { threadKey: input.threadKey } : {},
});

const publishUpdateBestEffort = async (
  publisher: PublicDebateEntityUpdatePublisher | undefined,
  input: Parameters<PublicDebateEntityUpdatePublisher['publish']>[0]
): Promise<void> => {
  if (publisher === undefined) {
    return;
  }

  try {
    const publishResult = await publisher.publish(input);
    if (publishResult.isErr()) {
      return;
    }
  } catch {
    return;
  }
};

export async function sendPlatformRequest(
  deps: SendPlatformRequestDeps,
  input: SendPlatformRequestInput
): Promise<Result<SendPlatformRequestOutput, InstitutionCorrespondenceError>> {
  const entityCui = input.entityCui.trim();
  const institutionEmail = input.institutionEmail.trim();
  const requesterOrganizationName = normalizeOptionalString(input.requesterOrganizationName);
  const publicationDate = parseOptionalDate(input.budgetPublicationDate);
  const consentCapturedAt = parseOptionalDate(input.consentCapturedAt);

  if (entityCui === '') {
    return err(createValidationError('entityCui is required.'));
  }

  if (institutionEmail === '') {
    return err(createValidationError('institutionEmail is required.'));
  }

  if (!EMAIL_REGEX.test(institutionEmail)) {
    return err(createValidationError('institutionEmail must be a valid email address.'));
  }

  const threadKey = buildThreadKey();
  const contestationDeadlineAt = computeContestationDeadline(publicationDate);
  const rendered = deps.templateRenderer.renderPublicDebateRequest({
    institutionEmail,
    requesterOrganizationName,
    ngoIdentity: DEFAULT_NGO_IDENTITY,
    budgetYear: getBudgetYear(publicationDate),
    threadKey,
  });

  const createThreadResult = await deps.repo.createThread({
    entityCui,
    campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
    threadKey,
    phase: 'sending',
    record: createThreadRecord({
      ownerUserId: input.ownerUserId,
      institutionEmail,
      requesterOrganizationName,
      budgetPublicationDate: publicationDate,
      consentCapturedAt,
      contestationDeadlineAt,
      captureAddress: deps.captureAddress,
      subject: rendered.subject,
    }),
  });
  if (createThreadResult.isErr()) {
    return err(createThreadResult.error);
  }

  const thread = createThreadResult.value;
  const sendResult = await deps.emailSender.send({
    to: institutionEmail,
    cc: deps.auditCcRecipients,
    replyTo: [deps.captureAddress],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: thread.id,
    unsubscribeUrl: `${deps.platformBaseUrl}/settings/notifications`,
    tags: [
      { name: 'thread_key', value: encodeThreadKeyForTag(thread.threadKey) },
      { name: 'request_type', value: DEFAULT_REQUEST_TYPE },
    ],
  });

  if (sendResult.isErr()) {
    const failedThreadResult = await deps.repo.updateThread(thread.id, {
      phase: 'failed',
    });
    if (failedThreadResult.isOk()) {
      await publishUpdateBestEffort(deps.updatePublisher, {
        eventType: 'thread_failed',
        thread: failedThreadResult.value,
        occurredAt: new Date(),
      });
    }
    return err(createEmailSendError(sendResult.error.message, sendResult.error.retryable));
  }

  const sentAt = new Date();
  const fromAddress = deps.emailSender.getFromAddress();
  const appendResult = await deps.repo.appendCorrespondenceEntry({
    threadId: thread.id,
    phase: 'awaiting_reply',
    lastEmailAt: sentAt,
    entry: createOutboundEntry({
      threadKey,
      resendEmailId: sendResult.value.emailId,
      fromAddress,
      institutionEmail,
      auditCcRecipients: deps.auditCcRecipients,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      sentAt,
    }),
  });
  if (appendResult.isErr()) {
    return err(appendResult.error);
  }

  await publishUpdateBestEffort(deps.updatePublisher, {
    eventType: 'thread_started',
    thread: appendResult.value,
    occurredAt: sentAt,
  });

  return ok({
    created: true,
    thread: appendResult.value,
  });
}
