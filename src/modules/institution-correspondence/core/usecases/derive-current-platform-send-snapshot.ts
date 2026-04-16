import { getLatestAdminResponseEvent } from '../admin-workflow.js';

import type { PublicDebateEntityUpdateNotification } from '../ports.js';
import type { ThreadRecord } from '../types.js';

export interface DerivedCurrentPlatformSendSnapshotResult {
  status:
    | 'no_thread'
    | 'skipped_phase'
    | 'skipped_missing_reply'
    | 'skipped_missing_review'
    | 'derived';
  eventType?: PublicDebateEntityUpdateNotification['eventType'];
  thread?: ThreadRecord;
  notification?: PublicDebateEntityUpdateNotification;
}

const toValidDateOrFallback = (timestamp: string | null | undefined, fallback: Date): Date => {
  if (timestamp === undefined || timestamp === null || timestamp.trim() === '') {
    return fallback;
  }

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const getLatestInboundReply = (thread: ThreadRecord) => {
  return [...thread.record.correspondence]
    .filter((entry) => entry.direction === 'inbound')
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0];
};

export const deriveCurrentPlatformSendSnapshot = (
  thread: ThreadRecord | null
): DerivedCurrentPlatformSendSnapshotResult => {
  if (thread === null) {
    return { status: 'no_thread' };
  }

  const latestAdminResponseEvent = getLatestAdminResponseEvent(thread.record);
  if (
    latestAdminResponseEvent?.responseStatus === 'request_confirmed' ||
    latestAdminResponseEvent?.responseStatus === 'request_denied'
  ) {
    return { status: 'skipped_phase', thread };
  }

  switch (thread.phase) {
    case 'awaiting_reply':
      return {
        status: 'derived',
        eventType: 'thread_started',
        thread,
        notification: {
          eventType: 'thread_started',
          thread,
          occurredAt: thread.lastEmailAt ?? thread.updatedAt,
          requesterUserId: thread.record.ownerUserId,
        },
      };

    case 'failed':
      return {
        status: 'derived',
        eventType: 'thread_failed',
        thread,
        notification: {
          eventType: 'thread_failed',
          thread,
          occurredAt: thread.updatedAt,
        },
      };

    case 'reply_received_unreviewed': {
      const reply = getLatestInboundReply(thread);
      if (reply === undefined) {
        return { status: 'skipped_missing_reply', thread };
      }

      return {
        status: 'derived',
        eventType: 'reply_received',
        thread,
        notification: {
          eventType: 'reply_received',
          thread,
          occurredAt: toValidDateOrFallback(reply.occurredAt, thread.updatedAt),
          reply,
        },
      };
    }

    case 'manual_follow_up_needed':
    case 'resolved_positive':
    case 'resolved_negative': {
      const latestReview = thread.record.latestReview;
      if (latestReview === null) {
        return { status: 'skipped_missing_review', thread };
      }

      const reviewReply = thread.record.correspondence.find(
        (entry) => entry.id === latestReview.basedOnEntryId && entry.direction === 'inbound'
      );

      return {
        status: 'derived',
        eventType: 'reply_reviewed',
        thread,
        notification: {
          eventType: 'reply_reviewed',
          thread,
          occurredAt: toValidDateOrFallback(latestReview.reviewedAt, thread.updatedAt),
          ...(reviewReply !== undefined ? { reply: reviewReply } : {}),
          basedOnEntryId: latestReview.basedOnEntryId,
          resolutionCode: latestReview.resolutionCode,
          reviewNotes: latestReview.notes,
        },
      };
    }

    case 'sending':
    case 'closed_no_response':
      return { status: 'skipped_phase', thread };
  }
};
