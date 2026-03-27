import { randomUUID } from 'crypto';

import { err, ok, type Result } from 'neverthrow';

import {
  createEmailSendError,
  createValidationError,
  type InstitutionCorrespondenceError,
} from '../errors.js';
import {
  DEFAULT_NGO_IDENTITY,
  DEFAULT_REQUEST_TYPE,
  EMAIL_REGEX,
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
}

const buildThreadKey = (): string => randomUUID();

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
  campaignKey: null,
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
  campaignKey: null,
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
    campaignKey: null,
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
    unsubscribeUrl: `${deps.platformBaseUrl}/notifications/preferences`,
    tags: [
      { name: 'thread_key', value: thread.threadKey },
      { name: 'request_type', value: DEFAULT_REQUEST_TYPE },
    ],
  });

  if (sendResult.isErr()) {
    await deps.repo.updateThread(thread.id, {
      phase: 'failed',
    });
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

  return ok({
    created: true,
    thread: appendResult.value,
  });
}
