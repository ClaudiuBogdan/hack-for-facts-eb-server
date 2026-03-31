import { err, ok, type Result } from 'neverthrow';

import { isNonEmptyString } from '@/common/utils/is-non-empty-string.js';

import { createValidationError, type DeliveryError } from '../errors.js';

import type { ComposeJobScheduler, DeliveryRepository } from '../ports.js';
import type { DeliveryRecord } from '../types.js';

export interface UserRegisteredEvent {
  runId: string;
  source: string;
  sourceEventId: string;
  userId: string;
  registeredAt: string;
  email?: string;
}

export interface EnqueueTransactionalWelcomeNotificationDeps {
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export interface EnqueueTransactionalWelcomeNotificationResult {
  outbox: DeliveryRecord;
  created: boolean;
}

const TRANSACTIONAL_WELCOME_SCOPE_KEY = 'welcome';
const TRANSACTIONAL_WELCOME_SOURCE = 'transactional_welcome';

const isValidEmailAddress = (email: string): boolean => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email);
};

const buildTransactionalWelcomeDeliveryKey = (userId: string): string => {
  return `${TRANSACTIONAL_WELCOME_SOURCE}:${userId}`;
};

const shouldRequeuePendingWelcomeOutbox = (outbox: DeliveryRecord): boolean => {
  return outbox.notificationType === 'transactional_welcome' && outbox.status === 'pending';
};

const enqueueOutboxComposeJob = async (
  composeJobScheduler: ComposeJobScheduler,
  runId: string,
  outboxId: string
): Promise<Result<void, DeliveryError>> => {
  return composeJobScheduler.enqueue({
    runId,
    kind: 'outbox',
    outboxId,
  });
};

const normalizeOptionalEmail = (
  email: string | undefined
): Result<string | undefined, DeliveryError> => {
  if (email === undefined) {
    return ok(undefined);
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmailAddress(normalizedEmail)) {
    return err(createValidationError('email must be a valid address'));
  }

  return ok(normalizedEmail);
};

const returnExistingOutbox = async (
  deps: EnqueueTransactionalWelcomeNotificationDeps,
  input: UserRegisteredEvent,
  outbox: DeliveryRecord
): Promise<Result<EnqueueTransactionalWelcomeNotificationResult, DeliveryError>> => {
  if (shouldRequeuePendingWelcomeOutbox(outbox)) {
    const enqueueResult = await enqueueOutboxComposeJob(
      deps.composeJobScheduler,
      input.runId,
      outbox.id
    );

    if (enqueueResult.isErr()) {
      return err(enqueueResult.error);
    }
  }

  return ok({
    outbox,
    created: false,
  });
};

export const enqueueTransactionalWelcomeNotification = async (
  deps: EnqueueTransactionalWelcomeNotificationDeps,
  input: UserRegisteredEvent
): Promise<Result<EnqueueTransactionalWelcomeNotificationResult, DeliveryError>> => {
  const userId = input.userId.trim();
  const source = input.source.trim();
  const sourceEventId = input.sourceEventId.trim();
  const registeredAt = input.registeredAt.trim();
  const normalizedEmailResult = normalizeOptionalEmail(input.email);

  if (!isNonEmptyString(input.runId)) {
    return err(createValidationError('runId is required'));
  }

  if (source.length === 0) {
    return err(createValidationError('source is required'));
  }

  if (userId.length === 0) {
    return err(createValidationError('userId is required'));
  }

  if (sourceEventId.length === 0) {
    return err(createValidationError('sourceEventId is required'));
  }

  if (registeredAt.length === 0 || Number.isNaN(Date.parse(registeredAt))) {
    return err(createValidationError('registeredAt must be a valid ISO timestamp'));
  }

  if (normalizedEmailResult.isErr()) {
    return err(normalizedEmailResult.error);
  }

  const deliveryKey = buildTransactionalWelcomeDeliveryKey(userId);
  const existingResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  if (existingResult.value !== null) {
    return returnExistingOutbox(deps, input, existingResult.value);
  }

  const createResult = await deps.deliveryRepo.create({
    userId,
    notificationType: 'transactional_welcome',
    referenceId: null,
    scopeKey: TRANSACTIONAL_WELCOME_SCOPE_KEY,
    deliveryKey,
    ...(normalizedEmailResult.value !== undefined ? { toEmail: normalizedEmailResult.value } : {}),
    metadata: {
      source,
      sourceEventId,
      registeredAt,
    },
  });

  if (createResult.isErr()) {
    if (createResult.error.type === 'DuplicateDelivery') {
      const duplicateResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
      if (duplicateResult.isErr()) {
        return err(duplicateResult.error);
      }

      if (duplicateResult.value !== null) {
        return returnExistingOutbox(deps, input, duplicateResult.value);
      }
    }

    return err(createResult.error);
  }

  const outbox = createResult.value;
  const enqueueResult = await enqueueOutboxComposeJob(
    deps.composeJobScheduler,
    input.runId,
    outbox.id
  );

  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  return ok({
    outbox,
    created: true,
  });
};
