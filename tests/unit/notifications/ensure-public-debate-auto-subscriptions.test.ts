import { err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  ensurePublicDebateAutoSubscriptions,
  sha256Hasher,
} from '@/modules/notifications/index.js';

import { createTestNotification, makeFakeNotificationsRepo } from '../../fixtures/fakes.js';

describe('ensurePublicDebateAutoSubscriptions', () => {
  it('creates active global and entity subscriptions when none exist', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();

    const result = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.globalPreference.notificationType).toBe('funky:notification:global');
      expect(result.value.globalPreference.isActive).toBe(true);
      expect(result.value.entitySubscription.notificationType).toBe(
        'funky:notification:entity_updates'
      );
      expect(result.value.entitySubscription.isActive).toBe(true);
    }
  });

  it('preserves an inactive global preference and keeps the entity subscription inactive', async () => {
    const globalPreference = createTestNotification({
      id: 'notif-global',
      userId: 'user-1',
      notificationType: 'funky:notification:global',
      entityCui: null,
      isActive: false,
    });
    const entitySubscription = createTestNotification({
      id: 'notif-entity',
      userId: 'user-1',
      notificationType: 'funky:notification:entity_updates',
      entityCui: '12345678',
      isActive: true,
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [globalPreference, entitySubscription],
    });

    const result = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.globalPreference.id).toBe('notif-global');
      expect(result.value.globalPreference.isActive).toBe(false);
      expect(result.value.entitySubscription.id).toBe('notif-entity');
      expect(result.value.entitySubscription.isActive).toBe(false);
    }
  });

  it('reloads the global preference when create loses the race', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const originalCreate = notificationsRepo.create.bind(notificationsRepo);
    let lostRace = false;

    notificationsRepo.create = async (input) => {
      if (!lostRace && input.notificationType === 'funky:notification:global') {
        lostRace = true;
        const inserted = await originalCreate(input);
        if (inserted.isErr()) {
          return inserted;
        }

        return err({
          type: 'DatabaseError',
          message: 'duplicate key value violates unique constraint',
          retryable: true,
        });
      }

      return originalCreate(input);
    };

    const result = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.globalPreference.notificationType).toBe('funky:notification:global');
      expect(result.value.globalPreference.isActive).toBe(true);
    }
  });

  it('reloads the entity subscription when create loses the race', async () => {
    const globalPreference = createTestNotification({
      id: 'notif-global',
      userId: 'user-1',
      notificationType: 'funky:notification:global',
      entityCui: null,
      isActive: true,
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [globalPreference],
    });
    const originalCreate = notificationsRepo.create.bind(notificationsRepo);
    let lostRace = false;

    notificationsRepo.create = async (input) => {
      if (!lostRace && input.notificationType === 'funky:notification:entity_updates') {
        lostRace = true;
        const inserted = await originalCreate(input);
        if (inserted.isErr()) {
          return inserted;
        }

        return err({
          type: 'DatabaseError',
          message: 'duplicate key value violates unique constraint',
          retryable: true,
        });
      }

      return originalCreate(input);
    };

    const result = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.globalPreference.id).toBe('notif-global');
      expect(result.value.entitySubscription.notificationType).toBe(
        'funky:notification:entity_updates'
      );
      expect(result.value.entitySubscription.entityCui).toBe('12345678');
      expect(result.value.entitySubscription.isActive).toBe(true);
    }
  });

  it('updates a reloaded entity subscription to match the global preference state', async () => {
    const globalPreference = createTestNotification({
      id: 'notif-global',
      userId: 'user-1',
      notificationType: 'funky:notification:global',
      entityCui: null,
      isActive: false,
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [globalPreference],
    });
    const originalCreate = notificationsRepo.create.bind(notificationsRepo);
    const originalUpdate = notificationsRepo.update.bind(notificationsRepo);
    let lostRace = false;
    let updateCount = 0;

    notificationsRepo.create = async (input) => {
      if (!lostRace && input.notificationType === 'funky:notification:entity_updates') {
        lostRace = true;
        const inserted = await originalCreate(input);
        if (inserted.isErr()) {
          return inserted;
        }

        return err({
          type: 'DatabaseError',
          message: 'duplicate key value violates unique constraint',
          retryable: true,
        });
      }

      return originalCreate(input);
    };

    notificationsRepo.update = async (id, input) => {
      updateCount += 1;
      return originalUpdate(id, input);
    };

    const result = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    expect(result.isOk()).toBe(true);
    expect(updateCount).toBe(1);
    if (result.isOk()) {
      expect(result.value.globalPreference.isActive).toBe(false);
      expect(result.value.entitySubscription.isActive).toBe(false);
    }
  });

  it('returns the create failure when reload finds no winner', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const failure = {
      type: 'DatabaseError' as const,
      message: 'duplicate key value violates unique constraint',
      retryable: true,
    };
    const originalCreate = notificationsRepo.create.bind(notificationsRepo);

    notificationsRepo.create = async (input) => {
      if (input.notificationType === 'funky:notification:global') {
        return err(failure);
      }

      return originalCreate(input);
    };

    const result = await ensurePublicDebateAutoSubscriptions(
      {
        notificationsRepo,
        hasher: sha256Hasher,
      },
      {
        userId: 'user-1',
        entityCui: '12345678',
      }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('DatabaseError');
      expect(result.error.message).toBe('Failed to load or create public debate global preference');
      if (result.error.type === 'DatabaseError') {
        expect(result.error.cause).toBe(failure);
      }
    }
  });
});
