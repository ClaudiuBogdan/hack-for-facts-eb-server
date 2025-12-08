/**
 * Integration tests for cache wrappers with nested filter objects.
 *
 * These tests verify that the caching layer correctly distinguishes between
 * filters that differ only in nested properties (e.g., different years in report_period).
 */

import { Decimal } from 'decimal.js';
import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { wrapCountyAnalyticsRepo } from '@/app/cache-wrappers.js';
import { Frequency } from '@/common/types/temporal.js';
import {
  CacheNamespace,
  createKeyBuilder,
  createMemoryCache,
  createSilentCache,
} from '@/infra/cache/index.js';

import type { AnalyticsFilter } from '@/common/types/analytics.js';
import type { CountyAnalyticsError } from '@/modules/county-analytics/core/errors.js';
import type { CountyAnalyticsRepository } from '@/modules/county-analytics/core/ports.js';
import type { HeatmapCountyDataPoint } from '@/modules/county-analytics/core/types.js';
import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }) as unknown as Logger;

const createTestDataPoint = (year: number, amount: number): HeatmapCountyDataPoint => ({
  county_code: 'AB',
  county_name: 'ALBA',
  county_population: 325941,
  county_entity_cui: 'test-cui',
  year,
  total_amount: new Decimal(amount),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Cache Wrappers - Nested Filter Handling', () => {
  let mockRepo: CountyAnalyticsRepository;
  let callCount: number;

  beforeEach(() => {
    callCount = 0;

    mockRepo = {
      getHeatmapData: async (
        filter: AnalyticsFilter
      ): Promise<Result<HeatmapCountyDataPoint[], CountyAnalyticsError>> => {
        callCount++;

        // Extract year from filter to return different data for different years
        const selection = filter.report_period.selection;
        let year = 2023;
        if ('dates' in selection && selection.dates !== undefined && selection.dates.length > 0) {
          const firstDate = selection.dates[0];
          if (firstDate !== undefined) {
            year = parseInt(firstDate.substring(0, 4), 10);
          }
        } else if ('interval' in selection && selection.interval !== undefined) {
          year = parseInt(selection.interval.start.substring(0, 4), 10);
        }

        // Return different amounts for different years
        const amount = year === 2023 ? 1000000 : 800000;
        return ok([createTestDataPoint(year, amount)]);
      },
    };
  });

  it('caches results separately for filters with different nested values (years)', async () => {
    const cache = createMemoryCache({ maxEntries: 100, defaultTtlMs: 60000 });
    const silentCache = createSilentCache(cache, { logger: createMockLogger() });
    const keyBuilder = createKeyBuilder();

    const cachedRepo = wrapCountyAnalyticsRepo(mockRepo, silentCache, keyBuilder);

    // Create two filters that only differ in the nested year value
    const filter2023: AnalyticsFilter = {
      account_category: 'ch',
      report_type: 'PRINCIPAL_AGGREGATED',
      report_period: {
        type: Frequency.YEAR,
        selection: { dates: ['2023'] },
      },
    };

    const filter2022: AnalyticsFilter = {
      account_category: 'ch',
      report_type: 'PRINCIPAL_AGGREGATED',
      report_period: {
        type: Frequency.YEAR,
        selection: { dates: ['2022'] },
      },
    };

    // First call for 2023 - should hit the underlying repo
    const result2023First = await cachedRepo.getHeatmapData(filter2023);
    expect(result2023First.isOk()).toBe(true);
    const data2023First = result2023First._unsafeUnwrap();
    expect(data2023First[0]?.total_amount.toNumber()).toBe(1000000);
    expect(callCount).toBe(1);

    // First call for 2022 - should hit the underlying repo (different cache key)
    const result2022First = await cachedRepo.getHeatmapData(filter2022);
    expect(result2022First.isOk()).toBe(true);
    const data2022First = result2022First._unsafeUnwrap();
    expect(data2022First[0]?.total_amount.toNumber()).toBe(800000);
    expect(callCount).toBe(2);

    // Second call for 2023 - should be cached (repo not called again)
    const result2023Second = await cachedRepo.getHeatmapData(filter2023);
    expect(result2023Second.isOk()).toBe(true);
    const data2023Second = result2023Second._unsafeUnwrap();
    expect(data2023Second[0]?.total_amount.toNumber()).toBe(1000000);
    expect(callCount).toBe(2); // Still 2, not 3

    // Second call for 2022 - should be cached (repo not called again)
    const result2022Second = await cachedRepo.getHeatmapData(filter2022);
    expect(result2022Second.isOk()).toBe(true);
    const data2022Second = result2022Second._unsafeUnwrap();
    expect(data2022Second[0]?.total_amount.toNumber()).toBe(800000);
    expect(callCount).toBe(2); // Still 2, not 3
  });

  it('generates different cache keys for filters with different nested periods', async () => {
    const keyBuilder = createKeyBuilder();

    const filter2023: AnalyticsFilter = {
      account_category: 'ch',
      report_type: 'PRINCIPAL_AGGREGATED',
      report_period: {
        type: Frequency.YEAR,
        selection: { dates: ['2023'] },
      },
    };

    const filter2022: AnalyticsFilter = {
      account_category: 'ch',
      report_type: 'PRINCIPAL_AGGREGATED',
      report_period: {
        type: Frequency.YEAR,
        selection: { dates: ['2022'] },
      },
    };

    const key2023 = keyBuilder.fromFilter(
      CacheNamespace.ANALYTICS_COUNTY,
      filter2023 as unknown as Record<string, unknown>
    );
    const key2022 = keyBuilder.fromFilter(
      CacheNamespace.ANALYTICS_COUNTY,
      filter2022 as unknown as Record<string, unknown>
    );

    expect(key2023).not.toBe(key2022);
  });

  it('generates same cache key regardless of property order in nested objects', async () => {
    const keyBuilder = createKeyBuilder();

    // Same filter with different property order
    const filter1: AnalyticsFilter = {
      account_category: 'ch',
      report_type: 'PRINCIPAL_AGGREGATED',
      report_period: {
        type: Frequency.YEAR,
        selection: { dates: ['2023'] },
      },
    };

    // Properties in different order
    const filter2 = {
      report_period: {
        selection: { dates: ['2023'] },
        type: Frequency.YEAR,
      },
      report_type: 'PRINCIPAL_AGGREGATED',
      account_category: 'ch',
    } as AnalyticsFilter;

    const key1 = keyBuilder.fromFilter(
      CacheNamespace.ANALYTICS_COUNTY,
      filter1 as unknown as Record<string, unknown>
    );
    const key2 = keyBuilder.fromFilter(
      CacheNamespace.ANALYTICS_COUNTY,
      filter2 as unknown as Record<string, unknown>
    );

    expect(key1).toBe(key2);
  });

  it('correctly caches with interval-based period selection', async () => {
    const cache = createMemoryCache({ maxEntries: 100, defaultTtlMs: 60000 });
    const silentCache = createSilentCache(cache, { logger: createMockLogger() });
    const keyBuilder = createKeyBuilder();

    const cachedRepo = wrapCountyAnalyticsRepo(mockRepo, silentCache, keyBuilder);

    const filterInterval2023: AnalyticsFilter = {
      account_category: 'vn',
      report_type: 'DETAILED',
      report_period: {
        type: Frequency.YEAR,
        selection: { interval: { start: '2023', end: '2023' } },
      },
    };

    const filterInterval2022: AnalyticsFilter = {
      account_category: 'vn',
      report_type: 'DETAILED',
      report_period: {
        type: Frequency.YEAR,
        selection: { interval: { start: '2022', end: '2022' } },
      },
    };

    // Call for 2023
    const result2023 = await cachedRepo.getHeatmapData(filterInterval2023);
    expect(result2023.isOk()).toBe(true);
    const data2023 = result2023._unsafeUnwrap();
    expect(data2023[0]?.total_amount.toNumber()).toBe(1000000);

    // Call for 2022 - must return different data (not cached 2023 data)
    const result2022 = await cachedRepo.getHeatmapData(filterInterval2022);
    expect(result2022.isOk()).toBe(true);
    const data2022 = result2022._unsafeUnwrap();
    expect(data2022[0]?.total_amount.toNumber()).toBe(800000);

    // Verify both were separate repo calls
    expect(callCount).toBe(2);
  });
});
