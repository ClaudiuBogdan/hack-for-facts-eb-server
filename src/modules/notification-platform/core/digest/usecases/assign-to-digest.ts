import { err, ok, type Result } from 'neverthrow';

import { computeDigestWindow } from '../windowing.js';

import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { ExternalChannel } from '../../shared/types.js';
import type { DigestError } from '../errors.js';
import type { DigestBatchRepo } from '../ports.js';

export interface AssignToDigestDeps {
  digests: DigestBatchRepo;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface AssignToDigestInput {
  logicalNotificationId: string;
  userId: string;
  channel: ExternalChannel;
  cadence: 'daily' | 'weekly';
}

export interface AssignToDigestResult {
  batchId: string;
  membership: 'added' | 'duplicate';
}

export type AssignToDigestError = DigestError;

export const assignToDigest = async (
  deps: AssignToDigestDeps,
  input: AssignToDigestInput
): Promise<Result<AssignToDigestResult, AssignToDigestError>> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = deps.clock.now();
    const batch = await deps.digests.findOrCreateOpen({
      id: deps.ids.newId(),
      userId: input.userId,
      channel: input.channel,
      cadence: input.cadence,
      window: computeDigestWindow(input.cadence, now),
      now,
    });
    if (batch.isErr()) {
      return err(batch.error);
    }
    const membership = await deps.digests.addMemberIdempotent({
      batchId: batch.value.id,
      logicalNotificationId: input.logicalNotificationId,
      now,
    });
    if (membership.isErr()) {
      return err(membership.error);
    }
    if (membership.value !== 'batch_closed') {
      return ok({ batchId: batch.value.id, membership: membership.value });
    }
  }
  return err({
    type: 'DigestConflict',
    batchId: input.logicalNotificationId,
    message: 'Digest window rolled while assigning membership',
  });
};
