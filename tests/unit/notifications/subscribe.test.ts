/**
 * Unit tests for subscribe use case
 *
 * Tests cover:
 * - Newsletter subscriptions: entity required, deduplication by (user, type, entity)
 * - Alert subscriptions: config validation, deduplication by hash
 * - Reactivation of inactive subscriptions
 * - Condition validation (threshold, unit)
 */

import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import { subscribe } from '@/modules/notifications/core/usecases/subscribe.js';
import { sha256Hasher } from '@/modules/notifications/shell/crypto/hasher.js';

import { makeFakeNotificationsRepo, createTestNotification } from '../../fixtures/fakes.js';

import type {
  AnalyticsSeriesAlertConfig,
  StaticSeriesAlertConfig,
} from '@/modules/notifications/core/types.js';

const hasher = sha256Hasher;

describe('subscribe use case', () => {
  describe('newsletter subscriptions', () => {
    describe('validation', () => {
      it('returns error when entity is missing for newsletter type', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: null,
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('EntityRequiredError');
        }
      });

      it('returns error when entity is empty string', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '',
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('EntityRequiredError');
        }
      });

      it('returns error when entity is whitespace only', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '   ',
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('EntityRequiredError');
        }
      });
    });

    describe('creation', () => {
      it('creates new monthly newsletter subscription', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '1234567',
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.userId).toBe('user-1');
          expect(result.value.notificationType).toBe('newsletter_entity_monthly');
          expect(result.value.entityCui).toBe('1234567');
          expect(result.value.isActive).toBe(true);
          expect(result.value.config).toBeNull();
        }
      });

      it('creates new quarterly newsletter subscription', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_quarterly',
            entityCui: '1234567',
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.notificationType).toBe('newsletter_entity_quarterly');
        }
      });

      it('creates new yearly newsletter subscription', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_yearly',
            entityCui: '1234567',
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.notificationType).toBe('newsletter_entity_yearly');
        }
      });

      it('allows same user to subscribe to different entities', async () => {
        const repo = makeFakeNotificationsRepo();

        const result1 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '1234567',
          }
        );

        const result2 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '7654321',
          }
        );

        expect(result1.isOk()).toBe(true);
        expect(result2.isOk()).toBe(true);
        if (result1.isOk() && result2.isOk()) {
          expect(result1.value.id).not.toBe(result2.value.id);
        }
      });

      it('allows same user to subscribe with different frequencies for same entity', async () => {
        const repo = makeFakeNotificationsRepo();

        const result1 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '1234567',
          }
        );

        const result2 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_yearly',
            entityCui: '1234567',
          }
        );

        expect(result1.isOk()).toBe(true);
        expect(result2.isOk()).toBe(true);
        if (result1.isOk() && result2.isOk()) {
          expect(result1.value.id).not.toBe(result2.value.id);
          expect(result1.value.notificationType).toBe('newsletter_entity_monthly');
          expect(result2.value.notificationType).toBe('newsletter_entity_yearly');
        }
      });
    });

    describe('deduplication', () => {
      it('returns existing subscription when already active', async () => {
        const existing = createTestNotification({
          userId: 'user-1',
          notificationType: 'newsletter_entity_monthly',
          entityCui: '1234567',
          isActive: true,
        });
        const repo = makeFakeNotificationsRepo({ notifications: [existing] });

        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '1234567',
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.id).toBe(existing.id);
          expect(result.value.isActive).toBe(true);
        }
      });

      it('reactivates inactive subscription', async () => {
        const existing = createTestNotification({
          userId: 'user-1',
          notificationType: 'newsletter_entity_monthly',
          entityCui: '1234567',
          isActive: false,
        });
        const repo = makeFakeNotificationsRepo({ notifications: [existing] });

        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'newsletter_entity_monthly',
            entityCui: '1234567',
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.id).toBe(existing.id);
          expect(result.value.isActive).toBe(true);
        }
      });
    });
  });

  describe('analytics alert subscriptions', () => {
    const validAnalyticsConfig: AnalyticsSeriesAlertConfig = {
      title: 'Budget Monitor',
      conditions: [{ operator: 'gt', threshold: 100000000, unit: 'RON' }],
      filter: {
        account_category: 'ch',
        report_period: {
          type: Frequency.YEAR,
          selection: { interval: { start: '2020', end: '2024' } },
        },
      },
    };

    describe('validation', () => {
      it('returns error when config is missing', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: null,
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('ConfigRequiredError');
        }
      });

      it('returns error when config lacks filter', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              title: 'Test',
              conditions: [],
              datasetId: 'test', // Wrong config type
            } as unknown as AnalyticsSeriesAlertConfig,
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
        }
      });

      it('returns error when condition has empty unit', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              conditions: [{ operator: 'gt', threshold: 100, unit: '' }],
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
          expect(result.error.message).toContain('unit');
        }
      });

      it('returns error when condition has whitespace-only unit', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              conditions: [{ operator: 'gt', threshold: 100, unit: '   ' }],
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
        }
      });

      it('returns error when condition has non-finite threshold (Infinity)', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              conditions: [{ operator: 'gt', threshold: Infinity, unit: 'RON' }],
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
          expect(result.error.message).toContain('finite');
        }
      });

      it('returns error when condition has non-finite threshold (NaN)', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              conditions: [{ operator: 'gt', threshold: NaN, unit: 'RON' }],
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
        }
      });

      it('validates all conditions in array', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              conditions: [
                { operator: 'gt', threshold: 100, unit: 'RON' }, // Valid
                { operator: 'lt', threshold: 200, unit: '' }, // Invalid (index 1)
              ],
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
          expect(result.error.message).toContain('index 1');
        }
      });
    });

    describe('creation', () => {
      it('creates new analytics alert subscription', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: validAnalyticsConfig,
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.userId).toBe('user-1');
          expect(result.value.notificationType).toBe('alert_series_analytics');
          expect(result.value.config).toEqual(validAnalyticsConfig);
          expect(result.value.isActive).toBe(true);
        }
      });

      it('allows analytics alert without entity', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            entityCui: null,
            config: validAnalyticsConfig,
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.entityCui).toBeNull();
        }
      });

      it('allows analytics alert with entity', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            entityCui: '1234567',
            config: validAnalyticsConfig,
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.entityCui).toBe('1234567');
        }
      });

      it('allows empty conditions array', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              conditions: [],
            },
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.config).toBeDefined();
        }
      });
    });

    describe('deduplication by hash', () => {
      it('returns existing subscription when same config hash exists', async () => {
        const repo = makeFakeNotificationsRepo();

        // Create first subscription
        const result1 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: validAnalyticsConfig,
          }
        );

        // Try to create duplicate
        const result2 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: validAnalyticsConfig,
          }
        );

        expect(result1.isOk()).toBe(true);
        expect(result2.isOk()).toBe(true);
        if (result1.isOk() && result2.isOk()) {
          expect(result1.value.id).toBe(result2.value.id);
        }
      });

      it('creates new subscription when config differs', async () => {
        const repo = makeFakeNotificationsRepo();

        const result1 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              title: 'Alert 1',
            },
          }
        );

        const result2 = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_analytics',
            config: {
              ...validAnalyticsConfig,
              title: 'Alert 2',
            },
          }
        );

        expect(result1.isOk()).toBe(true);
        expect(result2.isOk()).toBe(true);
        if (result1.isOk() && result2.isOk()) {
          expect(result1.value.id).not.toBe(result2.value.id);
        }
      });
    });
  });

  describe('static alert subscriptions', () => {
    const validStaticConfig: StaticSeriesAlertConfig = {
      title: 'CPI Monitor',
      conditions: [],
      datasetId: 'ro.economics.cpi.yearly',
    };

    describe('validation', () => {
      it('returns error when config is missing', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_static',
            config: null,
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('ConfigRequiredError');
        }
      });

      it('returns error when config lacks datasetId', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_static',
            config: {
              title: 'Test',
              conditions: [],
              filter: {}, // Wrong config type
            } as unknown as StaticSeriesAlertConfig,
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
        }
      });

      it('returns error when datasetId is empty', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_static',
            config: {
              ...validStaticConfig,
              datasetId: '',
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
          expect(result.error.message).toContain('datasetId');
        }
      });

      it('returns error when datasetId is whitespace only', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_static',
            config: {
              ...validStaticConfig,
              datasetId: '   ',
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
        }
      });

      it('validates conditions for static alerts too', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_static',
            config: {
              ...validStaticConfig,
              conditions: [{ operator: 'gt', threshold: 100, unit: '' }],
            },
          }
        );

        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error.type).toBe('InvalidConfigError');
        }
      });
    });

    describe('creation', () => {
      it('creates new static alert subscription', async () => {
        const repo = makeFakeNotificationsRepo();
        const result = await subscribe(
          { notificationsRepo: repo, hasher },
          {
            userId: 'user-1',
            notificationType: 'alert_series_static',
            config: validStaticConfig,
          }
        );

        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
          expect(result.value.userId).toBe('user-1');
          expect(result.value.notificationType).toBe('alert_series_static');
          expect(result.value.config).toEqual(validStaticConfig);
          expect(result.value.isActive).toBe(true);
        }
      });
    });
  });

  describe('database error handling', () => {
    it('propagates database errors for newsletters', async () => {
      const repo = makeFakeNotificationsRepo({ simulateDbError: true });
      const result = await subscribe(
        { notificationsRepo: repo, hasher },
        {
          userId: 'user-1',
          notificationType: 'newsletter_entity_monthly',
          entityCui: '1234567',
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });

    it('propagates database errors for alerts', async () => {
      const repo = makeFakeNotificationsRepo({ simulateDbError: true });
      const result = await subscribe(
        { notificationsRepo: repo, hasher },
        {
          userId: 'user-1',
          notificationType: 'alert_series_static',
          config: {
            title: 'Test',
            conditions: [],
            datasetId: 'test-dataset',
          },
        }
      );

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });
  });
});
