import { err, ok, type Result } from 'neverthrow';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import { isNonEmptyString } from '@/common/utils/is-non-empty-string.js';

import { createValidationError, type DeliveryError } from '../errors.js';

import type { ComposeJobScheduler, DeliveryRepository } from '../ports.js';
import type { DeliveryRecord } from '../types.js';

export interface PublicDebateTermsAcceptedEvent {
  runId: string;
  source: string;
  sourceEventId: string;
  triggerSource?: string;
  triggeredByUserId?: string;
  userId: string;
  campaignKey: typeof PUBLIC_DEBATE_CAMPAIGN_KEY;
  entityCui: string;
  entityName: string;
  acceptedTermsAt: string;
  selectedEntities?: string[];
  globalPreferenceId: string;
  globalPreferenceActive: boolean;
  entitySubscriptionId: string;
  entitySubscriptionActive: boolean;
}

export interface EnqueuePublicDebateTermsAcceptedNotificationsDeps {
  deliveryRepo: DeliveryRepository;
  composeJobScheduler: ComposeJobScheduler;
}

export interface EnqueuePublicDebateTermsAcceptedNotificationsResult {
  status:
    | 'skipped_scope_inactive'
    | 'welcome_created'
    | 'welcome_reused'
    | 'entity_subscription_created'
    | 'entity_subscription_reused';
  outbox: DeliveryRecord | null;
  created: boolean;
  requeued: boolean;
}

const PUBLIC_DEBATE_WELCOME_TYPE = 'funky:outbox:welcome';
const PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE = 'funky:outbox:entity_subscription';

const buildWelcomeScopeKey = (): string => 'funky:delivery:welcome';

const buildEntitySubscriptionScopeKey = (entityCui: string): string =>
  `funky:delivery:entity_subscription_${entityCui}`;

const buildWelcomeDeliveryKey = (userId: string): string =>
  `${PUBLIC_DEBATE_WELCOME_TYPE}:${userId}`;

const buildEntitySubscriptionDeliveryKey = (userId: string, entityCui: string): string =>
  `${PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE}:${userId}:${entityCui}`;

const isPendingDirectOutbox = (
  outbox: DeliveryRecord,
  notificationType:
    | typeof PUBLIC_DEBATE_WELCOME_TYPE
    | typeof PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE
): boolean => {
  return outbox.notificationType === notificationType && outbox.status === 'pending';
};

const maybeRequeueExistingOutbox = async (
  deps: EnqueuePublicDebateTermsAcceptedNotificationsDeps,
  input: PublicDebateTermsAcceptedEvent,
  outbox: DeliveryRecord,
  notificationType:
    | typeof PUBLIC_DEBATE_WELCOME_TYPE
    | typeof PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE
): Promise<Result<boolean, DeliveryError>> => {
  if (!isPendingDirectOutbox(outbox, notificationType)) {
    return ok(false);
  }

  const enqueueResult = await deps.composeJobScheduler.enqueue({
    runId: input.runId,
    kind: 'outbox',
    outboxId: outbox.id,
  });

  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  return ok(true);
};

const hasMatchingTriggeringEntity = (
  outbox: DeliveryRecord,
  expectedEntityCui: string
): boolean => {
  return outbox.metadata['entityCui'] === expectedEntityCui;
};

const buildMetadata = (input: PublicDebateTermsAcceptedEvent): Record<string, unknown> => ({
  runId: input.runId,
  campaignKey: input.campaignKey,
  entityCui: input.entityCui,
  entityName: input.entityName,
  acceptedTermsAt: input.acceptedTermsAt,
  source: input.source,
  sourceEventId: input.sourceEventId,
  ...(input.triggerSource !== undefined ? { triggerSource: input.triggerSource } : {}),
  ...(input.triggeredByUserId !== undefined ? { triggeredByUserId: input.triggeredByUserId } : {}),
  ...(input.selectedEntities !== undefined ? { selectedEntities: input.selectedEntities } : {}),
});

const validateInput = (
  input: PublicDebateTermsAcceptedEvent
): Result<PublicDebateTermsAcceptedEvent, DeliveryError> => {
  if (!isNonEmptyString(input.runId)) {
    return err(createValidationError('runId is required'));
  }

  if (!isNonEmptyString(input.source)) {
    return err(createValidationError('source is required'));
  }

  if (!isNonEmptyString(input.sourceEventId)) {
    return err(createValidationError('sourceEventId is required'));
  }

  if (!isNonEmptyString(input.userId)) {
    return err(createValidationError('userId is required'));
  }

  if (!isNonEmptyString(input.entityCui)) {
    return err(createValidationError('entityCui is required'));
  }

  if (!isNonEmptyString(input.entityName)) {
    return err(createValidationError('entityName is required'));
  }

  if (!isNonEmptyString(input.globalPreferenceId)) {
    return err(createValidationError('globalPreferenceId is required'));
  }

  if (!isNonEmptyString(input.entitySubscriptionId)) {
    return err(createValidationError('entitySubscriptionId is required'));
  }

  if (!isNonEmptyString(input.acceptedTermsAt) || Number.isNaN(Date.parse(input.acceptedTermsAt))) {
    return err(createValidationError('acceptedTermsAt must be a valid ISO timestamp'));
  }

  if (
    input.selectedEntities !== undefined &&
    (!Array.isArray(input.selectedEntities) ||
      input.selectedEntities.some((entityName) => !isNonEmptyString(entityName)))
  ) {
    return err(createValidationError('selectedEntities must contain only non-empty strings'));
  }

  return ok(input);
};

const reuseExistingOutbox = async (
  deps: EnqueuePublicDebateTermsAcceptedNotificationsDeps,
  input: PublicDebateTermsAcceptedEvent,
  outbox: DeliveryRecord,
  notificationType:
    | typeof PUBLIC_DEBATE_WELCOME_TYPE
    | typeof PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE,
  status: 'welcome_reused' | 'entity_subscription_reused'
): Promise<Result<EnqueuePublicDebateTermsAcceptedNotificationsResult, DeliveryError>> => {
  const requeueResult = await maybeRequeueExistingOutbox(deps, input, outbox, notificationType);
  if (requeueResult.isErr()) {
    return err(requeueResult.error);
  }

  return ok({
    status,
    outbox,
    created: false,
    requeued: requeueResult.value,
  });
};

const ensureEntitySubscriptionOutbox = async (
  deps: EnqueuePublicDebateTermsAcceptedNotificationsDeps,
  input: PublicDebateTermsAcceptedEvent
): Promise<Result<EnqueuePublicDebateTermsAcceptedNotificationsResult, DeliveryError>> => {
  const deliveryKey = buildEntitySubscriptionDeliveryKey(input.userId, input.entityCui);
  const existingResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  if (existingResult.value !== null) {
    return reuseExistingOutbox(
      deps,
      input,
      existingResult.value,
      PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE,
      'entity_subscription_reused'
    );
  }

  const createResult = await deps.deliveryRepo.create({
    userId: input.userId,
    notificationType: PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE,
    referenceId: input.entitySubscriptionId,
    scopeKey: buildEntitySubscriptionScopeKey(input.entityCui),
    deliveryKey,
    metadata: buildMetadata(input),
  });

  if (createResult.isErr()) {
    if (createResult.error.type === 'DuplicateDelivery') {
      const duplicateResult = await deps.deliveryRepo.findByDeliveryKey(deliveryKey);
      if (duplicateResult.isErr()) {
        return err(duplicateResult.error);
      }

      if (duplicateResult.value !== null) {
        return reuseExistingOutbox(
          deps,
          input,
          duplicateResult.value,
          PUBLIC_DEBATE_ENTITY_SUBSCRIPTION_TYPE,
          'entity_subscription_reused'
        );
      }
    }

    return err(createResult.error);
  }

  const outbox = createResult.value;
  const enqueueResult = await deps.composeJobScheduler.enqueue({
    runId: input.runId,
    kind: 'outbox',
    outboxId: outbox.id,
  });

  if (enqueueResult.isErr()) {
    return err(enqueueResult.error);
  }

  return ok({
    status: 'entity_subscription_created',
    outbox,
    created: true,
    requeued: false,
  });
};

export const enqueuePublicDebateTermsAcceptedNotifications = async (
  deps: EnqueuePublicDebateTermsAcceptedNotificationsDeps,
  rawInput: PublicDebateTermsAcceptedEvent
): Promise<Result<EnqueuePublicDebateTermsAcceptedNotificationsResult, DeliveryError>> => {
  const inputResult = validateInput(rawInput);
  if (inputResult.isErr()) {
    return err(inputResult.error);
  }

  const input = inputResult.value;

  if (!input.globalPreferenceActive || !input.entitySubscriptionActive) {
    return ok({
      status: 'skipped_scope_inactive',
      outbox: null,
      created: false,
      requeued: false,
    });
  }

  const welcomeDeliveryKey = buildWelcomeDeliveryKey(input.userId);
  const existingWelcomeResult = await deps.deliveryRepo.findByDeliveryKey(welcomeDeliveryKey);
  if (existingWelcomeResult.isErr()) {
    return err(existingWelcomeResult.error);
  }

  const existingWelcome = existingWelcomeResult.value;
  if (existingWelcome !== null) {
    if (hasMatchingTriggeringEntity(existingWelcome, input.entityCui)) {
      return reuseExistingOutbox(
        deps,
        input,
        existingWelcome,
        PUBLIC_DEBATE_WELCOME_TYPE,
        'welcome_reused'
      );
    }

    return ensureEntitySubscriptionOutbox(deps, input);
  }

  const createWelcomeResult = await deps.deliveryRepo.create({
    userId: input.userId,
    notificationType: PUBLIC_DEBATE_WELCOME_TYPE,
    referenceId: input.globalPreferenceId,
    scopeKey: buildWelcomeScopeKey(),
    deliveryKey: welcomeDeliveryKey,
    metadata: buildMetadata(input),
  });

  if (createWelcomeResult.isErr()) {
    if (createWelcomeResult.error.type === 'DuplicateDelivery') {
      const duplicateWelcomeResult = await deps.deliveryRepo.findByDeliveryKey(welcomeDeliveryKey);
      if (duplicateWelcomeResult.isErr()) {
        return err(duplicateWelcomeResult.error);
      }

      if (duplicateWelcomeResult.value !== null) {
        if (hasMatchingTriggeringEntity(duplicateWelcomeResult.value, input.entityCui)) {
          return reuseExistingOutbox(
            deps,
            input,
            duplicateWelcomeResult.value,
            PUBLIC_DEBATE_WELCOME_TYPE,
            'welcome_reused'
          );
        }

        return ensureEntitySubscriptionOutbox(deps, input);
      }
    }

    return err(createWelcomeResult.error);
  }

  const welcomeOutbox = createWelcomeResult.value;
  const enqueueWelcomeResult = await deps.composeJobScheduler.enqueue({
    runId: input.runId,
    kind: 'outbox',
    outboxId: welcomeOutbox.id,
  });

  if (enqueueWelcomeResult.isErr()) {
    return err(enqueueWelcomeResult.error);
  }

  return ok({
    status: 'welcome_created',
    outbox: welcomeOutbox,
    created: true,
    requeued: false,
  });
};
