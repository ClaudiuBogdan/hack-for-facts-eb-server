import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, type DeliveryError } from '../errors.js';
import { CLAIMABLE_STATUSES, TERMINAL_STATUSES, type DeliveryRecord } from '../types.js';

import type { ComposeJobScheduler, CreateDeliveryInput, DeliveryRepository } from '../ports.js';

export interface EnqueueCreatedOrReusedOutboxDeps {
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export type ReusedOutboxComposeStrategy =
  | 'always_enqueue_compose'
  | 'skip_terminal_compose'
  | 'enqueue_if_claimable';
export type DirectOutboxComposeStatus =
  | 'compose_enqueued'
  | 'compose_enqueue_failed'
  | 'skipped_terminal'
  | 'skipped_not_replayable';

export interface EnqueueCreatedOrReusedOutboxInput {
  runId: string;
  deliveryKey: string;
  createInput: CreateDeliveryInput;
  reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy;
  reusedOutboxMetadataRefresh?: Record<string, unknown>;
}

export interface EnqueueCreatedOrReusedOutboxResult {
  outboxId: string;
  source: 'created' | 'reused';
  composeEnqueued: boolean;
  composeStatus: DirectOutboxComposeStatus;
}

const enqueueCompose = async (
  composeJobScheduler: ComposeJobScheduler,
  runId: string,
  outboxId: string
): Promise<DirectOutboxComposeStatus> => {
  const enqueueResult = await composeJobScheduler.enqueue({
    runId,
    kind: 'outbox',
    outboxId,
  });

  return enqueueResult.isOk() ? 'compose_enqueued' : 'compose_enqueue_failed';
};

const maybeEnqueueCompose = async (
  composeJobScheduler: ComposeJobScheduler,
  input: EnqueueCreatedOrReusedOutboxInput,
  outbox: DeliveryRecord,
  source: EnqueueCreatedOrReusedOutboxResult['source']
): Promise<EnqueueCreatedOrReusedOutboxResult> => {
  if (
    source === 'reused' &&
    input.reusedOutboxComposeStrategy === 'skip_terminal_compose' &&
    TERMINAL_STATUSES.includes(outbox.status)
  ) {
    return {
      outboxId: outbox.id,
      source,
      composeEnqueued: false,
      composeStatus: 'skipped_terminal',
    };
  }

  if (
    source === 'reused' &&
    input.reusedOutboxComposeStrategy === 'enqueue_if_claimable' &&
    !CLAIMABLE_STATUSES.includes(outbox.status)
  ) {
    return {
      outboxId: outbox.id,
      source,
      composeEnqueued: false,
      composeStatus: 'skipped_not_replayable',
    };
  }

  const composeStatus = await enqueueCompose(composeJobScheduler, input.runId, outbox.id);

  return {
    outboxId: outbox.id,
    source,
    composeEnqueued: composeStatus === 'compose_enqueued',
    composeStatus,
  };
};

export const enqueueCreatedOrReusedOutbox = async (
  deps: EnqueueCreatedOrReusedOutboxDeps,
  input: EnqueueCreatedOrReusedOutboxInput
): Promise<Result<EnqueueCreatedOrReusedOutboxResult, DeliveryError>> => {
  const createResult = await deps.deliveryRepo.create(input.createInput);

  if (createResult.isErr()) {
    if (createResult.error.type !== 'DuplicateDelivery') {
      return err(createResult.error);
    }

    const duplicateResult = await deps.deliveryRepo.findByDeliveryKey(input.deliveryKey);
    if (duplicateResult.isErr()) {
      return err(duplicateResult.error);
    }

    if (duplicateResult.value === null) {
      return err(
        createDatabaseError(
          `Duplicate delivery "${input.deliveryKey}" was reported but the existing outbox row could not be reloaded.`
        )
      );
    }

    let reusedOutbox = duplicateResult.value;
    if (input.reusedOutboxMetadataRefresh !== undefined) {
      const refreshResult = await deps.deliveryRepo.refreshMetadataIfClaimableForCompose(
        reusedOutbox.id,
        input.reusedOutboxMetadataRefresh
      );
      if (refreshResult.isErr()) {
        return err(refreshResult.error);
      }

      if (refreshResult.value !== null) {
        reusedOutbox = refreshResult.value;
      }
    }

    return ok(await maybeEnqueueCompose(deps.composeJobScheduler, input, reusedOutbox, 'reused'));
  }

  return ok(
    await maybeEnqueueCompose(deps.composeJobScheduler, input, createResult.value, 'created')
  );
};
