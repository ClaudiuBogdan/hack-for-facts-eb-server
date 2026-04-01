import { err, ok, type Result } from 'neverthrow';

import { createDatabaseError, type NotificationError } from '../errors.js';
import { generateNotificationHash, type Notification } from '../types.js';

import type { Hasher, NotificationsRepository } from '../ports.js';

export interface EnsurePublicDebateAutoSubscriptionsDeps {
  notificationsRepo: NotificationsRepository;
  hasher: Hasher;
}

export interface EnsurePublicDebateAutoSubscriptionsInput {
  userId: string;
  entityCui: string;
}

export interface EnsurePublicDebateAutoSubscriptionsOutput {
  globalPreference: Notification;
  entitySubscription: Notification;
}

const GLOBAL_NOTIFICATION_TYPE = 'campaign_public_debate_global';
const ENTITY_NOTIFICATION_TYPE = 'campaign_public_debate_entity_updates';

const createPublicDebateNotification = async (
  deps: EnsurePublicDebateAutoSubscriptionsDeps,
  input: {
    userId: string;
    notificationType: typeof GLOBAL_NOTIFICATION_TYPE | typeof ENTITY_NOTIFICATION_TYPE;
    entityCui: string | null;
  }
): Promise<Result<Notification, NotificationError>> => {
  const hash = generateNotificationHash(
    deps.hasher,
    input.userId,
    input.notificationType,
    input.entityCui,
    null
  );

  return deps.notificationsRepo.create({
    userId: input.userId,
    notificationType: input.notificationType,
    entityCui: input.entityCui,
    config: null,
    hash,
  });
};

const createOrReloadPreference = async (
  deps: EnsurePublicDebateAutoSubscriptionsDeps,
  input: {
    userId: string;
    notificationType: typeof GLOBAL_NOTIFICATION_TYPE | typeof ENTITY_NOTIFICATION_TYPE;
    entityCui: string | null;
  }
): Promise<Result<Notification, NotificationError>> => {
  const createResult = await createPublicDebateNotification(deps, input);
  if (createResult.isOk()) {
    return createResult;
  }

  const reloadResult = await deps.notificationsRepo.findByUserTypeAndEntity(
    input.userId,
    input.notificationType,
    input.entityCui
  );

  if (reloadResult.isErr()) {
    return err(reloadResult.error);
  }

  if (reloadResult.value !== null) {
    return ok(reloadResult.value);
  }

  return err(createResult.error);
};

const loadGlobalPreference = async (
  deps: EnsurePublicDebateAutoSubscriptionsDeps,
  userId: string
): Promise<Result<Notification, NotificationError>> => {
  const existingResult = await deps.notificationsRepo.findByUserTypeAndEntity(
    userId,
    GLOBAL_NOTIFICATION_TYPE,
    null
  );

  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  if (existingResult.value !== null) {
    return ok(existingResult.value);
  }

  return createOrReloadPreference(deps, {
    userId,
    notificationType: GLOBAL_NOTIFICATION_TYPE,
    entityCui: null,
  });
};

const loadEntitySubscription = async (
  deps: EnsurePublicDebateAutoSubscriptionsDeps,
  input: {
    userId: string;
    entityCui: string;
    shouldBeActive: boolean;
  }
): Promise<Result<Notification, NotificationError>> => {
  const existingResult = await deps.notificationsRepo.findByUserTypeAndEntity(
    input.userId,
    ENTITY_NOTIFICATION_TYPE,
    input.entityCui
  );

  if (existingResult.isErr()) {
    return err(existingResult.error);
  }

  let entitySubscription = existingResult.value;
  if (entitySubscription === null) {
    const createResult = await createOrReloadPreference(deps, {
      userId: input.userId,
      notificationType: ENTITY_NOTIFICATION_TYPE,
      entityCui: input.entityCui,
    });

    if (createResult.isErr()) {
      return err(createResult.error);
    }

    entitySubscription = createResult.value;
  }

  if (entitySubscription.isActive === input.shouldBeActive) {
    return ok(entitySubscription);
  }

  const updateResult = await deps.notificationsRepo.update(entitySubscription.id, {
    isActive: input.shouldBeActive,
  });

  if (updateResult.isErr()) {
    return err(updateResult.error);
  }

  return ok(updateResult.value);
};

export async function ensurePublicDebateAutoSubscriptions(
  deps: EnsurePublicDebateAutoSubscriptionsDeps,
  input: EnsurePublicDebateAutoSubscriptionsInput
): Promise<Result<EnsurePublicDebateAutoSubscriptionsOutput, NotificationError>> {
  const globalPreferenceResult = await loadGlobalPreference(deps, input.userId);
  if (globalPreferenceResult.isErr()) {
    return err(
      createDatabaseError(
        'Failed to load or create public debate global preference',
        globalPreferenceResult.error
      )
    );
  }

  const entitySubscriptionResult = await loadEntitySubscription(deps, {
    userId: input.userId,
    entityCui: input.entityCui,
    shouldBeActive: globalPreferenceResult.value.isActive,
  });

  if (entitySubscriptionResult.isErr()) {
    return err(
      createDatabaseError(
        'Failed to load or create public debate entity subscription',
        entitySubscriptionResult.error
      )
    );
  }

  return ok({
    globalPreference: globalPreferenceResult.value,
    entitySubscription: entitySubscriptionResult.value,
  });
}
