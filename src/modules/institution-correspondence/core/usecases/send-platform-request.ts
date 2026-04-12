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
  embedThreadKeyInSubject,
  computeContestationDeadline,
  getBudgetYear,
  normalizeOptionalString,
  parseOptionalDate,
  sanitizeResendTagValue,
  toIsoString,
} from './helpers.js';
import { withPlatformSendAttemptMetadata } from './platform-send-success-confirmation.js';
import { publishPublicDebateUpdateBestEffort } from './publish-public-debate-update-best-effort.js';
import { reconcilePlatformSendSuccess } from './reconcile-platform-send-success.js';

import type {
  CorrespondenceEmailSender,
  CorrespondenceTemplateRenderer,
  InstitutionCorrespondenceRepository,
  PublicDebateEntityUpdatePublisher,
} from '../ports.js';
import type {
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
  providerSendAttemptId: string;
  metadata?: Readonly<Record<string, unknown>> | null;
}): CorrespondenceThreadRecord => {
  const baseRecord: CorrespondenceThreadRecord = {
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
    metadata: input.metadata ?? {},
  };

  return {
    ...baseRecord,
    metadata: withPlatformSendAttemptMetadata(baseRecord, input.providerSendAttemptId),
  };
};

export async function sendPlatformRequest(
  deps: SendPlatformRequestDeps,
  input: SendPlatformRequestInput
): Promise<Result<SendPlatformRequestOutput, InstitutionCorrespondenceError>> {
  const entityCui = input.entityCui.trim();
  const institutionEmail = input.institutionEmail.trim();
  const entityName = normalizeOptionalString(input.entityName);
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
  const providerSendAttemptId = randomUUID();
  const contestationDeadlineAt = computeContestationDeadline(publicationDate);
  const rendered = deps.templateRenderer.renderPublicDebateRequest({
    institutionEmail,
    ...(entityName !== null ? { entityName } : {}),
    requesterOrganizationName,
    ngoIdentity: DEFAULT_NGO_IDENTITY,
    budgetYear: getBudgetYear(publicationDate),
    threadKey,
  });
  const outboundSubject = embedThreadKeyInSubject(rendered.subject, threadKey);

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
      providerSendAttemptId,
      metadata: input.metadata ?? null,
    }),
  });
  if (createThreadResult.isErr()) {
    return err(createThreadResult.error);
  }

  const thread = createThreadResult.value;
  const fromAddress = deps.emailSender.getFromAddress();
  const sendResult = await deps.emailSender.send({
    to: institutionEmail,
    cc: deps.auditCcRecipients,
    replyTo: [deps.captureAddress],
    subject: outboundSubject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: providerSendAttemptId,
    unsubscribeUrl: `${deps.platformBaseUrl}/settings/notifications`,
    tags: [
      {
        name: 'thread_key',
        value: sanitizeResendTagValue(encodeThreadKeyForTag(thread.threadKey)),
      },
      { name: 'request_type', value: sanitizeResendTagValue(DEFAULT_REQUEST_TYPE) },
    ],
  });

  if (sendResult.isErr()) {
    const failedThreadResult = await deps.repo.updateThread(thread.id, {
      phase: 'failed',
    });
    if (failedThreadResult.isOk()) {
      await publishPublicDebateUpdateBestEffort(deps.updatePublisher, {
        eventType: 'thread_failed',
        thread: failedThreadResult.value,
        occurredAt: new Date(),
        failureMessage: sendResult.error.message,
      });
    }
    return err(createEmailSendError(sendResult.error.message, sendResult.error.retryable));
  }

  const sentAt = new Date();
  const reconcileResult = await reconcilePlatformSendSuccess(
    {
      repo: deps.repo,
      ...(deps.updatePublisher !== undefined ? { updatePublisher: deps.updatePublisher } : {}),
    },
    {
      threadKey,
      resendEmailId: sendResult.value.emailId,
      observedAt: sentAt,
      fromAddress,
      toAddresses: [institutionEmail],
      ccAddresses: deps.auditCcRecipients,
      bccAddresses: [],
      subject: outboundSubject,
      textBody: rendered.text,
      htmlBody: rendered.html,
      headers: {},
      attachments: [],
    }
  );
  if (reconcileResult.isErr()) {
    return err(reconcileResult.error);
  }

  const reconciledThread = reconcileResult.value.thread;
  if (reconciledThread === null) {
    return err(createValidationError('thread reconciliation returned no thread.'));
  }

  return ok({
    created: true,
    thread: reconciledThread,
  });
}
