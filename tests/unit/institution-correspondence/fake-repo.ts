import { ok, err, type Result } from 'neverthrow';

import {
  createNotFoundError,
  type CorrespondenceEntry,
  type CorrespondenceThreadRecord,
  type CreateThreadInput,
  type InstitutionCorrespondenceRepository,
  type LockedThreadMutation,
  type PendingReplyPage,
  type ThreadRecord,
  type UpdateThreadInput,
} from '@/modules/institution-correspondence/index.js';

const now = (): Date => new Date('2026-03-25T12:00:00.000Z');

let nextThreadId = 1;
let nextEntryId = 1;

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
  campaign: overrides.campaign ?? 'public_debate',
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
  metadata: overrides.metadata ?? {},
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

const syncThreadRecord = (thread: ThreadRecord): ThreadRecord => ({
  ...thread,
  campaignKey: thread.campaignKey ?? thread.record.campaignKey,
});

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

    async findPlatformSendThreadByEntity(input) {
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
        lastEmailAt: input.lastEmailAt ?? current.lastEmailAt,
        lastReplyAt: input.lastReplyAt ?? current.lastReplyAt,
        nextActionAt: input.nextActionAt ?? current.nextActionAt,
        closedAt: input.closedAt ?? current.closedAt,
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
      const items = threads
        .filter((thread) => thread.phase === 'reply_received_unreviewed')
        .map((thread) => {
          const reply =
            [...thread.record.correspondence]
              .filter((entry) => entry.direction === 'inbound')
              .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0] ?? null;

          return reply !== null ? { thread, reply } : null;
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(input.offset, input.offset + input.limit + 1);

      return ok({
        items: items.slice(0, input.limit),
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
