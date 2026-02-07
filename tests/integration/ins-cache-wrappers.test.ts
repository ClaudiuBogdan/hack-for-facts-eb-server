import { Decimal } from 'decimal.js';
import { err, ok } from 'neverthrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { wrapInsRepo } from '@/app/cache-wrappers.js';
import { Frequency } from '@/common/types/temporal.js';
import {
  createKeyBuilder,
  createMemoryCache,
  createSilentCache,
  type SilentCachePort,
} from '@/infra/cache/index.js';
import { createInvalidFilterError } from '@/modules/ins/core/errors.js';

import type { InsRepository } from '@/modules/ins/core/ports.js';
import type {
  InsContextConnection,
  InsDataset,
  InsDatasetConnection,
  InsDimension,
  InsDimensionValueConnection,
  InsLatestDatasetValue,
  InsObservation,
  InsObservationConnection,
  ListInsLatestDatasetValuesInput,
  ListInsObservationsInput,
} from '@/modules/ins/core/types.js';
import type { Logger } from 'pino';

const INS_TTL_MS = 24 * 60 * 60 * 1000;

const createMockLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  }) as unknown as Logger;

const createDataset = (overrides: Partial<InsDataset> = {}): InsDataset => ({
  id: 1,
  code: 'POP107D',
  name_ro: 'Populatie',
  name_en: 'Population',
  definition_ro: null,
  definition_en: null,
  periodicity: ['ANNUAL'],
  year_range: [2020, 2024],
  dimension_count: 3,
  has_uat_data: true,
  has_county_data: true,
  has_siruta: true,
  sync_status: 'SYNCED',
  last_sync_at: new Date('2025-01-01T00:00:00.000Z'),
  context_code: '1',
  context_name_ro: 'Context',
  context_name_en: 'Context',
  context_path: '0.1',
  metadata: { source: 'ins' },
  ...overrides,
});

const createObservation = (overrides: Partial<InsObservation> = {}): InsObservation => ({
  id: 'obs-1',
  dataset_code: 'POP107D',
  matrix_id: 1,
  territory: {
    id: 1,
    code: 'RO',
    siruta_code: null,
    level: 'NATIONAL',
    name_ro: 'Romania',
    path: null,
    parent_id: null,
  },
  time_period: {
    id: 1,
    year: 2024,
    quarter: null,
    month: null,
    periodicity: 'ANNUAL',
    period_start: new Date('2024-01-01T00:00:00.000Z'),
    period_end: new Date('2024-12-31T00:00:00.000Z'),
    label_ro: '2024',
    label_en: '2024',
    iso_period: '2024',
  },
  unit: {
    id: 1,
    code: 'PERS',
    symbol: null,
    name_ro: 'Persoane',
    name_en: 'Persons',
  },
  value: new Decimal('123.45'),
  value_status: null,
  classifications: [],
  dimensions: { period: '2024' },
  ...overrides,
});

const dataset = createDataset();

const datasetConnection: InsDatasetConnection = {
  nodes: [dataset],
  pageInfo: {
    totalCount: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

const contextConnection: InsContextConnection = {
  nodes: [
    {
      id: 1,
      code: '1',
      name_ro: 'Demografie',
      name_en: 'Demography',
      name_ro_markdown: 'Demografie',
      name_en_markdown: 'Demography',
      level: 0,
      path: '0.1',
      parent_id: null,
      parent_code: null,
      parent_name_ro: null,
      matrix_count: 1,
    },
  ],
  pageInfo: {
    totalCount: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

const dimensions: InsDimension[] = [
  {
    matrix_id: 1,
    index: 0,
    type: 'TEMPORAL',
    label_ro: 'An',
    label_en: 'Year',
    classification_type: null,
    is_hierarchical: false,
    option_count: 1,
  },
];

const dimensionValueConnection: InsDimensionValueConnection = {
  nodes: [
    {
      matrix_id: 1,
      dim_index: 0,
      nom_item_id: 1,
      dimension_type: 'TEMPORAL',
      label_ro: '2024',
      label_en: '2024',
      parent_nom_item_id: null,
      offset_order: 1,
      territory: null,
      time_period: {
        id: 1,
        year: 2024,
        quarter: null,
        month: null,
        periodicity: 'ANNUAL',
        period_start: new Date('2024-01-01T00:00:00.000Z'),
        period_end: new Date('2024-12-31T00:00:00.000Z'),
        label_ro: '2024',
        label_en: '2024',
        iso_period: '2024',
      },
      classification_value: null,
      unit: null,
    },
  ],
  pageInfo: {
    totalCount: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

const observationConnection: InsObservationConnection = {
  nodes: [createObservation()],
  pageInfo: {
    totalCount: 1,
    hasNextPage: false,
    hasPreviousPage: false,
  },
};

const latestDatasetValues: InsLatestDatasetValue[] = [
  {
    dataset,
    observation: createObservation(),
    latest_period: '2024',
    match_strategy: 'TOTAL_FALLBACK',
    has_data: true,
  },
];

const uatDatasetsWithObservations: { dataset: InsDataset; observations: InsObservation[] }[] = [
  {
    dataset,
    observations: [createObservation()],
  },
];

interface MethodCounters {
  listDatasets: number;
  listContexts: number;
  getDatasetByCode: number;
  listDimensions: number;
  listDimensionValues: number;
  listObservations: number;
  listLatestDatasetValues: number;
  listUatDatasetsWithObservations: number;
}

const createCounters = (): MethodCounters => ({
  listDatasets: 0,
  listContexts: 0,
  getDatasetByCode: 0,
  listDimensions: 0,
  listDimensionValues: 0,
  listObservations: 0,
  listLatestDatasetValues: 0,
  listUatDatasetsWithObservations: 0,
});

const createRepo = (counters: MethodCounters): InsRepository => ({
  listDatasets: async () => {
    counters.listDatasets += 1;
    return ok(datasetConnection);
  },
  listContexts: async () => {
    counters.listContexts += 1;
    return ok(contextConnection);
  },
  getDatasetByCode: async () => {
    counters.getDatasetByCode += 1;
    return ok(dataset);
  },
  listDimensions: async () => {
    counters.listDimensions += 1;
    return ok(dimensions);
  },
  listDimensionValues: async () => {
    counters.listDimensionValues += 1;
    return ok(dimensionValueConnection);
  },
  listObservations: async () => {
    counters.listObservations += 1;
    return ok(observationConnection);
  },
  listLatestDatasetValues: async () => {
    counters.listLatestDatasetValues += 1;
    return ok(latestDatasetValues);
  },
  listUatDatasetsWithObservations: async () => {
    counters.listUatDatasetsWithObservations += 1;
    return ok(uatDatasetsWithObservations);
  },
});

describe('INS cache wrappers', () => {
  let counters: MethodCounters;
  let cachedRepo: InsRepository;

  beforeEach(() => {
    counters = createCounters();
    const cache = createMemoryCache({ maxEntries: 200, defaultTtlMs: INS_TTL_MS });
    const silentCache = createSilentCache(cache, { logger: createMockLogger() });
    const keyBuilder = createKeyBuilder();
    cachedRepo = wrapInsRepo(createRepo(counters), silentCache, keyBuilder);
  });

  it('caches all INS repository methods on successful results', async () => {
    const observationsInput: ListInsObservationsInput = {
      dataset_codes: ['POP107D'],
      filter: { territory_codes: ['RO'] },
      limit: 10,
      offset: 0,
    };

    const latestInput: ListInsLatestDatasetValuesInput = {
      entity: { siruta_code: '54975' },
      dataset_codes: ['POP107D', 'SOM103A'],
    };

    const firstObservationResult = await cachedRepo.listObservations(observationsInput);
    const secondObservationResult = await cachedRepo.listObservations(observationsInput);

    await cachedRepo.listDatasets({}, 20, 0);
    await cachedRepo.listDatasets({}, 20, 0);

    await cachedRepo.listContexts({}, 20, 0);
    await cachedRepo.listContexts({}, 20, 0);

    await cachedRepo.getDatasetByCode('POP107D');
    await cachedRepo.getDatasetByCode('POP107D');

    await cachedRepo.listDimensions(1);
    await cachedRepo.listDimensions(1);

    await cachedRepo.listDimensionValues(1, 0, {}, 50, 0);
    await cachedRepo.listDimensionValues(1, 0, {}, 50, 0);

    await cachedRepo.listLatestDatasetValues(latestInput);
    await cachedRepo.listLatestDatasetValues(latestInput);

    await cachedRepo.listUatDatasetsWithObservations('54975', '1', '2024');
    await cachedRepo.listUatDatasetsWithObservations('54975', '1', '2024');

    expect(counters.listDatasets).toBe(1);
    expect(counters.listContexts).toBe(1);
    expect(counters.getDatasetByCode).toBe(1);
    expect(counters.listDimensions).toBe(1);
    expect(counters.listDimensionValues).toBe(1);
    expect(counters.listObservations).toBe(1);
    expect(counters.listLatestDatasetValues).toBe(1);
    expect(counters.listUatDatasetsWithObservations).toBe(1);

    expect(firstObservationResult.isOk()).toBe(true);
    expect(secondObservationResult.isOk()).toBe(true);
    if (secondObservationResult.isOk()) {
      const firstNode = secondObservationResult.value.nodes[0];
      expect(firstNode).toBeDefined();
      expect(firstNode?.value).toBeInstanceOf(Decimal);
      expect(firstNode?.time_period.period_start).toBeInstanceOf(Date);
      expect(firstNode?.time_period.period_end).toBeInstanceOf(Date);
    }
  });

  it('does not cache error results', async () => {
    let callCount = 0;

    const errorRepo = createRepo(createCounters());
    errorRepo.listContexts = async () => {
      callCount += 1;
      return err(createInvalidFilterError('search', 'Invalid search filter'));
    };

    const cache = createMemoryCache({ maxEntries: 200, defaultTtlMs: INS_TTL_MS });
    const silentCache = createSilentCache(cache, { logger: createMockLogger() });
    const keyBuilder = createKeyBuilder();
    const wrapped = wrapInsRepo(errorRepo, silentCache, keyBuilder);

    const first = await wrapped.listContexts({}, 20, 0);
    const second = await wrapped.listContexts({}, 20, 0);

    expect(first.isErr()).toBe(true);
    expect(second.isErr()).toBe(true);
    expect(callCount).toBe(2);
  });

  it('canonicalizes set-like arrays for listObservations cache keys', async () => {
    const inputA: ListInsObservationsInput = {
      dataset_codes: ['SOM103A', 'POP107D', 'SOM103A'],
      filter: {
        territory_codes: ['CJ', 'AB', 'CJ'],
        siruta_codes: ['54975', '106977'],
        classification_value_codes: ['TOTAL', 'F'],
        classification_type_codes: ['SEX', 'AGE'],
        period: {
          type: Frequency.YEAR,
          selection: {
            dates: ['2024', '2023', '2024'],
          },
        },
      },
      limit: 25,
      offset: 0,
    };

    const inputB: ListInsObservationsInput = {
      dataset_codes: ['POP107D', 'SOM103A'],
      filter: {
        territory_codes: ['AB', 'CJ'],
        siruta_codes: ['106977', '54975'],
        classification_value_codes: ['F', 'TOTAL'],
        classification_type_codes: ['AGE', 'SEX'],
        period: {
          type: Frequency.YEAR,
          selection: {
            dates: ['2023', '2024'],
          },
        },
      },
      limit: 25,
      offset: 0,
    };

    await cachedRepo.listObservations(inputA);
    await cachedRepo.listObservations(inputB);

    expect(counters.listObservations).toBe(1);
  });

  it('preserves dataset_codes order for listLatestDatasetValues cache keys', async () => {
    const inputA: ListInsLatestDatasetValuesInput = {
      entity: { siruta_code: '54975' },
      dataset_codes: ['POP107D', 'SOM103A'],
      preferred_classification_codes: ['TOTAL', 'F'],
    };

    const inputB: ListInsLatestDatasetValuesInput = {
      entity: { siruta_code: '54975' },
      dataset_codes: ['SOM103A', 'POP107D'],
      preferred_classification_codes: ['F', 'TOTAL'],
    };

    await cachedRepo.listLatestDatasetValues(inputA);
    await cachedRepo.listLatestDatasetValues(inputB);

    expect(counters.listLatestDatasetValues).toBe(2);
  });

  it('normalizes blank contextCode/period values for UAT dashboard cache keys', async () => {
    await cachedRepo.listUatDatasetsWithObservations('54975', '   ', '   ');
    await cachedRepo.listUatDatasetsWithObservations('54975', undefined, undefined);

    expect(counters.listUatDatasetsWithObservations).toBe(1);
  });

  it('uses 24h TTL for all INS cache writes', async () => {
    const ttlValues: (number | undefined)[] = [];

    const spyCache: SilentCachePort = {
      get: async () => undefined,
      set: async (_key, _value, options) => {
        ttlValues.push(options?.ttlMs);
      },
      delete: async () => false,
      has: async () => false,
      clearByPrefix: async () => 0,
      clear: async () => undefined,
      stats: async () => ({ hits: 0, misses: 0, size: 0 }),
    };

    const keyBuilder = createKeyBuilder();
    const wrapped = wrapInsRepo(createRepo(createCounters()), spyCache, keyBuilder);

    await wrapped.listDatasets({}, 20, 0);
    await wrapped.listContexts({}, 20, 0);
    await wrapped.getDatasetByCode('POP107D');
    await wrapped.listDimensions(1);
    await wrapped.listDimensionValues(1, 0, {}, 50, 0);
    await wrapped.listObservations({
      dataset_codes: ['POP107D'],
      filter: {},
      limit: 10,
      offset: 0,
    });
    await wrapped.listLatestDatasetValues({
      entity: { siruta_code: '54975' },
      dataset_codes: ['POP107D'],
    });
    await wrapped.listUatDatasetsWithObservations('54975', '1', '2024');

    expect(ttlValues).toHaveLength(8);
    for (const ttl of ttlValues) {
      expect(ttl).toBe(INS_TTL_MS);
    }
  });
});
