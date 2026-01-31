/**
 * Unit tests for notifications pure functions in types.ts
 *
 * Tests cover:
 * - Hash generation (generateNotificationHash)
 * - Period key generation (generatePeriodKey)
 * - Delivery key generation (generateDeliveryKey)
 * - Type guards (isNewsletterType, isAlertType)
 */

import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  generateNotificationHash,
  generatePeriodKey,
  generateDeliveryKey,
  isNewsletterType,
  isAlertType,
  NEWSLETTER_TYPES,
  ALERT_TYPES,
  type NotificationType,
  type AnalyticsSeriesAlertConfig,
  type StaticSeriesAlertConfig,
} from '@/modules/notifications/core/types.js';
import { sha256Hasher } from '@/modules/notifications/shell/crypto/hasher.js';

import type { Hasher } from '@/modules/notifications/core/ports.js';

/**
 * For unit tests, we use the real sha256Hasher since hash generation
 * is a critical part of the functionality we're testing.
 */
const testHasher: Hasher = sha256Hasher;

describe('Notification Type Guards', () => {
  describe('isNewsletterType', () => {
    it('returns true for monthly newsletter', () => {
      expect(isNewsletterType('newsletter_entity_monthly')).toBe(true);
    });

    it('returns true for quarterly newsletter', () => {
      expect(isNewsletterType('newsletter_entity_quarterly')).toBe(true);
    });

    it('returns true for yearly newsletter', () => {
      expect(isNewsletterType('newsletter_entity_yearly')).toBe(true);
    });

    it('returns false for analytics alert', () => {
      expect(isNewsletterType('alert_series_analytics')).toBe(false);
    });

    it('returns false for static alert', () => {
      expect(isNewsletterType('alert_series_static')).toBe(false);
    });

    it('covers all newsletter types', () => {
      for (const type of NEWSLETTER_TYPES) {
        expect(isNewsletterType(type)).toBe(true);
      }
    });
  });

  describe('isAlertType', () => {
    it('returns true for analytics alert', () => {
      expect(isAlertType('alert_series_analytics')).toBe(true);
    });

    it('returns true for static alert', () => {
      expect(isAlertType('alert_series_static')).toBe(true);
    });

    it('returns false for monthly newsletter', () => {
      expect(isAlertType('newsletter_entity_monthly')).toBe(false);
    });

    it('returns false for quarterly newsletter', () => {
      expect(isAlertType('newsletter_entity_quarterly')).toBe(false);
    });

    it('returns false for yearly newsletter', () => {
      expect(isAlertType('newsletter_entity_yearly')).toBe(false);
    });

    it('covers all alert types', () => {
      for (const type of ALERT_TYPES) {
        expect(isAlertType(type)).toBe(true);
      }
    });
  });

  describe('type coverage', () => {
    it('newsletter and alert types are mutually exclusive', () => {
      for (const type of NEWSLETTER_TYPES) {
        expect(isNewsletterType(type)).toBe(true);
        expect(isAlertType(type)).toBe(false);
      }

      for (const type of ALERT_TYPES) {
        expect(isAlertType(type)).toBe(true);
        expect(isNewsletterType(type)).toBe(false);
      }
    });

    it('covers all notification types', () => {
      const allTypes: NotificationType[] = [...NEWSLETTER_TYPES, ...ALERT_TYPES];
      expect(allTypes).toHaveLength(5);
      expect(allTypes).toContain('newsletter_entity_monthly');
      expect(allTypes).toContain('newsletter_entity_quarterly');
      expect(allTypes).toContain('newsletter_entity_yearly');
      expect(allTypes).toContain('alert_series_analytics');
      expect(allTypes).toContain('alert_series_static');
    });
  });
});

describe('generateNotificationHash', () => {
  describe('basic hash generation', () => {
    it('generates a 64-character hex string', () => {
      const hash = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates different hashes for different users', () => {
      const hash1 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      const hash2 = generateNotificationHash(
        testHasher,
        'user-2',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      expect(hash1).not.toBe(hash2);
    });

    it('generates different hashes for different notification types', () => {
      const hash1 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      const hash2 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_quarterly',
        '1234567',
        null
      );
      expect(hash1).not.toBe(hash2);
    });

    it('generates different hashes for different entities', () => {
      const hash1 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      const hash2 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '7654321',
        null
      );
      expect(hash1).not.toBe(hash2);
    });

    it('generates same hash for same inputs', () => {
      const hash1 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      const hash2 = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '1234567',
        null
      );
      expect(hash1).toBe(hash2);
    });
  });

  describe('null entity handling', () => {
    it('generates valid hash when entity is null', () => {
      const hash = generateNotificationHash(testHasher, 'user-1', 'alert_series_analytics', null, {
        title: 'Test',
        conditions: [],
        filter: {},
      } as unknown as AnalyticsSeriesAlertConfig);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates different hash for null vs empty string entity', () => {
      const hashNull = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        null,
        null
      );
      const hashEmpty = generateNotificationHash(
        testHasher,
        'user-1',
        'newsletter_entity_monthly',
        '',
        null
      );
      // Both null and empty string result in empty string in the hash input
      expect(hashNull).toBe(hashEmpty);
    });
  });

  describe('config handling', () => {
    it('includes config in hash for alerts', () => {
      const config1: AnalyticsSeriesAlertConfig = {
        title: 'Alert 1',
        conditions: [{ operator: 'gt', threshold: 100, unit: 'RON' }],
        filter: {
          account_category: 'ch',
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2020', end: '2024' } },
          },
        },
      };
      const config2: AnalyticsSeriesAlertConfig = {
        title: 'Alert 2',
        conditions: [{ operator: 'lt', threshold: 50, unit: 'EUR' }],
        filter: {
          account_category: 'vn',
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2020', end: '2024' } },
          },
        },
      };

      const hash1 = generateNotificationHash(
        testHasher,
        'user-1',
        'alert_series_analytics',
        null,
        config1
      );
      const hash2 = generateNotificationHash(
        testHasher,
        'user-1',
        'alert_series_analytics',
        null,
        config2
      );

      expect(hash1).not.toBe(hash2);
    });

    it('generates same hash regardless of object key order', () => {
      const config1: StaticSeriesAlertConfig = {
        title: 'Test',
        datasetId: 'dataset-1',
        conditions: [],
      };

      const config2: StaticSeriesAlertConfig = {
        datasetId: 'dataset-1',
        conditions: [],
        title: 'Test',
      };

      const hash1 = generateNotificationHash(
        testHasher,
        'user-1',
        'alert_series_static',
        null,
        config1
      );
      const hash2 = generateNotificationHash(
        testHasher,
        'user-1',
        'alert_series_static',
        null,
        config2
      );

      expect(hash1).toBe(hash2);
    });

    it('handles nested objects in config correctly', () => {
      const config: AnalyticsSeriesAlertConfig = {
        title: 'Test',
        conditions: [
          { operator: 'gt', threshold: 100, unit: 'RON' },
          { operator: 'lt', threshold: 200, unit: 'RON' },
        ],
        filter: {
          account_category: 'ch',
          county_codes: ['B', 'CJ'],
          report_period: {
            type: Frequency.YEAR,
            selection: { interval: { start: '2020', end: '2024' } },
          },
        },
      };

      const hash = generateNotificationHash(
        testHasher,
        'user-1',
        'alert_series_analytics',
        null,
        config
      );
      expect(hash).toMatch(/^[a-f0-9]{64}$/);

      // Same config should produce same hash
      const hash2 = generateNotificationHash(
        testHasher,
        'user-1',
        'alert_series_analytics',
        null,
        config
      );
      expect(hash).toBe(hash2);
    });
  });
});

describe('generatePeriodKey', () => {
  describe('monthly period keys', () => {
    it('generates previous month key for monthly newsletter', () => {
      // February 15, 2024 -> should return 2024-01
      const date = new Date(Date.UTC(2024, 1, 15)); // Feb 15, 2024
      const key = generatePeriodKey('newsletter_entity_monthly', date);
      expect(key).toBe('2024-01');
    });

    it('handles year boundary for monthly newsletter', () => {
      // January 15, 2024 -> should return 2023-12
      const date = new Date(Date.UTC(2024, 0, 15)); // Jan 15, 2024
      const key = generatePeriodKey('newsletter_entity_monthly', date);
      expect(key).toBe('2023-12');
    });

    it('pads single-digit months with leading zero', () => {
      // October 15, 2024 -> should return 2024-09
      const date = new Date(Date.UTC(2024, 9, 15)); // Oct 15, 2024
      const key = generatePeriodKey('newsletter_entity_monthly', date);
      expect(key).toBe('2024-09');
    });

    it('generates monthly keys for analytics alerts', () => {
      const date = new Date(Date.UTC(2024, 3, 15)); // April 15, 2024
      const key = generatePeriodKey('alert_series_analytics', date);
      expect(key).toBe('2024-03'); // Previous month
    });

    it('generates monthly keys for static alerts', () => {
      const date = new Date(Date.UTC(2024, 6, 15)); // July 15, 2024
      const key = generatePeriodKey('alert_series_static', date);
      expect(key).toBe('2024-06'); // Previous month
    });
  });

  describe('quarterly period keys', () => {
    it('generates Q4 for Q1 date', () => {
      // March (Q1) 2024 -> Q4 2023
      const date = new Date(Date.UTC(2024, 2, 15)); // March 15, 2024
      const key = generatePeriodKey('newsletter_entity_quarterly', date);
      expect(key).toBe('2023-Q4');
    });

    it('generates Q1 for Q2 date', () => {
      // May (Q2) 2024 -> Q1 2024
      const date = new Date(Date.UTC(2024, 4, 15)); // May 15, 2024
      const key = generatePeriodKey('newsletter_entity_quarterly', date);
      expect(key).toBe('2024-Q1');
    });

    it('generates Q2 for Q3 date', () => {
      // August (Q3) 2024 -> Q2 2024
      const date = new Date(Date.UTC(2024, 7, 15)); // August 15, 2024
      const key = generatePeriodKey('newsletter_entity_quarterly', date);
      expect(key).toBe('2024-Q2');
    });

    it('generates Q3 for Q4 date', () => {
      // November (Q4) 2024 -> Q3 2024
      const date = new Date(Date.UTC(2024, 10, 15)); // November 15, 2024
      const key = generatePeriodKey('newsletter_entity_quarterly', date);
      expect(key).toBe('2024-Q3');
    });
  });

  describe('yearly period keys', () => {
    it('generates previous year key', () => {
      const date = new Date(Date.UTC(2024, 6, 15)); // July 15, 2024
      const key = generatePeriodKey('newsletter_entity_yearly', date);
      expect(key).toBe('2023');
    });

    it('handles year 2000', () => {
      const date = new Date(Date.UTC(2000, 0, 1)); // Jan 1, 2000
      const key = generatePeriodKey('newsletter_entity_yearly', date);
      expect(key).toBe('1999');
    });
  });
});

describe('generateDeliveryKey', () => {
  it('generates key in correct format', () => {
    const key = generateDeliveryKey('user-1', 'notification-123', '2024-01');
    expect(key).toBe('user-1:notification-123:2024-01');
  });

  it('handles special characters in IDs', () => {
    const key = generateDeliveryKey('user@example.com', 'notification-abc-123', '2024-Q1');
    expect(key).toBe('user@example.com:notification-abc-123:2024-Q1');
  });

  it('generates unique keys for different combinations', () => {
    const key1 = generateDeliveryKey('user-1', 'notification-1', '2024-01');
    const key2 = generateDeliveryKey('user-1', 'notification-2', '2024-01');
    const key3 = generateDeliveryKey('user-1', 'notification-1', '2024-02');
    const key4 = generateDeliveryKey('user-2', 'notification-1', '2024-01');

    expect(new Set([key1, key2, key3, key4]).size).toBe(4);
  });

  it('generates consistent keys for same inputs', () => {
    const key1 = generateDeliveryKey('user-1', 'notification-1', '2024-01');
    const key2 = generateDeliveryKey('user-1', 'notification-1', '2024-01');
    expect(key1).toBe(key2);
  });
});
