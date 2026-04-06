import { randomUUID } from 'crypto';

import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import {
  generateNotificationHash,
  makeNotificationsRepo,
  sha256Hasher,
} from '@/modules/notifications/index.js';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

describe('Notifications repository', () => {
  it('updates the campaign master preference and entity subscriptions in one transaction', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    const userId = `campaign-user-${randomUUID()}`;
    const globalPreferenceResult = await repo.create({
      userId,
      notificationType: 'funky:notification:global',
      entityCui: null,
      config: null,
      hash: generateNotificationHash(sha256Hasher, userId, 'funky:notification:global', null, null),
    });
    const campaignEntityOneResult = await repo.create({
      userId,
      notificationType: 'funky:notification:entity_updates',
      entityCui: '12345678',
      config: null,
      hash: generateNotificationHash(
        sha256Hasher,
        userId,
        'funky:notification:entity_updates',
        '12345678',
        null
      ),
    });
    const campaignEntityTwoResult = await repo.create({
      userId,
      notificationType: 'funky:notification:entity_updates',
      entityCui: '87654321',
      config: null,
      hash: generateNotificationHash(
        sha256Hasher,
        userId,
        'funky:notification:entity_updates',
        '87654321',
        null
      ),
    });
    const unrelatedNotificationResult = await repo.create({
      userId,
      notificationType: 'newsletter_entity_monthly',
      entityCui: '12345678',
      config: null,
      hash: generateNotificationHash(
        sha256Hasher,
        userId,
        'newsletter_entity_monthly',
        '12345678',
        null
      ),
    });

    expect(globalPreferenceResult.isOk()).toBe(true);
    expect(campaignEntityOneResult.isOk()).toBe(true);
    expect(campaignEntityTwoResult.isOk()).toBe(true);
    expect(unrelatedNotificationResult.isOk()).toBe(true);

    if (
      globalPreferenceResult.isErr() ||
      campaignEntityOneResult.isErr() ||
      campaignEntityTwoResult.isErr() ||
      unrelatedNotificationResult.isErr()
    ) {
      return;
    }

    const disableResult = await repo.updateCampaignGlobalPreference(
      globalPreferenceResult.value.id,
      {
        isActive: false,
      }
    );

    expect(disableResult.isOk()).toBe(true);
    if (disableResult.isOk()) {
      expect(disableResult.value.isActive).toBe(false);
    }

    const disabledEntityOne = await repo.findById(campaignEntityOneResult.value.id);
    const disabledEntityTwo = await repo.findById(campaignEntityTwoResult.value.id);
    const disabledUnrelated = await repo.findById(unrelatedNotificationResult.value.id);

    expect(disabledEntityOne.isOk()).toBe(true);
    expect(disabledEntityTwo.isOk()).toBe(true);
    expect(disabledUnrelated.isOk()).toBe(true);

    if (disabledEntityOne.isOk()) {
      expect(disabledEntityOne.value?.isActive).toBe(false);
    }
    if (disabledEntityTwo.isOk()) {
      expect(disabledEntityTwo.value?.isActive).toBe(false);
    }
    if (disabledUnrelated.isOk()) {
      expect(disabledUnrelated.value?.isActive).toBe(true);
    }

    const enableResult = await repo.updateCampaignGlobalPreference(
      globalPreferenceResult.value.id,
      {
        isActive: true,
      }
    );

    expect(enableResult.isOk()).toBe(true);
    if (enableResult.isOk()) {
      expect(enableResult.value.isActive).toBe(true);
    }

    const enabledEntityOne = await repo.findById(campaignEntityOneResult.value.id);
    const enabledEntityTwo = await repo.findById(campaignEntityTwoResult.value.id);
    const enabledUnrelated = await repo.findById(unrelatedNotificationResult.value.id);

    expect(enabledEntityOne.isOk()).toBe(true);
    expect(enabledEntityTwo.isOk()).toBe(true);
    expect(enabledUnrelated.isOk()).toBe(true);

    if (enabledEntityOne.isOk()) {
      expect(enabledEntityOne.value?.isActive).toBe(true);
    }
    if (enabledEntityTwo.isOk()) {
      expect(enabledEntityTwo.value?.isActive).toBe(true);
    }
    if (enabledUnrelated.isOk()) {
      expect(enabledUnrelated.value?.isActive).toBe(true);
    }
  });
});
