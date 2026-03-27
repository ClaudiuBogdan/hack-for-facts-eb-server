import { randomUUID } from 'crypto';

import {
  DEFAULT_NGO_IDENTITY,
  DEFAULT_REQUEST_TYPE,
  extractMessageReferences,
  extractThreadKeyFromSubject,
  normalizeEmailAddress,
} from '../../core/usecases/helpers.js';

import type {
  CorrespondenceReceivedEmailFetcher,
  InstitutionCorrespondenceRepository,
  InstitutionOfficialEmailLookup,
  PublicDebateSelfSendContext,
  PublicDebateSelfSendContextLookup,
} from '../../core/ports.js';
import type {
  CorrespondenceEntry,
  CorrespondenceThreadRecord,
  ReceivedEmailSnapshot,
  UnmatchedInboundMetadata,
} from '../../core/types.js';
import type {
  ResendWebhookEmailEventsRepository,
  ResendWebhookSideEffect,
  ResendWebhookSideEffectInput,
} from '@/modules/resend-webhooks/index.js';
import type { Logger } from 'pino';

export interface InstitutionCorrespondenceResendSideEffectDeps {
  repo: InstitutionCorrespondenceRepository;
  officialEmailLookup: InstitutionOfficialEmailLookup;
  selfSendContextLookup: PublicDebateSelfSendContextLookup;
  emailEventsRepo: ResendWebhookEmailEventsRepository;
  receivedEmailFetcher: CorrespondenceReceivedEmailFetcher;
  captureAddress: string;
  auditCcRecipients: string[];
  logger: Logger;
}

const mapRawMessage = (email: ReceivedEmailSnapshot): Record<string, unknown> => ({
  emailId: email.emailId,
  from: email.from,
  to: email.to,
  cc: email.cc,
  bcc: email.bcc,
  replyTo: email.replyTo,
  subject: email.subject,
  html: email.html,
  text: email.text,
  headers: email.headers,
  messageId: email.messageId,
  attachments: email.attachments,
  createdAt: email.createdAt.toISOString(),
});

const createEntry = (input: {
  direction: CorrespondenceEntry['direction'];
  source: CorrespondenceEntry['source'];
  campaignKey: string | null;
  email: ReceivedEmailSnapshot;
  metadata: Record<string, unknown>;
}): CorrespondenceEntry => ({
  id: randomUUID(),
  campaignKey: input.campaignKey,
  direction: input.direction,
  source: input.source,
  resendEmailId: input.email.emailId,
  messageId: input.email.messageId,
  fromAddress: input.email.from,
  toAddresses: input.email.to,
  ccAddresses: input.email.cc,
  bccAddresses: input.email.bcc,
  subject: input.email.subject,
  textBody: input.email.text,
  htmlBody: input.email.html,
  headers: input.email.headers,
  attachments: input.email.attachments,
  occurredAt: input.email.createdAt.toISOString(),
  metadata: input.metadata,
});

const extractInstitutionCandidateEmails = (
  email: ReceivedEmailSnapshot,
  ownedAddresses: Set<string>
): string[] => {
  const addresses = [...email.to, ...email.cc, ...email.bcc]
    .map(normalizeEmailAddress)
    .filter((address) => !ownedAddresses.has(address));

  return [...new Set(addresses)];
};

const buildUnmatchedMetadata = (
  reason: string,
  email: ReceivedEmailSnapshot,
  extras: Partial<UnmatchedInboundMetadata> = {}
): Record<string, unknown> => ({
  matchStatus: extras.matchStatus ?? 'unmatched',
  matchReason: reason,
  rawMessage: mapRawMessage(email),
  ...(extras.extractedThreadKey !== undefined
    ? { extractedThreadKey: extras.extractedThreadKey }
    : {}),
  ...(extras.candidateEntityCuis !== undefined
    ? { candidateEntityCuis: extras.candidateEntityCuis }
    : {}),
  ...(extras.matchedBy !== undefined ? { matchedBy: extras.matchedBy } : {}),
});

const updateStoredEvent = async (
  repo: ResendWebhookEmailEventsRepository,
  storedEventId: string,
  input: {
    threadKey?: string | null;
    messageId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> => {
  const updateResult = await repo.updateStoredEvent(storedEventId, input);
  if (updateResult.isErr()) {
    throw new Error(
      updateResult.error.type === 'DatabaseError'
        ? updateResult.error.message
        : 'Failed to update stored resend webhook event'
    );
  }
};

const createSelfSendThreadRecord = (input: {
  ownerUserId: string | null;
  institutionEmail: string;
  requesterOrganizationName: string | null;
  metadata: Record<string, unknown>;
  subject: string;
  captureAddress: string;
  entry: CorrespondenceEntry;
}): CorrespondenceThreadRecord => ({
  version: 1,
  campaign: DEFAULT_REQUEST_TYPE,
  campaignKey: null,
  ownerUserId: input.ownerUserId,
  subject: input.subject,
  submissionPath: 'self_send_cc',
  institutionEmail: input.institutionEmail,
  ngoIdentity: DEFAULT_NGO_IDENTITY,
  requesterOrganizationName: input.requesterOrganizationName,
  budgetPublicationDate: null,
  consentCapturedAt: null,
  contestationDeadlineAt: null,
  captureAddress: input.captureAddress,
  correspondence: [input.entry],
  latestReview: null,
  metadata: input.metadata,
});

const isCapturedViaCc = (email: ReceivedEmailSnapshot, captureAddress: string): boolean => {
  const normalizedCaptureAddress = normalizeEmailAddress(captureAddress);
  return email.cc.some((address) => normalizeEmailAddress(address) === normalizedCaptureAddress);
};

const buildSelfSendThreadMetadata = (input: {
  context: PublicDebateSelfSendContext;
  capturedFromAddress: string;
}): Record<string, unknown> => {
  const expectedNgoSenderEmail =
    input.context.ngoSenderEmail !== null
      ? normalizeEmailAddress(input.context.ngoSenderEmail)
      : null;
  const normalizedCapturedFromAddress = normalizeEmailAddress(input.capturedFromAddress);
  const senderEmailVerified =
    expectedNgoSenderEmail !== null && expectedNgoSenderEmail === normalizedCapturedFromAddress;

  return {
    sourceInteractionRecordKey: input.context.recordKey,
    expectedNgoSenderEmail,
    capturedFromAddress: input.capturedFromAddress,
    senderEmailVerified,
    ...(expectedNgoSenderEmail !== null && !senderEmailVerified
      ? {
          senderEmailMismatch: true,
          senderEmailMismatchReason: 'from_address_mismatch',
        }
      : {}),
  };
};

export const makeInstitutionCorrespondenceResendSideEffect = (
  deps: InstitutionCorrespondenceResendSideEffectDeps
): ResendWebhookSideEffect => {
  const {
    repo,
    officialEmailLookup,
    selfSendContextLookup,
    emailEventsRepo,
    receivedEmailFetcher,
    captureAddress,
    auditCcRecipients,
    logger,
  } = deps;
  const log = logger.child({ component: 'InstitutionCorrespondenceResendSideEffect' });
  const ownedAddresses = new Set(
    [captureAddress, ...auditCcRecipients].map((address) => normalizeEmailAddress(address))
  );

  return {
    async handle(input: ResendWebhookSideEffectInput): Promise<void> {
      if (
        input.event.type === 'email.sent' &&
        input.storedEvent.threadKey !== null &&
        input.event.data.message_id !== undefined
      ) {
        const attachResult = await repo.attachMessageIdToCorrespondenceByResendEmail(
          input.storedEvent.threadKey,
          input.event.data.email_id,
          input.event.data.message_id
        );
        if (attachResult.isErr()) {
          throw new Error(attachResult.error.message);
        }
        return;
      }

      if (input.event.type !== 'email.received') {
        return;
      }

      const existingStatus = input.storedEvent.metadata['matchStatus'];
      if (input.storedEvent.threadKey !== null || typeof existingStatus === 'string') {
        return;
      }

      const receivedEmailResult = await receivedEmailFetcher.getReceivedEmail(
        input.event.data.email_id
      );
      if (receivedEmailResult.isErr()) {
        throw new Error(receivedEmailResult.error.message);
      }

      const receivedEmail: ReceivedEmailSnapshot = {
        emailId: receivedEmailResult.value.id,
        from: receivedEmailResult.value.from,
        to: receivedEmailResult.value.to,
        cc: receivedEmailResult.value.cc,
        bcc: receivedEmailResult.value.bcc,
        replyTo: receivedEmailResult.value.replyTo,
        subject: receivedEmailResult.value.subject,
        html: receivedEmailResult.value.html,
        text: receivedEmailResult.value.text,
        headers: receivedEmailResult.value.headers,
        messageId: receivedEmailResult.value.messageId,
        attachments: receivedEmailResult.value.attachments,
        createdAt: receivedEmailResult.value.createdAt,
      };

      const messageReferences = extractMessageReferences(receivedEmail.headers);
      const referencedThreadKeyResult =
        await emailEventsRepo.findThreadKeyByMessageReferences(messageReferences);
      if (referencedThreadKeyResult.isErr()) {
        throw new Error(
          referencedThreadKeyResult.error.type === 'DatabaseError'
            ? referencedThreadKeyResult.error.message
            : 'Failed to resolve thread key by message references'
        );
      }

      let thread = null;
      if (referencedThreadKeyResult.value !== null) {
        const threadResult = await repo.findThreadByKey(referencedThreadKeyResult.value);
        if (threadResult.isErr()) {
          throw new Error(threadResult.error.message);
        }
        thread = threadResult.value;
      }
      let matchedBy: 'headers' | 'subject' | 'subject_official_email' | null =
        thread !== null ? 'headers' : null;

      const extractedThreadKey = extractThreadKeyFromSubject(receivedEmail.subject);
      if (thread === null && extractedThreadKey !== null) {
        const threadByKeyResult = await repo.findThreadByKey(extractedThreadKey);
        if (threadByKeyResult.isErr()) {
          throw new Error(threadByKeyResult.error.message);
        }

        thread = threadByKeyResult.value;
        matchedBy = thread !== null ? 'subject' : null;
      }

      if (thread === null) {
        if (extractedThreadKey === null) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('thread_key_missing', receivedEmail),
          });
          return;
        }

        if (!isCapturedViaCc(receivedEmail, captureAddress)) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('capture_address_not_in_cc', receivedEmail, {
              extractedThreadKey,
            }),
          });
          return;
        }

        const selfSendContextResult =
          await selfSendContextLookup.findByThreadKey(extractedThreadKey);
        if (selfSendContextResult.isErr()) {
          throw new Error(selfSendContextResult.error.message);
        }

        const selfSendContext = selfSendContextResult.value;
        if (selfSendContext === null) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('interaction_context_not_found', receivedEmail, {
              extractedThreadKey,
            }),
          });
          return;
        }

        const candidateEmails = extractInstitutionCandidateEmails(receivedEmail, ownedAddresses);
        const entityMatchesResult =
          await officialEmailLookup.findEntitiesByOfficialEmails(candidateEmails);
        if (entityMatchesResult.isErr()) {
          throw new Error(entityMatchesResult.error.message);
        }

        const uniqueEntityMatches = entityMatchesResult.value.filter(
          (match, index, all) =>
            all.findIndex((candidate) => candidate.entityCui === match.entityCui) === index
        );

        if (uniqueEntityMatches.length !== 1) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata(
              uniqueEntityMatches.length === 0
                ? 'official_email_not_found'
                : 'official_email_ambiguous',
              receivedEmail,
              {
                matchStatus: uniqueEntityMatches.length === 0 ? 'unmatched' : 'ambiguous',
                extractedThreadKey,
                candidateEntityCuis: uniqueEntityMatches.map((match) => match.entityCui),
              }
            ),
          });
          return;
        }

        const entityMatch = uniqueEntityMatches[0];
        if (entityMatch === undefined) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('official_email_not_found', receivedEmail, {
              extractedThreadKey,
            }),
          });
          return;
        }

        if (entityMatch.entityCui !== selfSendContext.entityCui) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('interaction_entity_mismatch', receivedEmail, {
              extractedThreadKey,
              candidateEntityCuis: [entityMatch.entityCui],
            }),
          });
          return;
        }

        const outboundEntry = createEntry({
          direction: 'outbound',
          source: 'self_send_cc',
          campaignKey: null,
          email: receivedEmail,
          metadata: {
            rawMessage: mapRawMessage(receivedEmail),
          },
        });

        const createThreadResult = await repo.createThread({
          entityCui: selfSendContext.entityCui,
          campaignKey: null,
          threadKey: extractedThreadKey,
          phase: 'awaiting_reply',
          lastEmailAt: receivedEmail.createdAt,
          record: createSelfSendThreadRecord({
            ownerUserId: selfSendContext.userId,
            institutionEmail: entityMatch.officialEmail,
            requesterOrganizationName: selfSendContext.requesterOrganizationName,
            metadata: buildSelfSendThreadMetadata({
              context: selfSendContext,
              capturedFromAddress: receivedEmail.from,
            }),
            subject: receivedEmail.subject,
            captureAddress,
            entry: outboundEntry,
          }),
        });
        if (createThreadResult.isErr()) {
          throw new Error(createThreadResult.error.message);
        }

        await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
          threadKey: extractedThreadKey,
          ...(receivedEmail.messageId !== null ? { messageId: receivedEmail.messageId } : {}),
          metadata: {
            matchStatus: 'matched',
            matchReason: 'created_from_subject_official_email_and_interaction',
            matchedBy: 'subject_official_email',
          },
        });

        return;
      }

      const inboundEntry = createEntry({
        direction: 'inbound',
        source: 'institution_reply',
        campaignKey: thread.campaignKey,
        email: receivedEmail,
        metadata: {
          rawMessage: mapRawMessage(receivedEmail),
        },
      });

      const appendResult = await repo.appendCorrespondenceEntry({
        threadId: thread.id,
        phase: 'reply_received_unreviewed',
        lastReplyAt: receivedEmail.createdAt,
        nextActionAt: receivedEmail.createdAt,
        entry: inboundEntry,
      });
      if (appendResult.isErr()) {
        throw new Error(appendResult.error.message);
      }

      await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
        threadKey: appendResult.value.threadKey,
        metadata: {
          matchStatus: 'matched',
          matchReason: matchedBy === 'headers' ? 'matched_by_headers' : 'matched_by_subject',
          matchedBy: matchedBy ?? 'subject',
        },
      });

      log.debug(
        { svixId: input.storedEvent.svixId, threadKey: appendResult.value.threadKey },
        'Institution correspondence inbound email matched to thread'
      );
    },
  };
};
