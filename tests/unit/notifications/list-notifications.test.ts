/**
 * Unit tests for list-notifications use cases
 *
 * Tests cover:
 * - listUserNotifications: returns all/active-only notifications for a user
 * - listEntityNotifications: returns user's notifications for a specific entity
 * - Empty results handling
 * - Database error propagation
 */

import { describe, expect, it } from 'vitest';

import {
  listUserNotifications,
  listEntityNotifications,
} from '@/modules/notifications/core/usecases/list-notifications.js';

import { makeFakeNotificationsRepo, createTestNotification } from '../../fixtures/fakes.js';

describe('listUserNotifications use case', () => {
  describe('basic listing', () => {
    it('returns empty array when user has no notifications', async () => {
      const repo = makeFakeNotificationsRepo();

      const result = await listUserNotifications({ notificationsRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns all notifications for a user', async () => {
      const notifications = [
        createTestNotification({
          id: 'notification-1',
          userId: 'user-1',
          isActive: true,
        }),
        createTestNotification({
          id: 'notification-2',
          userId: 'user-1',
          isActive: false,
        }),
        createTestNotification({
          id: 'notification-3',
          userId: 'user-2', // Different user
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listUserNotifications({ notificationsRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
        expect(result.value.map((n) => n.id)).toContain('notification-1');
        expect(result.value.map((n) => n.id)).toContain('notification-2');
        expect(result.value.map((n) => n.id)).not.toContain('notification-3');
      }
    });

    it('returns both active and inactive by default', async () => {
      const notifications = [
        createTestNotification({
          id: 'active',
          userId: 'user-1',
          isActive: true,
        }),
        createTestNotification({
          id: 'inactive',
          userId: 'user-1',
          isActive: false,
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listUserNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', activeOnly: false }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  describe('active-only filtering', () => {
    it('returns only active notifications when activeOnly is true', async () => {
      const notifications = [
        createTestNotification({
          id: 'active-1',
          userId: 'user-1',
          isActive: true,
        }),
        createTestNotification({
          id: 'inactive-1',
          userId: 'user-1',
          isActive: false,
        }),
        createTestNotification({
          id: 'active-2',
          userId: 'user-1',
          isActive: true,
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listUserNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', activeOnly: true }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
        expect(result.value.every((n) => n.isActive)).toBe(true);
      }
    });

    it('returns empty array when user has no active notifications', async () => {
      const notifications = [
        createTestNotification({
          id: 'inactive',
          userId: 'user-1',
          isActive: false,
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listUserNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', activeOnly: true }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(0);
      }
    });
  });

  describe('database error handling', () => {
    it('propagates database errors', async () => {
      const repo = makeFakeNotificationsRepo({ simulateDbError: true });

      const result = await listUserNotifications({ notificationsRepo: repo }, { userId: 'user-1' });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });
  });
});

describe('listEntityNotifications use case', () => {
  describe('basic listing', () => {
    it('returns empty array when user has no notifications for entity', async () => {
      const repo = makeFakeNotificationsRepo();

      const result = await listEntityNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', entityCui: '1234567' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns notifications for specific entity', async () => {
      const notifications = [
        createTestNotification({
          id: 'entity-1',
          userId: 'user-1',
          entityCui: '1234567',
        }),
        createTestNotification({
          id: 'entity-2',
          userId: 'user-1',
          entityCui: '1234567',
          notificationType: 'newsletter_entity_yearly',
        }),
        createTestNotification({
          id: 'other-entity',
          userId: 'user-1',
          entityCui: '7654321', // Different entity
        }),
        createTestNotification({
          id: 'other-user',
          userId: 'user-2', // Different user
          entityCui: '1234567',
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listEntityNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', entityCui: '1234567' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
        expect(result.value.map((n) => n.id)).toContain('entity-1');
        expect(result.value.map((n) => n.id)).toContain('entity-2');
      }
    });

    it('returns all notification types for entity', async () => {
      const notifications = [
        createTestNotification({
          id: 'monthly',
          userId: 'user-1',
          entityCui: '1234567',
          notificationType: 'newsletter_entity_monthly',
        }),
        createTestNotification({
          id: 'quarterly',
          userId: 'user-1',
          entityCui: '1234567',
          notificationType: 'newsletter_entity_quarterly',
        }),
        createTestNotification({
          id: 'yearly',
          userId: 'user-1',
          entityCui: '1234567',
          notificationType: 'newsletter_entity_yearly',
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listEntityNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', entityCui: '1234567' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(3);
      }
    });
  });

  describe('active-only filtering', () => {
    it('returns only active notifications when activeOnly is true', async () => {
      const notifications = [
        createTestNotification({
          id: 'active',
          userId: 'user-1',
          entityCui: '1234567',
          isActive: true,
        }),
        createTestNotification({
          id: 'inactive',
          userId: 'user-1',
          entityCui: '1234567',
          isActive: false,
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listEntityNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', entityCui: '1234567', activeOnly: true }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.id).toBe('active');
      }
    });

    it('returns both active and inactive by default', async () => {
      const notifications = [
        createTestNotification({
          id: 'active',
          userId: 'user-1',
          entityCui: '1234567',
          isActive: true,
        }),
        createTestNotification({
          id: 'inactive',
          userId: 'user-1',
          entityCui: '1234567',
          isActive: false,
        }),
      ];
      const repo = makeFakeNotificationsRepo({ notifications });

      const result = await listEntityNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', entityCui: '1234567' }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  describe('database error handling', () => {
    it('propagates database errors', async () => {
      const repo = makeFakeNotificationsRepo({ simulateDbError: true });

      const result = await listEntityNotifications(
        { notificationsRepo: repo },
        { userId: 'user-1', entityCui: '1234567' }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });
  });
});
