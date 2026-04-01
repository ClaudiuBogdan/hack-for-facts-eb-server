import { randomUUID } from 'crypto';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';

import {
  DEFAULT_NGO_IDENTITY,
  DEFAULT_REQUEST_TYPE,
  buildSelfSendInteractionKey,
  extractMessageReferences,
  extractThreadKeyFromSubject,
  normalizeEmailAddress,
} from '../../core/usecases/helpers.js';

import type {
  CorrespondenceReceivedEmailFetcher,
  InstitutionCorrespondenceRepository,
  InstitutionOfficialEmailLookup,
  PublicDebateEntityUpdatePublisher,
  PublicDebateSelfSendApprovalService,
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
  selfSendApprovalService?: PublicDebateSelfSendApprovalService;
  emailEventsRepo: ResendWebhookEmailEventsRepository;
  receivedEmailFetcher: CorrespondenceReceivedEmailFetcher;
  captureAddress: string;
  auditCcRecipients: string[];
  updatePublisher?: PublicDebateEntityUpdatePublisher;
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

const buildDuplicateResolutionMetadata = (matchCount: number): Record<string, unknown> =>
  matchCount > 1
    ? {
        duplicateInteractionCount: matchCount,
        duplicateResolution: 'first_wins',
      }
    : {};

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
  ...(extras.interactionKey !== undefined ? { interactionKey: extras.interactionKey } : {}),
  ...(extras.candidateEntityCuis !== undefined
    ? { candidateEntityCuis: extras.candidateEntityCuis }
    : {}),
  ...(extras.duplicateInteractionCount !== undefined
    ? { duplicateInteractionCount: extras.duplicateInteractionCount }
    : {}),
  ...(extras.duplicateResolution !== undefined
    ? { duplicateResolution: extras.duplicateResolution }
    : {}),
  ...(extras.matchedBy !== undefined ? { matchedBy: extras.matchedBy } : {}),
});

const buildMatchedMetadata = (input: {
  matchReason: string;
  matchedBy: 'headers' | 'subject' | 'interaction_key';
  matchCount?: number;
}): Record<string, unknown> => ({
  matchStatus: 'matched',
  matchReason: input.matchReason,
  matchedBy: input.matchedBy,
  ...(input.matchCount !== undefined ? buildDuplicateResolutionMetadata(input.matchCount) : {}),
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
  campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
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
  interactionKey: string;
  duplicateInteractionCount: number;
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
    interactionKey: input.interactionKey,
    sourceInteractionRecordKey: input.context.recordKey,
    preparedSubject: input.context.preparedSubject,
    expectedNgoSenderEmail,
    capturedFromAddress: input.capturedFromAddress,
    senderEmailVerified,
    ...buildDuplicateResolutionMetadata(input.duplicateInteractionCount),
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
    selfSendApprovalService,
    emailEventsRepo,
    receivedEmailFetcher,
    captureAddress,
    auditCcRecipients,
    updatePublisher,
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

      let matchedBy: 'headers' | 'subject' | 'interaction_key' | null =
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

      const interactionKey = buildSelfSendInteractionKey(receivedEmail.from, receivedEmail.subject);

      const approveSelfSendRecord = async (context: PublicDebateSelfSendContext): Promise<void> => {
        if (selfSendApprovalService === undefined) {
          return;
        }

        const approveResult = await selfSendApprovalService.approvePendingRecord({
          userId: context.userId,
          recordKey: context.recordKey,
        });
        if (approveResult.isErr()) {
          throw new Error(approveResult.error.message);
        }
      };

      if (thread === null) {
        if (!isCapturedViaCc(receivedEmail, captureAddress)) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('capture_address_not_in_cc', receivedEmail, {
              interactionKey,
              ...(extractedThreadKey !== null ? { extractedThreadKey } : {}),
            }),
          });
          return;
        }

        const selfSendContextMatchResult =
          await selfSendContextLookup.findByInteractionKey(interactionKey);
        if (selfSendContextMatchResult.isErr()) {
          throw new Error(selfSendContextMatchResult.error.message);
        }

        const selfSendContextMatch = selfSendContextMatchResult.value;
        if (selfSendContextMatch === null) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('interaction_key_not_found', receivedEmail, {
              interactionKey,
              ...(extractedThreadKey !== null ? { extractedThreadKey } : {}),
            }),
          });
          return;
        }

        const existingSelfSendThreadResult =
          await repo.findSelfSendThreadByInteractionKey(interactionKey);
        if (existingSelfSendThreadResult.isErr()) {
          throw new Error(existingSelfSendThreadResult.error.message);
        }

        if (
          existingSelfSendThreadResult.value !== null &&
          existingSelfSendThreadResult.value.entityCui === selfSendContextMatch.context.entityCui
        ) {
          const outboundEntry = createEntry({
            direction: 'outbound',
            source: 'self_send_cc',
            campaignKey: existingSelfSendThreadResult.value.campaignKey,
            email: receivedEmail,
            metadata: {
              interactionKey,
              rawMessage: mapRawMessage(receivedEmail),
            },
          });

          const appendResult = await repo.appendCorrespondenceEntry({
            threadId: existingSelfSendThreadResult.value.id,
            lastEmailAt: receivedEmail.createdAt,
            entry: outboundEntry,
          });
          if (appendResult.isErr()) {
            throw new Error(appendResult.error.message);
          }

          await approveSelfSendRecord(selfSendContextMatch.context);

          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            threadKey: appendResult.value.threadKey,
            ...(receivedEmail.messageId !== null ? { messageId: receivedEmail.messageId } : {}),
            metadata: buildMatchedMetadata({
              matchReason: 'matched_existing_self_send_thread_by_interaction_key',
              matchedBy: 'interaction_key',
              matchCount: selfSendContextMatch.matchCount,
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
                interactionKey,
                ...(extractedThreadKey !== null ? { extractedThreadKey } : {}),
                matchStatus: uniqueEntityMatches.length === 0 ? 'unmatched' : 'ambiguous',
                candidateEntityCuis: uniqueEntityMatches.map((match) => match.entityCui),
                ...buildDuplicateResolutionMetadata(selfSendContextMatch.matchCount),
              }
            ),
          });
          return;
        }

        const entityMatch = uniqueEntityMatches[0];
        if (entityMatch === undefined) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('official_email_not_found', receivedEmail, {
              interactionKey,
              ...(extractedThreadKey !== null ? { extractedThreadKey } : {}),
            }),
          });
          return;
        }

        if (entityMatch.entityCui !== selfSendContextMatch.context.entityCui) {
          await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
            metadata: buildUnmatchedMetadata('interaction_entity_mismatch', receivedEmail, {
              interactionKey,
              ...(extractedThreadKey !== null ? { extractedThreadKey } : {}),
              candidateEntityCuis: [entityMatch.entityCui],
              ...buildDuplicateResolutionMetadata(selfSendContextMatch.matchCount),
            }),
          });
          return;
        }

        const outboundEntry = createEntry({
          direction: 'outbound',
          source: 'self_send_cc',
          campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
          email: receivedEmail,
          metadata: {
            interactionKey,
            rawMessage: mapRawMessage(receivedEmail),
          },
        });

        const createThreadResult = await repo.createThread({
          entityCui: selfSendContextMatch.context.entityCui,
          campaignKey: PUBLIC_DEBATE_CAMPAIGN_KEY,
          // Subject fallback remains available only when the captured self-send email
          // already carries a stable token; otherwise replies must correlate by headers.
          threadKey: extractedThreadKey ?? randomUUID(),
          phase: 'awaiting_reply',
          lastEmailAt: receivedEmail.createdAt,
          record: createSelfSendThreadRecord({
            ownerUserId: selfSendContextMatch.context.userId,
            institutionEmail: entityMatch.officialEmail,
            requesterOrganizationName: selfSendContextMatch.context.requesterOrganizationName,
            metadata: buildSelfSendThreadMetadata({
              context: selfSendContextMatch.context,
              interactionKey,
              duplicateInteractionCount: selfSendContextMatch.matchCount,
              capturedFromAddress: receivedEmail.from,
            }),
            subject: receivedEmail.subject,
            captureAddress,
            entry: outboundEntry,
          }),
        });
        if (
          createThreadResult.isErr() &&
          createThreadResult.error.type === 'CorrespondenceConflictError'
        ) {
          const reloadedThreadResult =
            await repo.findSelfSendThreadByInteractionKey(interactionKey);
          if (reloadedThreadResult.isErr()) {
            throw new Error(reloadedThreadResult.error.message);
          }

          if (
            reloadedThreadResult.value !== null &&
            reloadedThreadResult.value.entityCui === selfSendContextMatch.context.entityCui
          ) {
            const outboundEntry = createEntry({
              direction: 'outbound',
              source: 'self_send_cc',
              campaignKey: reloadedThreadResult.value.campaignKey,
              email: receivedEmail,
              metadata: {
                interactionKey,
                rawMessage: mapRawMessage(receivedEmail),
              },
            });

            const appendResult = await repo.appendCorrespondenceEntry({
              threadId: reloadedThreadResult.value.id,
              lastEmailAt: receivedEmail.createdAt,
              entry: outboundEntry,
            });
            if (appendResult.isErr()) {
              throw new Error(appendResult.error.message);
            }

            await approveSelfSendRecord(selfSendContextMatch.context);

            await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
              threadKey: appendResult.value.threadKey,
              ...(receivedEmail.messageId !== null ? { messageId: receivedEmail.messageId } : {}),
              metadata: buildMatchedMetadata({
                matchReason: 'matched_existing_self_send_thread_by_interaction_key',
                matchedBy: 'interaction_key',
                matchCount: selfSendContextMatch.matchCount,
              }),
            });

            return;
          }
        }

        if (createThreadResult.isErr()) {
          throw new Error(createThreadResult.error.message);
        }

        await approveSelfSendRecord(selfSendContextMatch.context);

        await updateStoredEvent(emailEventsRepo, input.storedEvent.id, {
          threadKey: createThreadResult.value.threadKey,
          ...(receivedEmail.messageId !== null ? { messageId: receivedEmail.messageId } : {}),
          metadata: buildMatchedMetadata({
            matchReason: 'created_from_interaction_key_and_official_email',
            matchedBy: 'interaction_key',
            matchCount: selfSendContextMatch.matchCount,
          }),
        });

        await updatePublisher?.publish({
          eventType: 'thread_started',
          thread: createThreadResult.value,
          occurredAt: receivedEmail.createdAt,
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
        metadata: buildMatchedMetadata({
          matchReason: matchedBy === 'headers' ? 'matched_by_headers' : 'matched_by_subject',
          matchedBy: matchedBy ?? 'subject',
        }),
      });

      await updatePublisher?.publish({
        eventType: 'reply_received',
        thread: appendResult.value,
        occurredAt: receivedEmail.createdAt,
        reply: inboundEntry,
      });

      log.debug(
        { svixId: input.storedEvent.svixId, threadKey: appendResult.value.threadKey },
        'Institution correspondence inbound email matched to thread'
      );
    },
  };
};
