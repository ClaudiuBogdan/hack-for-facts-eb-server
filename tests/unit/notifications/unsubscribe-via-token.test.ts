/**
 * Unit tests for unsubscribe-via-token use case
 *
 * Tests cover:
 * - Token not found handling
 * - Expired token handling
 * - Already used token handling
 * - Successful unsubscribe
 * - Notification deactivation
 * - Token marked as used
 */

import { describe, expect, it } from 'vitest';

import { unsubscribeViaToken } from '@/modules/notifications/core/usecases/unsubscribe-via-token.js';

import {
  makeFakeNotificationsRepo,
  makeFakeUnsubscribeTokensRepo,
  createTestNotification,
  createTestUnsubscribeToken,
} from '../../fixtures/fakes.js';

describe('unsubscribeViaToken use case', () => {
  const now = new Date();

  describe('token validation', () => {
    it('returns TokenNotFoundError when token does not exist', async () => {
      const notificationsRepo = makeFakeNotificationsRepo();
      const tokensRepo = makeFakeUnsubscribeTokensRepo();

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'a'.repeat(64), now }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('TokenNotFoundError');
      }
    });

    it('returns TokenInvalidError when token is expired', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });

      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 2);

      const expiredToken = createTestUnsubscribeToken({
        token: 'a'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
        expiresAt: pastDate, // Expired
        usedAt: null,
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [expiredToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'a'.repeat(64), now }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('TokenInvalidError');
        expect(result.error.message).toContain('expired');
      }
    });

    it('returns TokenInvalidError when token is already used', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });

      const usedToken = createTestUnsubscribeToken({
        token: 'b'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
        usedAt: new Date(), // Already used
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [usedToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'b'.repeat(64), now }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('TokenInvalidError');
      }
    });
  });

  describe('notification validation', () => {
    it('returns NotificationNotFoundError when notification does not exist', async () => {
      const validToken = createTestUnsubscribeToken({
        token: 'c'.repeat(64),
        userId: 'user-1',
        notificationId: 'nonexistent-notification',
      });

      const notificationsRepo = makeFakeNotificationsRepo();
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'c'.repeat(64), now }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('NotificationNotFoundError');
      }
    });
  });

  describe('successful unsubscribe', () => {
    it('deactivates active notification', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });

      const validToken = createTestUnsubscribeToken({
        token: 'd'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'd'.repeat(64), now }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.notification.isActive).toBe(false);
        expect(result.value.notification.id).toBe('notification-1');
        expect(result.value.tokenMarkingFailed).toBe(false);
      }
    });

    it('handles already inactive notification', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: false, // Already inactive
      });

      const validToken = createTestUnsubscribeToken({
        token: 'e'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'e'.repeat(64), now }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.notification.isActive).toBe(false);
      }
    });

    it('works for newsletter subscriptions', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        entityCui: '1234567',
        isActive: true,
      });

      const validToken = createTestUnsubscribeToken({
        token: 'f'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'f'.repeat(64), now }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.notification.notificationType).toBe('newsletter_entity_monthly');
      }
    });

    it('works for alert subscriptions', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: {
          title: 'Test',
          conditions: [],
          datasetId: 'test-dataset',
        },
        isActive: true,
      });

      const validToken = createTestUnsubscribeToken({
        token: 'g'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'g'.repeat(64), now }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.notification.notificationType).toBe('alert_series_static');
      }
    });
  });

  describe('token marking', () => {
    it('marks token as used after successful unsubscribe', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });

      const validToken = createTestUnsubscribeToken({
        token: 'h'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
        usedAt: null,
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      await unsubscribeViaToken({ notificationsRepo, tokensRepo }, { token: 'h'.repeat(64), now });

      // Check token is marked as used
      const tokenResult = await tokensRepo.findByToken('h'.repeat(64));
      expect(tokenResult.isOk()).toBe(true);
      if (tokenResult.isOk()) {
        expect(tokenResult.value?.usedAt).not.toBeNull();
      }
    });

    it('token cannot be reused after unsubscribe', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });

      const validToken = createTestUnsubscribeToken({
        token: 'i'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
        usedAt: null,
      });

      const notificationsRepo = makeFakeNotificationsRepo({ notifications: [notification] });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      // First unsubscribe
      const result1 = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'i'.repeat(64), now }
      );
      expect(result1.isOk()).toBe(true);

      // Try to use same token again
      const result2 = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'i'.repeat(64), now }
      );
      expect(result2.isErr()).toBe(true);
      if (result2.isErr()) {
        expect(result2.error.type).toBe('TokenInvalidError');
      }
    });
  });

  describe('database error handling', () => {
    it('propagates database errors from tokens repo', async () => {
      const notificationsRepo = makeFakeNotificationsRepo();
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ simulateDbError: true });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'j'.repeat(64), now }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });

    it('propagates database errors from notifications repo', async () => {
      const validToken = createTestUnsubscribeToken({
        token: 'k'.repeat(64),
        userId: 'user-1',
        notificationId: 'notification-1',
      });

      const notificationsRepo = makeFakeNotificationsRepo({ simulateDbError: true });
      const tokensRepo = makeFakeUnsubscribeTokensRepo({ tokens: [validToken] });

      const result = await unsubscribeViaToken(
        { notificationsRepo, tokensRepo },
        { token: 'k'.repeat(64), now }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });
  });
});
