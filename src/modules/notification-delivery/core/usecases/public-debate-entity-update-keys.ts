import { generateDeliveryKey } from '@/modules/notifications/core/types.js';

export interface PublicDebateEntityUpdateKeyInput {
  eventType: 'thread_started' | 'thread_failed' | 'reply_received' | 'reply_reviewed';
  threadId: string;
  replyEntryId?: string;
  basedOnEntryId?: string;
}

export const buildPublicDebateEntityUpdateScopeKey = (
  input: PublicDebateEntityUpdateKeyInput
): string => {
  switch (input.eventType) {
    case 'thread_started':
      return `funky:delivery:thread_started_${input.threadId}`;
    case 'thread_failed':
      return `funky:delivery:thread_failed_${input.threadId}`;
    case 'reply_received':
      return `funky:delivery:reply_${input.threadId}_${input.replyEntryId ?? 'unknown'}`;
    case 'reply_reviewed':
      return `funky:delivery:review_${input.threadId}_${input.basedOnEntryId ?? 'unknown'}`;
  }
};

export const buildPublicDebateEntityUpdateDeliveryKey = (input: {
  userId: string;
  notificationId: string;
  scopeKey: string;
}): string => {
  return generateDeliveryKey(input.userId, input.notificationId, input.scopeKey);
};
