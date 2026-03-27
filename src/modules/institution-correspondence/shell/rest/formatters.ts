import type { CorrespondenceEntry, PendingReplyItem, ThreadRecord } from '../../core/types.js';

export const toIsoString = (value: Date | null): string | null =>
  value !== null ? value.toISOString() : null;

export const formatCorrespondenceEntry = (entry: CorrespondenceEntry) => ({
  id: entry.id,
  campaignKey: entry.campaignKey,
  direction: entry.direction,
  source: entry.source,
  resendEmailId: entry.resendEmailId,
  messageId: entry.messageId,
  fromAddress: entry.fromAddress,
  toAddresses: entry.toAddresses,
  ccAddresses: entry.ccAddresses,
  bccAddresses: entry.bccAddresses,
  subject: entry.subject,
  textBody: entry.textBody,
  htmlBody: entry.htmlBody,
  headers: entry.headers,
  attachments: entry.attachments,
  occurredAt: entry.occurredAt,
  metadata: entry.metadata,
});

export const formatThread = (thread: ThreadRecord) => ({
  id: thread.id,
  entityCui: thread.entityCui,
  campaignKey: thread.campaignKey,
  threadKey: thread.threadKey,
  phase: thread.phase,
  lastEmailAt: toIsoString(thread.lastEmailAt),
  lastReplyAt: toIsoString(thread.lastReplyAt),
  nextActionAt: toIsoString(thread.nextActionAt),
  closedAt: toIsoString(thread.closedAt),
  record: {
    ...thread.record,
    correspondence: thread.record.correspondence.map(formatCorrespondenceEntry),
  },
  createdAt: thread.createdAt.toISOString(),
  updatedAt: thread.updatedAt.toISOString(),
});

export const formatPendingReplyItem = (item: PendingReplyItem) => ({
  thread: formatThread(item.thread),
  reply: formatCorrespondenceEntry(item.reply),
});
