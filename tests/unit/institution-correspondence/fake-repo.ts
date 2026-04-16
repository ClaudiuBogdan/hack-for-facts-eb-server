import { ok, err, type Result } from 'neverthrow';

import {
  isCampaignAdminThreadInScope,
  projectCampaignAdminThread,
  type CampaignAdminThreadPage,
  type CampaignAdminResponseStatus,
  type AdminResponseEvent,
  createConflictError,
  createNotFoundError,
  hasPlatformSendSuccessConfirmation,
  withPlatformSendSuccessMetadata,
  type CorrespondenceEntry,
  type CorrespondenceThreadRecord,
  type CreateThreadInput,
  type InstitutionCorrespondenceRepository,
  type ListCampaignAdminThreadsInput,
  type LockedThreadMutation,
  type PendingReplyPage,
  type ReconcilePlatformSendSuccessInput,
  type ThreadRecord,
  type UpdateThreadInput,
} from '@/modules/institution-correspondence/index.js';

const now = (): Date => new Date('2026-03-25T12:00:00.000Z');

let nextThreadId = 1;
let nextEntryId = 1;

const normalizeStringHeaders = (headers: Record<string, unknown>): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
};

export const createCorrespondenceEntry = (
  overrides: Partial<CorrespondenceEntry> = {}
): CorrespondenceEntry => ({
  id: overrides.id ?? `entry-${String(nextEntryId++)}`,
  campaignKey: overrides.campaignKey ?? null,
  direction: overrides.direction ?? 'inbound',
  source: overrides.source ?? 'institution_reply',
  resendEmailId: overrides.resendEmailId ?? 'email-1',
  messageId: overrides.messageId ?? '<message-1>',
  fromAddress: overrides.fromAddress ?? 'reply@institutie.ro',
  toAddresses: overrides.toAddresses ?? ['debate@transparenta.test'],
  ccAddresses: overrides.ccAddresses ?? [],
  bccAddresses: overrides.bccAddresses ?? [],
  subject: overrides.subject ?? 'Subject [teu:thread-key-1]',
  textBody: overrides.textBody ?? 'Body',
  htmlBody: overrides.htmlBody ?? '<p>Body</p>',
  headers: overrides.headers ?? {},
  attachments: overrides.attachments ?? [],
  occurredAt: overrides.occurredAt ?? now().toISOString(),
  metadata: overrides.metadata ?? {},
});

export const createThreadAggregateRecord = (
  overrides: Partial<CorrespondenceThreadRecord> = {}
): CorrespondenceThreadRecord => ({
  version: 1,
  campaign: overrides.campaign ?? 'funky',
  campaignKey: overrides.campaignKey ?? null,
  ownerUserId: overrides.ownerUserId ?? 'user-1',
  subject: overrides.subject ?? 'Subject [teu:thread-key-1]',
  submissionPath: overrides.submissionPath ?? 'platform_send',
  institutionEmail: overrides.institutionEmail ?? 'contact@institutie.ro',
  ngoIdentity: overrides.ngoIdentity ?? 'funky_citizens',
  requesterOrganizationName: overrides.requesterOrganizationName ?? null,
  budgetPublicationDate: overrides.budgetPublicationDate ?? null,
  consentCapturedAt: overrides.consentCapturedAt ?? null,
  contestationDeadlineAt: overrides.contestationDeadlineAt ?? null,
  captureAddress: overrides.captureAddress ?? 'debate@transparenta.test',
  correspondence: overrides.correspondence ?? [],
  latestReview: overrides.latestReview ?? null,
  ...(overrides.adminWorkflow !== undefined ? { adminWorkflow: overrides.adminWorkflow } : {}),
  metadata: overrides.metadata ?? {},
});

export const createAdminResponseEvent = (
  overrides: Partial<AdminResponseEvent> & {
    responseStatus?: CampaignAdminResponseStatus;
  } = {}
): AdminResponseEvent => ({
  id: overrides.id ?? `response-${String(nextEntryId++)}`,
  responseDate: overrides.responseDate ?? now().toISOString(),
  messageContent: overrides.messageContent ?? 'Manual response',
  responseStatus: overrides.responseStatus ?? 'registration_number_received',
  actorUserId: overrides.actorUserId ?? 'admin-user-1',
  createdAt: overrides.createdAt ?? now().toISOString(),
  source: 'campaign_admin_api',
});

export const createThreadRecord = (overrides: Partial<ThreadRecord> = {}): ThreadRecord => {
  const id = overrides.id ?? `thread-${String(nextThreadId++)}`;
  return {
    id,
    entityCui: overrides.entityCui ?? '12345678',
    campaignKey: overrides.campaignKey ?? null,
    threadKey: overrides.threadKey ?? `thread-key-${id}`,
    phase: overrides.phase ?? 'awaiting_reply',
    lastEmailAt: overrides.lastEmailAt ?? null,
    lastReplyAt: overrides.lastReplyAt ?? null,
    nextActionAt: overrides.nextActionAt ?? null,
    closedAt: overrides.closedAt ?? null,
    record:
      overrides.record ??
      createThreadAggregateRecord({
        ...(overrides.campaignKey !== undefined ? { campaignKey: overrides.campaignKey } : {}),
      }),
    createdAt: overrides.createdAt ?? now(),
    updatedAt: overrides.updatedAt ?? now(),
  };
};

export const createPlatformSendSuccessInput = (
  overrides: Partial<ReconcilePlatformSendSuccessInput> = {}
): ReconcilePlatformSendSuccessInput => ({
  threadKey: overrides.threadKey ?? 'thread-key-1',
  resendEmailId: overrides.resendEmailId ?? 'email-1',
  messageId: overrides.messageId ?? '<message-1>',
  observedAt: overrides.observedAt ?? new Date('2026-04-03T16:43:04.930Z'),
  fromAddress: overrides.fromAddress ?? 'funky@dev.transparenta.eu',
  toAddresses: overrides.toAddresses ?? ['contact@primarie.ro'],
  ccAddresses: overrides.ccAddresses ?? ['audit@transparenta.test'],
  bccAddresses: overrides.bccAddresses ?? [],
  subject: overrides.subject ?? 'Cerere dezbatere buget local - Comuna Test',
  textBody: overrides.textBody ?? 'Domnule Primar,',
  htmlBody: overrides.htmlBody ?? '<p>Domnule Primar,</p>',
  headers: overrides.headers ?? {},
  attachments: overrides.attachments ?? [],
});

export const createPlatformSendOutboundEntry = (
  overrides: Partial<CorrespondenceEntry> = {}
): CorrespondenceEntry => {
  const input = createPlatformSendSuccessInput({
    ...(typeof overrides.resendEmailId === 'string'
      ? { resendEmailId: overrides.resendEmailId }
      : {}),
    ...(overrides.messageId !== undefined ? { messageId: overrides.messageId } : {}),
    ...(overrides.fromAddress !== undefined ? { fromAddress: overrides.fromAddress } : {}),
    ...(overrides.toAddresses !== undefined ? { toAddresses: overrides.toAddresses } : {}),
    ...(overrides.ccAddresses !== undefined ? { ccAddresses: overrides.ccAddresses } : {}),
    ...(overrides.bccAddresses !== undefined ? { bccAddresses: overrides.bccAddresses } : {}),
    ...(overrides.subject !== undefined ? { subject: overrides.subject } : {}),
    ...(overrides.textBody !== undefined ? { textBody: overrides.textBody } : {}),
    ...(overrides.htmlBody !== undefined ? { htmlBody: overrides.htmlBody } : {}),
    ...(overrides.headers !== undefined
      ? { headers: normalizeStringHeaders(overrides.headers) }
      : {}),
    ...(overrides.attachments !== undefined ? { attachments: overrides.attachments } : {}),
    ...(overrides.occurredAt !== undefined ? { observedAt: new Date(overrides.occurredAt) } : {}),
  });

  return createCorrespondenceEntry({
    direction: 'outbound',
    source: 'platform_send',
    resendEmailId: input.resendEmailId,
    messageId: input.messageId ?? null,
    fromAddress: input.fromAddress,
    toAddresses: input.toAddresses,
    ccAddresses: input.ccAddresses ?? [],
    bccAddresses: input.bccAddresses ?? [],
    subject: input.subject,
    textBody: input.textBody ?? null,
    htmlBody: input.htmlBody ?? null,
    headers: input.headers ?? {},
    attachments: input.attachments ?? [],
    occurredAt: input.observedAt.toISOString(),
    ...(overrides.id !== undefined ? { id: overrides.id } : {}),
    ...(overrides.metadata !== undefined
      ? { metadata: overrides.metadata }
      : { metadata: { threadKey: input.threadKey } }),
  });
};

export const createSendingPlatformSendThread = (
  overrides: Partial<ThreadRecord> = {}
): ThreadRecord => {
  return createThreadRecord({
    phase: 'sending',
    record: createThreadAggregateRecord({
      submissionPath: 'platform_send',
      correspondence: [],
      metadata: {},
    }),
    ...overrides,
  });
};

export const createAwaitingReplyPlatformSendThreadPendingConfirmation = (
  inputOverrides: {
    successInput?: Partial<ReconcilePlatformSendSuccessInput>;
    thread?: Partial<ThreadRecord>;
  } = {}
): ThreadRecord => {
  const successInput = createPlatformSendSuccessInput(inputOverrides.successInput);
  const baseRecord = createThreadAggregateRecord({
    submissionPath: 'platform_send',
    subject: successInput.subject,
    correspondence: [createPlatformSendOutboundEntry(successInput)],
    metadata: {},
  });

  return createThreadRecord({
    threadKey: successInput.threadKey,
    phase: 'awaiting_reply',
    lastEmailAt: successInput.observedAt,
    record: {
      ...baseRecord,
      metadata: withPlatformSendSuccessMetadata(baseRecord, successInput),
    },
    ...inputOverrides.thread,
  });
};

const syncThreadRecord = (thread: ThreadRecord): ThreadRecord => ({
  ...thread,
  campaignKey: thread.campaignKey ?? thread.record.campaignKey,
});

const isCampaignAdminScopedThread = (thread: ThreadRecord, campaignKey: string): boolean => {
  const normalizedCampaignKey =
    thread.campaignKey ?? thread.record.campaignKey ?? thread.record.campaign;
  return normalizedCampaignKey === campaignKey && isCampaignAdminThreadInScope(thread);
};

const listCampaignAdminThreadsInMemory = (
  threads: readonly ThreadRecord[],
  input: ListCampaignAdminThreadsInput
): CampaignAdminThreadPage => {
  const filtered = threads
    .filter((thread) => isCampaignAdminScopedThread(thread, input.campaignKey))
    .filter((thread) =>
      input.entityCui !== undefined ? thread.entityCui === input.entityCui : true
    )
    .filter((thread) =>
      input.updatedAtFrom !== undefined ? thread.updatedAt >= input.updatedAtFrom : true
    )
    .filter((thread) =>
      input.updatedAtTo !== undefined ? thread.updatedAt <= input.updatedAtTo : true
    )
    .filter((thread) => {
      if (input.query === undefined) {
        return true;
      }

      const normalizedQuery = input.query.toLowerCase();
      return (
        thread.entityCui.toLowerCase().includes(normalizedQuery) ||
        thread.record.institutionEmail.toLowerCase().includes(normalizedQuery)
      );
    })
    .filter((thread) => {
      const projectedThread = projectCampaignAdminThread(thread);
      if (input.stateGroup !== undefined) {
        const isOpen =
          projectedThread.threadState === 'started' || projectedThread.threadState === 'pending';

        if (input.stateGroup === 'open' && !isOpen) {
          return false;
        }

        if (input.stateGroup === 'closed' && projectedThread.threadState !== 'resolved') {
          return false;
        }
      }

      if (input.threadState !== undefined && projectedThread.threadState !== input.threadState) {
        return false;
      }

      if (
        input.responseStatus !== undefined &&
        projectedThread.currentResponseStatus !== input.responseStatus
      ) {
        return false;
      }

      const latestResponseAt =
        projectedThread.latestResponseAt !== null
          ? new Date(projectedThread.latestResponseAt)
          : null;

      if (
        input.latestResponseAtFrom !== undefined &&
        (latestResponseAt === null || latestResponseAt < input.latestResponseAtFrom)
      ) {
        return false;
      }

      if (
        input.latestResponseAtTo !== undefined &&
        (latestResponseAt === null || latestResponseAt > input.latestResponseAtTo)
      ) {
        return false;
      }

      return true;
    })
    .sort((left, right) => {
      const updatedAtDifference = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (updatedAtDifference !== 0) {
        return updatedAtDifference;
      }

      return left.id.localeCompare(right.id);
    });

  const cursorFiltered =
    input.cursor === undefined
      ? filtered
      : filtered.filter((thread) => {
          const cursorUpdatedAt = new Date(input.cursor!.updatedAt).getTime();
          const threadUpdatedAt = thread.updatedAt.getTime();
          return (
            threadUpdatedAt < cursorUpdatedAt ||
            (threadUpdatedAt === cursorUpdatedAt && thread.id > input.cursor!.id)
          );
        });

  const items = cursorFiltered.slice(0, input.limit + 1);
  const pageItems = items.slice(0, input.limit);
  const nextCursorThread = items.length > input.limit ? pageItems[pageItems.length - 1] : undefined;

  return {
    items: pageItems,
    totalCount: filtered.length,
    hasMore: items.length > input.limit,
    nextCursor:
      nextCursorThread !== undefined
        ? {
            updatedAt: nextCursorThread.updatedAt.toISOString(),
            id: nextCursorThread.id,
          }
        : null,
    limit: input.limit,
  };
};

export interface InMemoryCorrespondenceRepo extends InstitutionCorrespondenceRepository {
  snapshotThreads(): ThreadRecord[];
}

export const makeInMemoryCorrespondenceRepo = (
  options: {
    threads?: ThreadRecord[];
  } = {}
): InMemoryCorrespondenceRepo => {
  const threads = [...(options.threads ?? [])].map(syncThreadRecord);

  const findThreadIndexById = (threadId: string): number =>
    threads.findIndex((thread) => thread.id === threadId);

  return {
    async createThread(input: CreateThreadInput) {
      const interactionKey =
        input.record.submissionPath === 'self_send_cc' &&
        typeof input.record.metadata['interactionKey'] === 'string'
          ? input.record.metadata['interactionKey']
          : null;

      const conflictingThread = threads.find((thread) => {
        if (thread.threadKey === input.threadKey) {
          return true;
        }

        const normalizedCampaignKey =
          input.campaignKey ?? input.record.campaignKey ?? input.record.campaign;
        const threadCampaignKey =
          thread.campaignKey ?? thread.record.campaignKey ?? thread.record.campaign;

        if (
          input.record.submissionPath === 'platform_send' &&
          input.phase !== 'failed' &&
          thread.record.submissionPath === 'platform_send' &&
          thread.phase !== 'failed'
        ) {
          return (
            thread.entityCui === input.entityCui && threadCampaignKey === normalizedCampaignKey
          );
        }

        if (
          input.record.submissionPath === 'self_send_cc' &&
          interactionKey !== null &&
          thread.record.submissionPath === 'self_send_cc' &&
          thread.record.metadata['interactionKey'] === interactionKey
        ) {
          return (
            thread.entityCui === input.entityCui && threadCampaignKey === normalizedCampaignKey
          );
        }

        return false;
      });

      if (conflictingThread !== undefined) {
        return err(createConflictError('A correspondence thread already exists for this key.'));
      }

      const thread = syncThreadRecord(
        createThreadRecord({
          entityCui: input.entityCui,
          campaignKey: input.campaignKey,
          threadKey: input.threadKey,
          phase: input.phase,
          lastEmailAt: input.lastEmailAt ?? null,
          lastReplyAt: input.lastReplyAt ?? null,
          nextActionAt: input.nextActionAt ?? null,
          closedAt: input.closedAt ?? null,
          record: input.record,
        })
      );
      threads.push(thread);
      return ok(thread);
    },

    async findThreadById(id) {
      return ok(threads.find((thread) => thread.id === id) ?? null);
    },

    async findThreadByKey(threadKey) {
      return ok(threads.find((thread) => thread.threadKey === threadKey) ?? null);
    },

    async findSelfSendThreadByInteractionKey(interactionKey) {
      return ok(
        [...threads]
          .reverse()
          .find(
            (thread) =>
              thread.record.submissionPath === 'self_send_cc' &&
              thread.record.metadata['interactionKey'] === interactionKey
          ) ?? null
      );
    },

    async findPlatformSendThreadByEntity(input) {
      return ok(
        [...threads]
          .reverse()
          .find(
            (thread) =>
              thread.entityCui === input.entityCui &&
              thread.phase !== 'failed' &&
              thread.record.campaign === input.campaign &&
              thread.record.submissionPath === 'platform_send'
          ) ?? null
      );
    },

    async findLatestPlatformSendThreadByEntity(input) {
      return ok(
        [...threads]
          .reverse()
          .find(
            (thread) =>
              thread.entityCui === input.entityCui &&
              thread.record.campaign === input.campaign &&
              thread.record.submissionPath === 'platform_send'
          ) ?? null
      );
    },

    async findCampaignAdminThreadById(input) {
      return ok(
        threads.find(
          (thread) =>
            thread.id === input.threadId && isCampaignAdminScopedThread(thread, input.campaignKey)
        ) ?? null
      );
    },

    async listCampaignAdminThreads(input) {
      return ok(listCampaignAdminThreadsInMemory(threads, input));
    },

    async listPlatformSendThreadsPendingSuccessConfirmation() {
      return ok(
        threads.filter(
          (thread) =>
            thread.record.submissionPath === 'platform_send' &&
            (thread.phase === 'sending' ||
              (thread.phase === 'awaiting_reply' &&
                !hasPlatformSendSuccessConfirmation(thread.record)))
        )
      );
    },

    async updateThread(threadId: string, input: UpdateThreadInput) {
      const index = findThreadIndexById(threadId);
      if (index === -1) {
        return err(createNotFoundError(`Thread "${threadId}" was not found.`));
      }

      const current = threads[index]!;
      const next = syncThreadRecord({
        ...current,
        ...(input.phase !== undefined ? { phase: input.phase } : {}),
        ...(input.lastEmailAt !== undefined ? { lastEmailAt: input.lastEmailAt } : {}),
        ...(input.lastReplyAt !== undefined ? { lastReplyAt: input.lastReplyAt } : {}),
        ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
        ...(input.closedAt !== undefined ? { closedAt: input.closedAt } : {}),
        ...(input.record !== undefined ? { record: input.record } : {}),
        updatedAt: now(),
      });
      threads[index] = next;
      return ok(next);
    },

    async appendCorrespondenceEntry(input) {
      const index = findThreadIndexById(input.threadId);
      if (index === -1) {
        return err(createNotFoundError(`Thread "${input.threadId}" was not found.`));
      }

      const current = threads[index]!;
      if (
        (input.entry.resendEmailId !== null &&
          current.record.correspondence.some(
            (entry) => entry.resendEmailId === input.entry.resendEmailId
          )) ||
        current.record.correspondence.some((entry) => entry.id === input.entry.id)
      ) {
        return ok(current);
      }

      const next = syncThreadRecord({
        ...current,
        phase: input.phase ?? current.phase,
        ...(input.lastEmailAt !== undefined ? { lastEmailAt: input.lastEmailAt } : {}),
        ...(input.lastReplyAt !== undefined ? { lastReplyAt: input.lastReplyAt } : {}),
        ...(input.nextActionAt !== undefined ? { nextActionAt: input.nextActionAt } : {}),
        ...(input.closedAt !== undefined ? { closedAt: input.closedAt } : {}),
        record: {
          ...current.record,
          correspondence: [...current.record.correspondence, input.entry],
        },
        updatedAt: now(),
      });
      threads[index] = next;
      return ok(next);
    },

    async mutateThread(threadId, mutator) {
      const index = findThreadIndexById(threadId);
      if (index === -1) {
        return err(createNotFoundError(`Thread "${threadId}" was not found.`));
      }

      const current = threads[index]!;
      const nextStateResult:
        | Result<LockedThreadMutation, ReturnType<typeof createNotFoundError>>
        | Result<LockedThreadMutation, any> = mutator(current);
      if (nextStateResult.isErr()) {
        return err(nextStateResult.error);
      }

      const nextState = nextStateResult.value;
      const next = syncThreadRecord({
        ...current,
        ...(nextState.phase !== undefined ? { phase: nextState.phase } : {}),
        ...(nextState.lastEmailAt !== undefined ? { lastEmailAt: nextState.lastEmailAt } : {}),
        ...(nextState.lastReplyAt !== undefined ? { lastReplyAt: nextState.lastReplyAt } : {}),
        ...(nextState.nextActionAt !== undefined ? { nextActionAt: nextState.nextActionAt } : {}),
        ...(nextState.closedAt !== undefined ? { closedAt: nextState.closedAt } : {}),
        record: nextState.record,
        updatedAt: now(),
      });
      threads[index] = next;
      return ok(next);
    },

    async mutateCampaignAdminThread(input, mutator) {
      const index = threads.findIndex(
        (thread) =>
          thread.id === input.threadId && isCampaignAdminScopedThread(thread, input.campaignKey)
      );
      if (index === -1) {
        return err(createNotFoundError(`Thread "${input.threadId}" was not found.`));
      }

      const current = threads[index]!;
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
        return err(
          createConflictError(
            'This thread has changed since it was loaded. Refresh it and retry the action.'
          )
        );
      }

      const nextStateResult = mutator(current);
      if (nextStateResult.isErr()) {
        return err(nextStateResult.error);
      }

      const nextState = nextStateResult.value;
      const next = syncThreadRecord({
        ...current,
        ...(nextState.phase !== undefined ? { phase: nextState.phase } : {}),
        ...(nextState.lastEmailAt !== undefined ? { lastEmailAt: nextState.lastEmailAt } : {}),
        ...(nextState.lastReplyAt !== undefined ? { lastReplyAt: nextState.lastReplyAt } : {}),
        ...(nextState.nextActionAt !== undefined ? { nextActionAt: nextState.nextActionAt } : {}),
        ...(nextState.closedAt !== undefined ? { closedAt: nextState.closedAt } : {}),
        record: nextState.record,
        updatedAt: now(),
      });
      threads[index] = next;
      return ok(next);
    },

    async attachMessageIdToCorrespondenceByResendEmail(threadKey, resendEmailId, messageId) {
      const index = threads.findIndex((thread) => thread.threadKey === threadKey);
      if (index === -1) {
        return ok(null);
      }

      const current = threads[index]!;
      const entryIndex = current.record.correspondence.findIndex(
        (entry) => entry.resendEmailId === resendEmailId
      );
      if (entryIndex === -1) {
        return ok(current);
      }

      const nextEntries = [...current.record.correspondence];
      const existing = nextEntries[entryIndex];
      if (existing === undefined) {
        return ok(current);
      }

      nextEntries[entryIndex] = {
        ...existing,
        messageId,
      };

      const next = syncThreadRecord({
        ...current,
        record: {
          ...current.record,
          correspondence: nextEntries,
        },
        updatedAt: now(),
      });
      threads[index] = next;
      return ok(next);
    },

    async listPendingReplies(input) {
      const matchingItems = threads
        .filter((thread) => thread.phase === 'reply_received_unreviewed')
        .map((thread) => {
          const reply =
            [...thread.record.correspondence]
              .filter((entry) => entry.direction === 'inbound')
              .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;

          return reply !== null ? { thread, reply } : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);
      const items = matchingItems.slice(input.offset, input.offset + input.limit + 1);

      return ok({
        items: items.slice(0, input.limit),
        totalCount: matchingItems.length,
        hasMore: items.length > input.limit,
        limit: input.limit,
        offset: input.offset,
      } satisfies PendingReplyPage);
    },

    snapshotThreads() {
      return [...threads];
    },
  };
};
