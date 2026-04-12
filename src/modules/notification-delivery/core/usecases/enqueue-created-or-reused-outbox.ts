import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, type DeliveryError } from '../errors.js';
import { TERMINAL_STATUSES, type DeliveryRecord } from '../types.js';

import type { ComposeJobScheduler, CreateDeliveryInput, DeliveryRepository } from '../ports.js';

export interface EnqueueCreatedOrReusedOutboxDeps {
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export type ReusedOutboxComposeStrategy = 'always_enqueue_compose' | 'skip_terminal_compose';
export type DirectOutboxComposeStatus =
  | 'compose_enqueued'
  | 'compose_enqueue_failed'
  | 'skipped_terminal';

export interface EnqueueCreatedOrReusedOutboxInput {
  runId: string;
  deliveryKey: string;
  createInput: CreateDeliveryInput;
  reusedOutboxComposeStrategy?: ReusedOutboxComposeStrategy;
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

    return ok(
      await maybeEnqueueCompose(deps.composeJobScheduler, input, duplicateResult.value, 'reused')
    );
  }

  return ok(
    await maybeEnqueueCompose(deps.composeJobScheduler, input, createResult.value, 'created')
  );
};
