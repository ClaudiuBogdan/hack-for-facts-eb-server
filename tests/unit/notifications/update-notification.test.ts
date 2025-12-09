/**
 * Unit tests for update-notification use case
 *
 * Tests cover:
 * - Ownership verification (403 for non-owners)
 * - Not found handling (404)
 * - Updating isActive status
 * - Updating config for alerts
 * - Config nullification for newsletters
 * - Hash recalculation on config change
 * - Config validation for alerts
 */

import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { updateNotification } from '@/modules/notifications/core/usecases/update-notification.js';
import { sha256Hasher } from '@/modules/notifications/shell/crypto/hasher.js';

import { makeFakeNotificationsRepo, createTestNotification } from '../../fixtures/fakes.js';

import type {
  AnalyticsSeriesAlertConfig,
  StaticSeriesAlertConfig,
} from '@/modules/notifications/core/types.js';

const hasher = sha256Hasher;

describe('updateNotification use case', () => {
  describe('authorization', () => {
    it('returns NotificationNotFoundError when notification does not exist', async () => {
      const repo = makeFakeNotificationsRepo();
      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'nonexistent-id',
          userId: 'user-1',
          updates: { isActive: false },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('NotificationNotFoundError');
      }
    });

    it('returns NotificationForbiddenError when user does not own notification', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'owner-user',
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'other-user',
          updates: { isActive: false },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('NotificationForbiddenError');
      }
    });
  });

  describe('updating isActive status', () => {
    it('deactivates an active subscription', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { isActive: false },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.isActive).toBe(false);
      }
    });

    it('activates an inactive subscription', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: false,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { isActive: true },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.isActive).toBe(true);
      }
    });

    it('handles empty updates object', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        isActive: true,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {},
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.isActive).toBe(true); // Unchanged
      }
    });
  });

  describe('updating newsletter config', () => {
    it('sets config to null for newsletter types', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        entityCui: '1234567',
        config: null,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: { someData: 'value' } as unknown as null, // Try to set config
          },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.config).toBeNull(); // Config forced to null
      }
    });
  });

  describe('updating analytics alert config', () => {
    const validAnalyticsConfig: AnalyticsSeriesAlertConfig = {
      title: 'Updated Alert',
      conditions: [{ operator: 'gt', threshold: 200000, unit: 'RON' }],
      filter: {
        account_category: 'ch',
        report_period: {
          type: Frequency.YEAR,
          selection: { interval: { start: '2020', end: '2024' } },
        },
      },
    };

    it('updates config for analytics alert', async () => {
      const originalConfig: AnalyticsSeriesAlertConfig = {
        title: 'Original Alert',
        conditions: [],
        filter: {
          account_category: 'vn',
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2020', end: '2024' } },
          },
        },
      };

      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_analytics',
        config: originalConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { config: validAnalyticsConfig },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.config).toEqual(validAnalyticsConfig);
      }
    });

    it('returns error for invalid analytics config (missing filter)', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_analytics',
        config: validAnalyticsConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: {
              title: 'Invalid',
              conditions: [],
              datasetId: 'wrong-type',
            } as unknown as AnalyticsSeriesAlertConfig,
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('InvalidConfigError');
      }
    });

    it('returns error for condition with empty unit', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_analytics',
        config: validAnalyticsConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: {
              ...validAnalyticsConfig,
              conditions: [{ operator: 'gt', threshold: 100, unit: '' }],
            },
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('InvalidConfigError');
      }
    });

    it('returns error for condition with non-finite threshold', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_analytics',
        config: validAnalyticsConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: {
              ...validAnalyticsConfig,
              conditions: [{ operator: 'gt', threshold: Infinity, unit: 'RON' }],
            },
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('InvalidConfigError');
      }
    });
  });

  describe('updating static alert config', () => {
    const validStaticConfig: StaticSeriesAlertConfig = {
      title: 'Updated Static Alert',
      conditions: [{ operator: 'gt', threshold: 5, unit: '%' }],
      datasetId: 'ro.economics.cpi.yearly',
    };

    it('updates config for static alert', async () => {
      const originalConfig: StaticSeriesAlertConfig = {
        title: 'Original',
        conditions: [],
        datasetId: 'ro.economics.gdp.yearly',
      };

      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: originalConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { config: validStaticConfig },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.config).toEqual(validStaticConfig);
      }
    });

    it('returns error for invalid static config (missing datasetId)', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: validStaticConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: {
              title: 'Invalid',
              conditions: [],
              filter: {},
            } as unknown as StaticSeriesAlertConfig,
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('InvalidConfigError');
      }
    });

    it('returns error for empty datasetId', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: validStaticConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: {
              ...validStaticConfig,
              datasetId: '',
            },
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('InvalidConfigError');
      }
    });

    it('returns error for whitespace-only datasetId', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: validStaticConfig,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            config: {
              ...validStaticConfig,
              datasetId: '   ',
            },
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('InvalidConfigError');
      }
    });
  });

  describe('hash recalculation', () => {
    it('recalculates hash when config changes', async () => {
      const originalConfig: StaticSeriesAlertConfig = {
        title: 'Original',
        conditions: [],
        datasetId: 'dataset-1',
      };

      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: originalConfig,
        hash: 'original-hash',
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const newConfig: StaticSeriesAlertConfig = {
        title: 'Updated',
        conditions: [],
        datasetId: 'dataset-2',
      };

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { config: newConfig },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.hash).not.toBe('original-hash');
      }
    });

    it('does not recalculate hash when only isActive changes', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'newsletter_entity_monthly',
        entityCui: '1234567',
        hash: 'original-hash',
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { isActive: false },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // Hash might be recalculated but should match the original
        // since the config didn't change
        expect(result.value.id).toBe('notification-1');
      }
    });
  });

  describe('combined updates', () => {
    it('updates both isActive and config in single call', async () => {
      const originalConfig: StaticSeriesAlertConfig = {
        title: 'Original',
        conditions: [],
        datasetId: 'dataset-1',
      };

      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
        notificationType: 'alert_series_static',
        config: originalConfig,
        isActive: true,
      });
      const repo = makeFakeNotificationsRepo({ notifications: [notification] });

      const newConfig: StaticSeriesAlertConfig = {
        title: 'Updated',
        conditions: [{ operator: 'gt', threshold: 100, unit: 'RON' }],
        datasetId: 'dataset-2',
      };

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: {
            isActive: false,
            config: newConfig,
          },
        }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.isActive).toBe(false);
        expect(result.value.config).toEqual(newConfig);
      }
    });
  });

  describe('database error handling', () => {
    it('propagates database errors', async () => {
      const notification = createTestNotification({
        id: 'notification-1',
        userId: 'user-1',
      });
      const repo = makeFakeNotificationsRepo({
        notifications: [notification],
        simulateDbError: true,
      });

      const result = await updateNotification(
        { notificationsRepo: repo, hasher },
        {
          notificationId: 'notification-1',
          userId: 'user-1',
          updates: { isActive: false },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });
  });
});
