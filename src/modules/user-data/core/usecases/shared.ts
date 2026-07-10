import { err, ok, type Result } from 'neverthrow';

import {
  createActorNotAllowed,
  createForbidden,
  createIdempotencyConflict,
  createQuotaExceeded,
  createRateLimited,
  createRevisionConflict,
  type UserDataError,
} from '../errors.js';
import { toRecordView } from '../planners/shared.js';
import {
  type IdGenerator,
  type MutationOutcome,
  type MutationRateLimiterPort,
  type UserDataMutationPort,
} from '../ports.js';
import { type CategoryRegistry } from '../registry/registry.js';
import {
  type ActorContext,
  type CurrentRecord,
  type MutationResponse,
  type ReceiptClaim,
  type RecordStatus,
} from '../types.js';

export interface LoggerPort {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface MutationDeps {
  mutationPort: UserDataMutationPort;
  rateLimiter: MutationRateLimiterPort;
  registry: CategoryRegistry;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface MaintenanceMutationDeps {
  mutationPort: UserDataMutationPort;
  registry: CategoryRegistry;
  ids: IdGenerator;
  logger: LoggerPort;
}

export interface MutationActorInput {
  ownerId: string;
  requesterId: string;
  actor: ActorContext;
}

export const requireOwnerActor = (input: MutationActorInput): Result<void, UserDataError> => {
  if (input.actor.type !== 'owner')
    return err(createActorNotAllowed('owner-mutation', input.actor.type));
  return input.requesterId === input.ownerId
    ? ok(undefined)
    : err(createForbidden('requester is not the record owner'));
};

export const probeAndRateLimit = async (
  deps: Pick<MutationDeps, 'mutationPort' | 'rateLimiter'>,
  input: { ownerId: string; category: string; receipt: ReceiptClaim; limit: number }
): Promise<Result<'absent' | 'match', UserDataError>> => {
  const probe = await deps.mutationPort.probeReceipt(input.receipt);
  if (probe.isErr()) return err(probe.error);
  if (probe.value === 'mismatch') return err(createIdempotencyConflict());
  if (probe.value === 'match') return ok('match');
  const consumed = await deps.rateLimiter.consume(input.ownerId, input.category, input.limit);
  if (consumed.isErr()) return err(consumed.error);
  return consumed.value.allowed
    ? ok('absent')
    : err(createRateLimited(consumed.value.retryAfterSeconds));
};

export const probeWithoutRateLimit = async (
  mutationPort: UserDataMutationPort,
  receipt: ReceiptClaim
): Promise<Result<'absent' | 'match', UserDataError>> => {
  const probe = await mutationPort.probeReceipt(receipt);
  if (probe.isErr()) return err(probe.error);
  return probe.value === 'mismatch' ? err(createIdempotencyConflict()) : ok(probe.value);
};

/**
 * On a probable replay (receipt probe matched), the stored record has already
 * advanced past the command's expected revision, so the planner would reject
 * the retry with a conflict before commit() can return the receipt. Present
 * the record as the command expects it. This can never commit fabricated
 * state: commit() checks the receipt before CAS, and if the receipt vanished
 * in between, the fabricated expectedRevision no longer matches the real row
 * (and creates hit the unique identity constraint), so CAS rejects it.
 */
export const replayPlanningView = (
  current: CurrentRecord,
  expectedRevision: number,
  status: RecordStatus
): CurrentRecord => ({ ...current, revision: expectedRevision, status });

export const mapMutationOutcome = (
  category: string,
  outcome: MutationOutcome
): Result<MutationResponse, UserDataError> => {
  switch (outcome.kind) {
    case 'committed':
    case 'replayed':
      return ok({
        record: toRecordView(outcome.result.record),
        eventId: outcome.result.eventId,
        eventSeq: outcome.result.eventSeq,
        recordedAt: outcome.result.recordedAt.toISOString(),
        replayed: outcome.kind === 'replayed',
      });
    case 'revisionConflict':
      return err(createRevisionConflict(toRecordView(outcome.current)));
    case 'idempotencyConflict':
      return err(createIdempotencyConflict());
    case 'quotaExceeded':
      return err(createQuotaExceeded(category, outcome.limit));
  }
};
