import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { sha256Hasher } from '@/modules/notifications/index.js';
import { makeEntityTermsAcceptedSyncHandler } from '@/modules/user-events/index.js';

import {
  createTestInteractiveUpdatedEvent,
  createTestNotification,
  makeFakeNotificationsRepo,
} from '../../fixtures/fakes.js';

describe('makeEntityTermsAcceptedSyncHandler', () => {
  it('creates or enables the global and entity campaign notifications', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const handler = makeEntityTermsAcceptedSyncHandler({
      notificationsRepo,
      hasher: sha256Hasher,
      logger: pinoLogger({ level: 'silent' }),
    });

    const event = createTestInteractiveUpdatedEvent({
      payload: {
        record: {
          key: 'system:campaign:buget:accepted-terms:entity:12345678',
          interactionId: 'system:campaign:buget:accepted-terms:entity:12345678',
          lessonId: 'system:campaign:buget:state',
          kind: 'custom',
          scope: { type: 'global' },
          completionRule: { type: 'resolved' },
          phase: 'resolved',
          value: {
            kind: 'json',
            json: {
              value: {
                entityCui: '12345678',
                acceptedTermsAt: '2026-03-31T10:00:00.000Z',
              },
            },
          },
          result: null,
          updatedAt: '2026-03-31T10:00:00.000Z',
          submittedAt: null,
        },
      },
    });

    await handler.handle({
      userId: 'user-1',
      event,
    });

    const userNotificationsResult = await notificationsRepo.findByUserId('user-1', false);
    expect(userNotificationsResult.isOk()).toBe(true);
    if (userNotificationsResult.isOk()) {
      expect(
        userNotificationsResult.value.map((notification) => notification.notificationType).sort()
      ).toEqual(['campaign_public_debate_entity_updates', 'campaign_public_debate_global'].sort());
    }
  });

  it('preserves a disabled global preference and keeps the entity subscription inactive', async () => {
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [
        createTestNotification({
          id: 'notif-global',
          userId: 'user-1',
          notificationType: 'campaign_public_debate_global',
          entityCui: null,
          isActive: false,
        }),
      ],
    });
    const handler = makeEntityTermsAcceptedSyncHandler({
      notificationsRepo,
      hasher: sha256Hasher,
      logger: pinoLogger({ level: 'silent' }),
    });

    const event = createTestInteractiveUpdatedEvent({
      payload: {
        record: {
          key: 'system:campaign:buget:accepted-terms:entity:12345678',
          interactionId: 'system:campaign:buget:accepted-terms:entity:12345678',
          lessonId: 'system:campaign:buget:state',
          kind: 'custom',
          scope: { type: 'global' },
          completionRule: { type: 'resolved' },
          phase: 'resolved',
          value: {
            kind: 'json',
            json: {
              value: {
                entityCui: '12345678',
                acceptedTermsAt: '2026-03-31T10:00:00.000Z',
              },
            },
          },
          result: null,
          updatedAt: '2026-03-31T10:00:00.000Z',
          submittedAt: null,
        },
      },
    });

    await handler.handle({
      userId: 'user-1',
      event,
    });

    const globalResult = await notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'campaign_public_debate_global',
      null
    );
    const entityResult = await notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'campaign_public_debate_entity_updates',
      '12345678'
    );

    expect(globalResult.isOk()).toBe(true);
    expect(entityResult.isOk()).toBe(true);
    if (globalResult.isOk() && entityResult.isOk()) {
      expect(globalResult.value?.isActive).toBe(false);
      expect(entityResult.value?.isActive).toBe(false);
    }
  });
});
