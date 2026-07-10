import { err, ok, type Result } from 'neverthrow';

import type { AuditError } from '../../audit/errors.js';
import type { AuditLedgerPort } from '../../audit/ports.js';
import type { DeliveryRepo } from '../../delivery/ports.js';
import type { ValidationError } from '../../shared/errors.js';
import type { Clock, IdGenerator, LoggerPort } from '../../shared/ports.js';
import type { DigestError } from '../errors.js';
import type { DigestBatchRepo } from '../ports.js';

export interface CancelDigestBatchDeps {
  digests: DigestBatchRepo;
  deliveries: DeliveryRepo;
  audit: AuditLedgerPort;
  clock: Clock;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface CancelDigestBatchInput {
  batchId: string;
  adminUserId: string;
  reason: string;
}

export interface CancelDigestBatchResult {
  cancelled: boolean;
}

export type CancelDigestBatchError = DigestError | AuditError | ValidationError;

export const cancelDigestBatch = async (
  deps: CancelDigestBatchDeps,
  input: CancelDigestBatchInput
): Promise<Result<CancelDigestBatchResult, CancelDigestBatchError>> => {
  if (input.reason.trim().length === 0) {
    return err({
      type: 'ValidationError',
      message: 'Cancellation reason is required',
      field: 'reason',
    });
  }
  const now = deps.clock.now();
  // DESIGN NOTE: cancelWholeBatch is the committed port's sole batch cancellation
  // operation and is treated as the atomic batch-plus-delivery cancellation boundary.
  const cancelled = await deps.digests.cancelWholeBatch({
    batchId: input.batchId,
    reason: input.reason,
    now,
  });
  if (cancelled.isErr()) {
    return err(cancelled.error);
  }
  if (cancelled.value) {
    const audited = await deps.audit.append({
      action: 'digest.batch_cancelled',
      occurredAt: now,
      actor: input.adminUserId,
      batchId: input.batchId,
      reason: input.reason,
    });
    if (audited.isErr()) {
      return err(audited.error);
    }
  }
  return ok({ cancelled: cancelled.value });
};
