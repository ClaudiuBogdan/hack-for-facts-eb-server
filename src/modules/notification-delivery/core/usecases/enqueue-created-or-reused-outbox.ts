import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, type DeliveryError } from '../errors.js';

import type { ComposeJobScheduler, CreateDeliveryInput, DeliveryRepository } from '../ports.js';

export interface EnqueueCreatedOrReusedOutboxDeps {
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export interface EnqueueCreatedOrReusedOutboxInput {
  runId: string;
  deliveryKey: string;
  createInput: CreateDeliveryInput;
}

export interface EnqueueCreatedOrReusedOutboxResult {
  outboxId: string;
  source: 'created' | 'reused';
  composeEnqueued: boolean;
}

const enqueueCompose = async (
  composeJobScheduler: ComposeJobScheduler,
  runId: string,
  outboxId: string
): Promise<boolean> => {
  const enqueueResult = await composeJobScheduler.enqueue({
    runId,
    kind: 'outbox',
    outboxId,
  });

  return enqueueResult.isOk();
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

    return ok({
      outboxId: duplicateResult.value.id,
      source: 'reused',
      composeEnqueued: await enqueueCompose(
        deps.composeJobScheduler,
        input.runId,
        duplicateResult.value.id
      ),
    });
  }

  return ok({
    outboxId: createResult.value.id,
    source: 'created',
    composeEnqueued: await enqueueCompose(
      deps.composeJobScheduler,
      input.runId,
      createResult.value.id
    ),
  });
};
