import { ok, type Result } from 'neverthrow';

import type { DeliveryError } from '../errors.js';
import type { DeliveryRepository } from '../ports.js';

export const UNAPPROVED_REPLY = 'Institution reply has no matching publication approval.';

// Old outbox rows can already contain rendered mail. Require an explicit review
// and match the exact excerpt to its original entry at each delivery boundary.
export async function checkPublicDebateReplyPublication(
  repo: Pick<DeliveryRepository, 'hasApprovedReplyExcerpt'>,
  metadata: Readonly<Record<string, unknown>>
): Promise<Result<boolean, DeliveryError>> {
  const { eventType, threadId, threadKey, entityCui, basedOnEntryId, replyTextPreview } = metadata;
  if (eventType === 'thread_started' || eventType === 'thread_failed') {
    return ok(replyTextPreview === undefined && metadata['reviewNotes'] === undefined);
  }
  if (
    eventType !== 'reply_reviewed' ||
    metadata['replyPublicationVersion'] !== 1 ||
    typeof threadId !== 'string' ||
    typeof threadKey !== 'string' ||
    typeof entityCui !== 'string' ||
    typeof basedOnEntryId !== 'string' ||
    metadata['replyEntryId'] !== basedOnEntryId ||
    typeof replyTextPreview !== 'string' ||
    replyTextPreview.trim() === '' ||
    metadata['reviewNotes'] !== undefined
  ) {
    return ok(false);
  }
  return repo.hasApprovedReplyExcerpt({
    threadId,
    threadKey,
    entityCui,
    entryId: basedOnEntryId,
    excerpt: replyTextPreview,
  });
}
