import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  type CacheSetOptions,
  createKeyBuilder,
  createMemoryCache,
  createSilentCache,
  type CacheStats,
  type SilentCachePort,
} from '@/infra/cache/index.js';
import {
  type ExecutionMapSeries,
  type GroupedSeriesDataRequest,
  type InsMapSeries,
  makeDbAdvancedMapAnalyticsGroupedSeriesProvider,
} from '@/modules/advanced-map-analytics/index.js';

import type { BudgetDbClient } from '@/infra/database/client.js';
import type { CommitmentsRepository } from '@/modules/commitments/index.js';
import type { InsRepository } from '@/modules/ins/index.js';
import type { NormalizationService } from '@/modules/normalization/index.js';
import type { UATAnalyticsRepository } from '@/modules/uat-analytics/index.js';
import type { Logger } from 'pino';

function makeBudgetDb(sirutaCodes: string[]): BudgetDbClient {
  const query = {
    select: () => ({
      where: () => ({
        orderBy: () => ({
          execute: async () =>
            sirutaCodes.map((sirutaCode) => ({
              siruta_code: sirutaCode,
            })),
        }),
      }),
    }),
  };

  return {
    selectFrom: () => query,
  } as unknown as BudgetDbClient;
}

function createMockLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  } as unknown as Logger;
}

function makeExecutionSeries(
  id: string,
  options?: { accountCategory?: 'ch' | 'vn'; showGrowth?: boolean }
) {
  const series: ExecutionMapSeries = {
    id,
    type: 'line-items-aggregated-yearly',
    filter: {
      account_category: options?.accountCategory ?? 'ch',
      report_type: 'Executie bugetara agregata la nivel de ordonator principal',
      report_period: {
        type: Frequency.YEAR,
        selection: {
          interval: {
            start: '2025',
            end: '2025',
          },
        },
      },
      ...(options?.showGrowth === true ? { show_period_growth: true } : {}),
    },
  };

  return series;
}

function makeNormalizationService(): NormalizationService {
  return {
    generateFactors: async () => ({
      cpi: new Map(),
      eur: new Map(),
      usd: new Map(),
      gdp: new Map(),
      population: new Map(),
    }),
  } as unknown as NormalizationService;
}

class RecordingCache implements SilentCachePort {
  readonly store = new Map<string, unknown>();
  readonly ttlMs: (number | undefined)[] = [];

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async set(key: string, value: unknown, options?: CacheSetOptions): Promise<void> {
    this.ttlMs.push(options?.ttlMs);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async clearByPrefix(prefix: string): Promise<number> {
    let deleted = 0;

    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async stats(): Promise<CacheStats> {
    return {
      hits: 0,
      misses: 0,
      size: this.store.size,
    };
  }
}

describe('db map series provider cache behavior', () => {
  it('caches repeated execution series extraction for identical filter', async () => {
    let executionCalls = 0;
    const uatAnalyticsRepo: UATAnalyticsRepository = {
      getHeatmapData: async () => {
        executionCalls += 1;
        return ok([
          {
            uat_id: 1,
            uat_code: '1001',
            uat_name: 'UAT 1001',
            siruta_code: '1001',
            county_code: 'CJ',
            county_name: 'Cluj',
            region: 'Nord-Vest',
            population: 100,
            year: 2025,
            total_amount: new Decimal(100),
          },
        ]);
      },
    };

    const memoryCache = createMemoryCache({ maxEntries: 100, defaultTtlMs: 60_000 });
    const provider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb: makeBudgetDb(['1001']),
      commitmentsRepo: {} as unknown as CommitmentsRepository,
      insRepo: {} as unknown as InsRepository,
      normalizationService: makeNormalizationService(),
      uatAnalyticsRepo,
      cache: createSilentCache(memoryCache, { logger: createMockLogger() }),
      keyBuilder: createKeyBuilder(),
    });

    const request: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [makeExecutionSeries('s-exec')],
    };

    const first = await provider.fetchGroupedSeriesVectors(request);
    const second = await provider.fetchGroupedSeriesVectors(request);

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    expect(executionCalls).toBe(1);

    if (second.isErr()) {
      return;
    }

    expect(second.value.vectors[0]?.valuesBySirutaCode.get('1001')).toBe(100);
  });

  it('reuses filter cache across different series ids and rewrites warning seriesId', async () => {
    let executionCalls = 0;
    const uatAnalyticsRepo: UATAnalyticsRepository = {
      getHeatmapData: async () => {
        executionCalls += 1;
        return ok([
          {
            uat_id: 1,
            uat_code: '1001',
            uat_name: 'UAT 1001',
            siruta_code: '1001',
            county_code: 'CJ',
            county_name: 'Cluj',
            region: 'Nord-Vest',
            population: 100,
            year: 2025,
            total_amount: new Decimal(100),
          },
        ]);
      },
    };

    const provider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb: makeBudgetDb(['1001']),
      commitmentsRepo: {} as unknown as CommitmentsRepository,
      insRepo: {} as unknown as InsRepository,
      normalizationService: makeNormalizationService(),
      uatAnalyticsRepo,
      cache: createSilentCache(createMemoryCache({ maxEntries: 100, defaultTtlMs: 60_000 }), {
        logger: createMockLogger(),
      }),
      keyBuilder: createKeyBuilder(),
    });

    const firstRequest: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [makeExecutionSeries('series-a', { showGrowth: true })],
    };
    const secondRequest: GroupedSeriesDataRequest = {
      granularity: 'UAT',
      series: [makeExecutionSeries('series-b', { showGrowth: true })],
    };

    await provider.fetchGroupedSeriesVectors(firstRequest);
    const second = await provider.fetchGroupedSeriesVectors(secondRequest);

    expect(executionCalls).toBe(1);
    expect(second.isOk()).toBe(true);

    if (second.isErr()) {
      return;
    }

    const growthWarning = second.value.warnings.find(
      (warning) => warning.type === 'show_period_growth_ignored'
    );
    expect(growthWarning).toBeDefined();
    expect(growthWarning?.seriesId).toBe('series-b');
  });

  it('does partial cache reuse when only one of multiple series is already cached', async () => {
    let executionCalls = 0;
    const uatAnalyticsRepo: UATAnalyticsRepository = {
      getHeatmapData: async () => {
        executionCalls += 1;
        return ok([
          {
            uat_id: 1,
            uat_code: '1001',
            uat_name: 'UAT 1001',
            siruta_code: '1001',
            county_code: 'CJ',
            county_name: 'Cluj',
            region: 'Nord-Vest',
            population: 100,
            year: 2025,
            total_amount: new Decimal(100),
          },
        ]);
      },
    };

    const provider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb: makeBudgetDb(['1001']),
      commitmentsRepo: {} as unknown as CommitmentsRepository,
      insRepo: {} as unknown as InsRepository,
      normalizationService: makeNormalizationService(),
      uatAnalyticsRepo,
      cache: createSilentCache(createMemoryCache({ maxEntries: 100, defaultTtlMs: 60_000 }), {
        logger: createMockLogger(),
      }),
      keyBuilder: createKeyBuilder(),
    });

    await provider.fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [makeExecutionSeries('s1', { accountCategory: 'ch' })],
    });

    await provider.fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [
        makeExecutionSeries('s1', { accountCategory: 'ch' }),
        makeExecutionSeries('s2', { accountCategory: 'vn' }),
      ],
    });

    expect(executionCalls).toBe(2);
  });

  it('writes cache entries with 1h TTL by default', async () => {
    const cache = new RecordingCache();

    const provider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb: makeBudgetDb(['1001']),
      commitmentsRepo: {} as unknown as CommitmentsRepository,
      insRepo: {} as unknown as InsRepository,
      normalizationService: makeNormalizationService(),
      uatAnalyticsRepo: {
        getHeatmapData: async () =>
          ok([
            {
              uat_id: 1,
              uat_code: '1001',
              uat_name: 'UAT 1001',
              siruta_code: '1001',
              county_code: 'CJ',
              county_name: 'Cluj',
              region: 'Nord-Vest',
              population: 100,
              year: 2025,
              total_amount: new Decimal(100),
            },
          ]),
      } as UATAnalyticsRepository,
      cache,
      keyBuilder: createKeyBuilder(),
    });

    const result = await provider.fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [makeExecutionSeries('s-ttl')],
    });

    expect(result.isOk()).toBe(true);
    expect(cache.ttlMs).toEqual([3_600_000]);
  });

  it('canonicalizes INS set-like filter arrays for cache keys', async () => {
    let observationCalls = 0;
    const insRepo: InsRepository = {
      listObservations: async () => {
        observationCalls += 1;
        return ok({
          nodes: [],
          pageInfo: {
            totalCount: 0,
            hasNextPage: false,
            hasPreviousPage: false,
          },
        });
      },
    } as unknown as InsRepository;

    const provider = makeDbAdvancedMapAnalyticsGroupedSeriesProvider({
      budgetDb: makeBudgetDb(['1001', '1002']),
      commitmentsRepo: {} as unknown as CommitmentsRepository,
      insRepo,
      normalizationService: makeNormalizationService(),
      uatAnalyticsRepo: {} as unknown as UATAnalyticsRepository,
      cache: createSilentCache(createMemoryCache({ maxEntries: 100, defaultTtlMs: 60_000 }), {
        logger: createMockLogger(),
      }),
      keyBuilder: createKeyBuilder(),
    });

    const baseSeries: Omit<InsMapSeries, 'id'> = {
      type: 'ins-series',
      datasetCode: 'POP107D',
      aggregation: 'sum',
      period: {
        type: Frequency.YEAR,
        selection: {
          dates: ['2025', '2024'],
        },
      },
      territoryCodes: ['RO', 'CJ'],
      sirutaCodes: ['1002', '1001'],
      unitCodes: ['PERS', 'MII_PERS'],
      classificationSelections: {
        SEX: ['M', 'F'],
        AREA: ['URBAN', 'RURAL'],
      },
      hasValue: true,
    };

    await provider.fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [{ ...baseSeries, id: 'ins-a' }],
    });

    await provider.fetchGroupedSeriesVectors({
      granularity: 'UAT',
      series: [
        {
          ...baseSeries,
          id: 'ins-b',
          period: {
            type: Frequency.YEAR,
            selection: {
              dates: ['2024', '2025'],
            },
          },
          territoryCodes: ['CJ', 'RO'],
          sirutaCodes: ['1001', '1002'],
          unitCodes: ['MII_PERS', 'PERS'],
          classificationSelections: {
            AREA: ['RURAL', 'URBAN'],
            SEX: ['F', 'M'],
          },
        },
      ],
    });

    expect(observationCalls).toBe(1);
  });
});
