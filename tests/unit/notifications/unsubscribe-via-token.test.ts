/**
 * Unit tests for unsubscribe-via-token use case (HMAC flow)
 *
 * Tests cover:
 * - Invalid/tampered token handling
 * - Successful unsubscribe via valid HMAC token
 * - Idempotent behavior (calling twice succeeds both times)
 */

import { describe, expect, it } from 'vitest';

import { unsubscribeViaToken } from '@/modules/notifications/core/usecases/unsubscribe-via-token.js';

import {
  createTestNotification,
  makeFakeNotificationsRepo,
  makeFakeTokenSigner,
} from '../../fixtures/fakes.js';

describe('unsubscribeViaToken use case', () => {
  const tokenSigner = makeFakeTokenSigner();

  it('returns TokenInvalidError for invalid/tampered token', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();

    const result = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: 'invalid-token-garbage' }
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('TokenInvalidError');
    }
  });

  it('returns success and calls deactivateGlobalUnsubscribe for valid token', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const signedToken = tokenSigner.sign('user-1');

    const result = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.userId).toBe('user-1');
    }
  });

  it('deactivates all preferences for the unsubscribed user only', async () => {
    const campaignGlobal = createTestNotification({
      id: 'campaign-global',
      userId: 'user-1',
      notificationType: 'funky:notification:global',
      entityCui: null,
      isActive: true,
    });
    const entityUpdates = createTestNotification({
      id: 'entity-updates',
      userId: 'user-1',
      notificationType: 'funky:notification:entity_updates',
      entityCui: '1234567',
      isActive: true,
    });
    const newsletter = createTestNotification({
      id: 'newsletter',
      userId: 'user-1',
      notificationType: 'newsletter_entity_monthly',
      entityCui: '1234567',
      isActive: true,
    });
    const alert = createTestNotification({
      id: 'alert',
      userId: 'user-1',
      notificationType: 'alert_series_static',
      config: {
        title: 'Static alert',
        conditions: [],
        datasetId: 'ro.economics.cpi.yearly',
      },
      isActive: true,
    });
    const otherUserNewsletter = createTestNotification({
      id: 'other-user-newsletter',
      userId: 'user-2',
      notificationType: 'newsletter_entity_monthly',
      entityCui: '1234567',
      isActive: true,
    });
    const notificationsRepo = makeFakeNotificationsRepo({
      notifications: [campaignGlobal, entityUpdates, newsletter, alert, otherUserNewsletter],
    });
    const signedToken = tokenSigner.sign('user-1');

    const result = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );

    expect(result.isOk()).toBe(true);

    for (const notification of [campaignGlobal, entityUpdates, newsletter, alert]) {
      const stored = await notificationsRepo.findById(notification.id);
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.isActive).toBe(false);
      }
    }

    const globalUnsubscribe = await notificationsRepo.findByUserTypeAndEntity(
      'user-1',
      'global_unsubscribe',
      null
    );
    const otherUserStored = await notificationsRepo.findById(otherUserNewsletter.id);
    expect(globalUnsubscribe.isOk()).toBe(true);
    expect(otherUserStored.isOk()).toBe(true);
    if (globalUnsubscribe.isOk()) {
      expect(globalUnsubscribe.value?.isActive).toBe(false);
      expect(globalUnsubscribe.value?.config).toEqual({ channels: { email: false } });
    }
    if (otherUserStored.isOk()) {
      expect(otherUserStored.value?.isActive).toBe(true);
    }
  });

  it('is idempotent (calling twice returns success both times)', async () => {
    const notificationsRepo = makeFakeNotificationsRepo();
    const signedToken = tokenSigner.sign('user-1');

    const result1 = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );
    expect(result1.isOk()).toBe(true);

    const result2 = await unsubscribeViaToken(
      { notificationsRepo, tokenSigner },
      { token: signedToken }
    );
    expect(result2.isOk()).toBe(true);
    if (result2.isOk()) {
      expect(result2.value.userId).toBe('user-1');
    }
  });
});
