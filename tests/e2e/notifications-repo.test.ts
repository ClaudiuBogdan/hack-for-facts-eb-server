import { randomUUID } from 'crypto';

import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { PUBLIC_DEBATE_CAMPAIGN_KEY } from '@/common/campaign-keys.js';
import {
  generateNotificationHash,
  makeNotificationsRepo,
  sha256Hasher,
} from '@/modules/notifications/index.js';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

class RecordingCampaignSubscriptionStatsInvalidator {
  readonly invalidatedCampaignIds: string[] = [];
  invalidateAllCalls = 0;

  async invalidateCampaign(campaignId: string): Promise<void> {
    this.invalidatedCampaignIds.push(campaignId);
  }

  async invalidateAll(): Promise<void> {
    this.invalidateAllCalls += 1;
  }
}

describe('Notifications repository', () => {
  it('invalidates public campaign stats cache when creating a public debate entity subscription', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const invalidator = new RecordingCampaignSubscriptionStatsInvalidator();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
      campaignSubscriptionStatsInvalidator: invalidator,
    });

    const userId = `entity-subscription-user-${randomUUID()}`;
    const createResult = await repo.create({
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

    expect(createResult.isOk()).toBe(true);
    expect(invalidator.invalidatedCampaignIds).toEqual([PUBLIC_DEBATE_CAMPAIGN_KEY]);
    expect(invalidator.invalidateAllCalls).toBe(0);
  });

  it('does not invalidate public campaign stats cache for unrelated subscriptions', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const invalidator = new RecordingCampaignSubscriptionStatsInvalidator();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
      campaignSubscriptionStatsInvalidator: invalidator,
    });

    const userId = `newsletter-user-${randomUUID()}`;
    const createResult = await repo.create({
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

    expect(createResult.isOk()).toBe(true);
    expect(invalidator.invalidatedCampaignIds).toEqual([]);
    expect(invalidator.invalidateAllCalls).toBe(0);
  });

  it('invalidates all public campaign stats cache entries for global unsubscribe changes', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const invalidator = new RecordingCampaignSubscriptionStatsInvalidator();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
      campaignSubscriptionStatsInvalidator: invalidator,
    });

    const userId = `global-unsubscribe-user-${randomUUID()}`;
    const deactivateResult = await repo.deactivateGlobalUnsubscribe(userId);

    expect(deactivateResult.isOk()).toBe(true);
    expect(invalidator.invalidatedCampaignIds).toEqual([]);
    expect(invalidator.invalidateAllCalls).toBe(1);
  });

  it('deactivates global unsubscribe and all user preferences in one transaction', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    const userId = `global-cascade-user-${randomUUID()}`;
    const otherUserId = `global-cascade-other-user-${randomUUID()}`;
    const campaignGlobalResult = await repo.create({
      userId,
      notificationType: 'funky:notification:global',
      entityCui: null,
      config: null,
      hash: generateNotificationHash(sha256Hasher, userId, 'funky:notification:global', null, null),
    });
    const entityUpdatesResult = await repo.create({
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
    const newsletterResult = await repo.create({
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
    const otherUserResult = await repo.create({
      userId: otherUserId,
      notificationType: 'newsletter_entity_monthly',
      entityCui: '12345678',
      config: null,
      hash: generateNotificationHash(
        sha256Hasher,
        otherUserId,
        'newsletter_entity_monthly',
        '12345678',
        null
      ),
    });

    expect(campaignGlobalResult.isOk()).toBe(true);
    expect(entityUpdatesResult.isOk()).toBe(true);
    expect(newsletterResult.isOk()).toBe(true);
    expect(otherUserResult.isOk()).toBe(true);
    if (
      campaignGlobalResult.isErr() ||
      entityUpdatesResult.isErr() ||
      newsletterResult.isErr() ||
      otherUserResult.isErr()
    ) {
      return;
    }

    const deactivateResult = await repo.deactivateGlobalUnsubscribe(userId);
    expect(deactivateResult.isOk()).toBe(true);

    const campaignGlobal = await repo.findById(campaignGlobalResult.value.id);
    const entityUpdates = await repo.findById(entityUpdatesResult.value.id);
    const newsletter = await repo.findById(newsletterResult.value.id);
    const otherUserNewsletter = await repo.findById(otherUserResult.value.id);
    const globalUnsubscribe = await repo.findByUserTypeAndEntity(
      userId,
      'global_unsubscribe',
      null
    );

    expect(campaignGlobal.isOk()).toBe(true);
    expect(entityUpdates.isOk()).toBe(true);
    expect(newsletter.isOk()).toBe(true);
    expect(otherUserNewsletter.isOk()).toBe(true);
    expect(globalUnsubscribe.isOk()).toBe(true);
    if (campaignGlobal.isOk()) {
      expect(campaignGlobal.value?.isActive).toBe(false);
    }
    if (entityUpdates.isOk()) {
      expect(entityUpdates.value?.isActive).toBe(false);
    }
    if (newsletter.isOk()) {
      expect(newsletter.value?.isActive).toBe(false);
    }
    if (otherUserNewsletter.isOk()) {
      expect(otherUserNewsletter.value?.isActive).toBe(true);
    }
    if (globalUnsubscribe.isOk()) {
      expect(globalUnsubscribe.value?.isActive).toBe(false);
      expect(globalUnsubscribe.value?.config).toEqual({ channels: { email: false } });
    }
  });

  it('disables campaign child preferences only when disabling the campaign master', async () => {
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
    const unrelatedNewsletterResult = await repo.create({
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
    const unrelatedAlertConfig = {
      title: 'Static alert',
      conditions: [],
      datasetId: 'ro.economics.cpi.yearly',
    };
    const unrelatedAlertResult = await repo.create({
      userId,
      notificationType: 'alert_series_static',
      entityCui: null,
      config: unrelatedAlertConfig,
      hash: generateNotificationHash(
        sha256Hasher,
        userId,
        'alert_series_static',
        null,
        unrelatedAlertConfig
      ),
    });
    const systemGlobalResult = await repo.create({
      userId,
      notificationType: 'global_unsubscribe',
      entityCui: null,
      config: { channels: { email: true } },
      hash: generateNotificationHash(sha256Hasher, userId, 'global_unsubscribe', null, {
        channels: { email: true },
      }),
    });

    expect(globalPreferenceResult.isOk()).toBe(true);
    expect(campaignEntityOneResult.isOk()).toBe(true);
    expect(campaignEntityTwoResult.isOk()).toBe(true);
    expect(unrelatedNewsletterResult.isOk()).toBe(true);
    expect(unrelatedAlertResult.isOk()).toBe(true);
    expect(systemGlobalResult.isOk()).toBe(true);

    if (
      globalPreferenceResult.isErr() ||
      campaignEntityOneResult.isErr() ||
      campaignEntityTwoResult.isErr() ||
      unrelatedNewsletterResult.isErr() ||
      unrelatedAlertResult.isErr() ||
      systemGlobalResult.isErr()
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
    const disabledNewsletter = await repo.findById(unrelatedNewsletterResult.value.id);
    const disabledAlert = await repo.findById(unrelatedAlertResult.value.id);
    const disabledSystemGlobal = await repo.findById(systemGlobalResult.value.id);

    expect(disabledEntityOne.isOk()).toBe(true);
    expect(disabledEntityTwo.isOk()).toBe(true);
    expect(disabledNewsletter.isOk()).toBe(true);
    expect(disabledAlert.isOk()).toBe(true);
    expect(disabledSystemGlobal.isOk()).toBe(true);

    if (disabledEntityOne.isOk()) {
      expect(disabledEntityOne.value?.isActive).toBe(false);
    }
    if (disabledEntityTwo.isOk()) {
      expect(disabledEntityTwo.value?.isActive).toBe(false);
    }
    if (disabledNewsletter.isOk()) {
      expect(disabledNewsletter.value?.isActive).toBe(true);
    }
    if (disabledAlert.isOk()) {
      expect(disabledAlert.value?.isActive).toBe(true);
    }
    if (disabledSystemGlobal.isOk()) {
      expect(disabledSystemGlobal.value?.isActive).toBe(true);
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
    const enabledNewsletter = await repo.findById(unrelatedNewsletterResult.value.id);

    expect(enabledEntityOne.isOk()).toBe(true);
    expect(enabledEntityTwo.isOk()).toBe(true);
    expect(enabledNewsletter.isOk()).toBe(true);

    if (enabledEntityOne.isOk()) {
      expect(enabledEntityOne.value?.isActive).toBe(false);
    }
    if (enabledEntityTwo.isOk()) {
      expect(enabledEntityTwo.value?.isActive).toBe(false);
    }
    if (enabledNewsletter.isOk()) {
      expect(enabledNewsletter.value?.isActive).toBe(true);
    }
  });

  it('manual newsletter opt-in clears system unsubscribe without enabling campaign global', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    const userId = `manual-newsletter-user-${randomUUID()}`;
    const campaignGlobalResult = await repo.create({
      userId,
      notificationType: 'funky:notification:global',
      entityCui: null,
      config: null,
      hash: generateNotificationHash(sha256Hasher, userId, 'funky:notification:global', null, null),
    });

    expect(campaignGlobalResult.isOk()).toBe(true);
    if (campaignGlobalResult.isErr()) {
      return;
    }

    const deactivateCampaignGlobalResult = await repo.updateCampaignGlobalPreference(
      campaignGlobalResult.value.id,
      { isActive: false }
    );
    const deactivateSystemGlobalResult = await repo.deactivateGlobalUnsubscribe(userId);

    expect(deactivateCampaignGlobalResult.isOk()).toBe(true);
    expect(deactivateSystemGlobalResult.isOk()).toBe(true);

    const newsletterResult = await repo.createWithManualOptIn({
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

    expect(newsletterResult.isOk()).toBe(true);

    const globalUnsubscribe = await repo.findByUserTypeAndEntity(
      userId,
      'global_unsubscribe',
      null
    );
    const campaignGlobal = await repo.findById(campaignGlobalResult.value.id);

    expect(globalUnsubscribe.isOk()).toBe(true);
    expect(campaignGlobal.isOk()).toBe(true);
    if (globalUnsubscribe.isOk()) {
      expect(globalUnsubscribe.value?.isActive).toBe(true);
      expect(globalUnsubscribe.value?.config).toEqual({ channels: { email: true } });
    }
    if (campaignGlobal.isOk()) {
      expect(campaignGlobal.value?.isActive).toBe(false);
    }
  });

  it('manual campaign child opt-in clears system unsubscribe and enables campaign global only', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeNotificationsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    const userId = `manual-campaign-child-user-${randomUUID()}`;
    const campaignGlobalResult = await repo.create({
      userId,
      notificationType: 'funky:notification:global',
      entityCui: null,
      config: null,
      hash: generateNotificationHash(sha256Hasher, userId, 'funky:notification:global', null, null),
    });
    const entityOneResult = await repo.create({
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
    const entityTwoResult = await repo.create({
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

    expect(campaignGlobalResult.isOk()).toBe(true);
    expect(entityOneResult.isOk()).toBe(true);
    expect(entityTwoResult.isOk()).toBe(true);
    if (campaignGlobalResult.isErr() || entityOneResult.isErr() || entityTwoResult.isErr()) {
      return;
    }

    const deactivateResult = await repo.deactivateGlobalUnsubscribe(userId);
    expect(deactivateResult.isOk()).toBe(true);

    const optInResult = await repo.updateWithManualOptIn(entityOneResult.value.id, {
      isActive: true,
    });
    expect(optInResult.isOk()).toBe(true);

    const globalUnsubscribe = await repo.findByUserTypeAndEntity(
      userId,
      'global_unsubscribe',
      null
    );
    const campaignGlobal = await repo.findById(campaignGlobalResult.value.id);
    const entityOne = await repo.findById(entityOneResult.value.id);
    const entityTwo = await repo.findById(entityTwoResult.value.id);

    expect(globalUnsubscribe.isOk()).toBe(true);
    expect(campaignGlobal.isOk()).toBe(true);
    expect(entityOne.isOk()).toBe(true);
    expect(entityTwo.isOk()).toBe(true);

    if (globalUnsubscribe.isOk()) {
      expect(globalUnsubscribe.value?.isActive).toBe(true);
      expect(globalUnsubscribe.value?.config).toEqual({ channels: { email: true } });
    }
    if (campaignGlobal.isOk()) {
      expect(campaignGlobal.value?.isActive).toBe(true);
    }
    if (entityOne.isOk()) {
      expect(entityOne.value?.isActive).toBe(true);
    }
    if (entityTwo.isOk()) {
      expect(entityTwo.value?.isActive).toBe(false);
    }
  });
});
