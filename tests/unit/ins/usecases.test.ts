import { Decimal } from 'decimal.js';
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  MAX_COMPARE_LIMIT,
  MAX_DATASET_LIMIT,
  MAX_DIMENSION_VALUES_LIMIT,
  MAX_OBSERVATION_LIMIT,
  MAX_UAT_INDICATORS_LIMIT,
  type InsDataset,
  type InsDatasetConnection,
  type InsDimensionValueConnection,
  type InsObservation,
  type InsObservationConnection,
  type InsObservationFilter,
} from '@/modules/ins/core/types.js';
import { compareInsUats } from '@/modules/ins/core/usecases/compare-ins-uat.js';
import { getInsUatDashboard } from '@/modules/ins/core/usecases/get-ins-uat-dashboard.js';
import { getInsUatIndicators } from '@/modules/ins/core/usecases/get-ins-uat-indicators.js';
import { listInsDatasets } from '@/modules/ins/core/usecases/list-ins-datasets.js';
import { listInsDimensionValues } from '@/modules/ins/core/usecases/list-ins-dimension-values.js';
import { listInsObservations } from '@/modules/ins/core/usecases/list-ins-observations.js';

import type { InsRepository } from '@/modules/ins/core/ports.js';

const emptyDatasetConnection: InsDatasetConnection = {
  nodes: [],
  pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
};

const emptyDimensionValueConnection: InsDimensionValueConnection = {
  nodes: [],
  pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
};

const emptyObservationConnection: InsObservationConnection = {
  nodes: [],
  pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
};

const makeDataset = (overrides: Partial<InsDataset> = {}): InsDataset => ({
  id: 1,
  code: 'TEST001',
  name_ro: 'Test Dataset',
  name_en: null,
  definition_ro: null,
  definition_en: null,
  periodicity: ['ANNUAL'],
  year_range: [2020, 2023],
  dimension_count: 3,
  has_uat_data: true,
  has_county_data: false,
  has_siruta: true,
  sync_status: 'SYNCED',
  last_sync_at: null,
  context_code: null,
  context_name_ro: null,
  context_name_en: null,
  context_path: null,
  metadata: null,
  ...overrides,
});

const makeObservation = (overrides: Partial<InsObservation> = {}): InsObservation => ({
  id: '1',
  dataset_code: 'ACC101B',
  matrix_id: 1,
  territory: null,
  time_period: {
    id: 1,
    year: 2020,
    quarter: null,
    month: null,
    periodicity: 'ANNUAL',
    period_start: new Date('2020-01-01'),
    period_end: new Date('2020-12-31'),
    label_ro: null,
    label_en: null,
    iso_period: '2020',
  },
  unit: null,
  value: new Decimal('12'),
  value_status: null,
  classifications: [],
  dimensions: {},
  ...overrides,
});

const makeRepo = (overrides: Partial<InsRepository> = {}): InsRepository => ({
  listDatasets: async () => ok(emptyDatasetConnection),
  getDatasetByCode: async () => ok(null),
  listDimensions: async () => ok([]),
  listDimensionValues: async () => ok(emptyDimensionValueConnection),
  listObservations: async () => ok(emptyObservationConnection),
  listUatDatasetsWithObservations: async () => ok([]),
  ...overrides,
});

describe('INS usecases', () => {
  describe('listInsDatasets', () => {
    it('clamps limit and offset', async () => {
      let captured: { limit: number; offset: number } | null = null;

      const repo = makeRepo({
        listDatasets: async (_filter, limit, offset) => {
          captured = { limit, offset };
          return ok(emptyDatasetConnection);
        },
      });

      const result = await listInsDatasets(
        { insRepo: repo },
        { filter: {}, limit: MAX_DATASET_LIMIT + 50, offset: -10 }
      );

      expect(result.isOk()).toBe(true);
      if (captured === null) {
        throw new Error('Expected listDatasets to be called');
      }
      const capturedValue = captured as { limit: number; offset: number };
      expect(capturedValue.limit).toBe(MAX_DATASET_LIMIT);
      expect(capturedValue.offset).toBe(0);
    });
  });

  describe('listInsDimensionValues', () => {
    it('clamps limit and offset', async () => {
      let captured: { matrixId: number; dimIndex: number; limit: number; offset: number } | null =
        null;

      const repo = makeRepo({
        listDimensionValues: async (matrixId, dimIndex, _filter, limit, offset) => {
          captured = { matrixId, dimIndex, limit, offset };
          return ok(emptyDimensionValueConnection);
        },
      });

      const result = await listInsDimensionValues(
        { insRepo: repo },
        {
          matrix_id: 42,
          dim_index: 1,
          filter: {},
          limit: MAX_DIMENSION_VALUES_LIMIT + 10,
          offset: -5,
        }
      );

      expect(result.isOk()).toBe(true);
      if (captured === null) {
        throw new Error('Expected listDimensionValues to be called');
      }
      const capturedValue = captured as {
        matrixId: number;
        dimIndex: number;
        limit: number;
        offset: number;
      };
      expect(capturedValue.matrixId).toBe(42);
      expect(capturedValue.dimIndex).toBe(1);
      expect(capturedValue.limit).toBe(MAX_DIMENSION_VALUES_LIMIT);
      expect(capturedValue.offset).toBe(0);
    });
  });

  describe('listInsObservations', () => {
    it('returns empty when dataset_codes is empty', async () => {
      let called = false;

      const repo = makeRepo({
        listObservations: async () => {
          called = true;
          return ok(emptyObservationConnection);
        },
      });

      const result = await listInsObservations(
        { insRepo: repo },
        { dataset_codes: [], filter: {}, limit: 10, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const connection = result._unsafeUnwrap();
      expect(connection.nodes).toHaveLength(0);
      expect(connection.pageInfo.totalCount).toBe(0);
      expect(called).toBe(false);
    });

    it('clamps limit and offset and forwards filters', async () => {
      let captured: {
        dataset_codes: string[];
        filter?: InsObservationFilter;
        limit: number;
        offset: number;
      } | null = null;

      const repo = makeRepo({
        listObservations: async (input) => {
          captured = input;
          return ok(emptyObservationConnection);
        },
      });

      const result = await listInsObservations(
        { insRepo: repo },
        {
          dataset_codes: ['ACC101B'],
          filter: { period: '2020' },
          limit: MAX_OBSERVATION_LIMIT + 500,
          offset: -2,
        }
      );

      expect(result.isOk()).toBe(true);
      if (captured === null) {
        throw new Error('Expected listObservations to be called');
      }
      const capturedValue = captured as {
        dataset_codes: string[];
        filter?: InsObservationFilter;
        limit: number;
        offset: number;
      };
      expect(capturedValue.dataset_codes).toEqual(['ACC101B']);
      expect(capturedValue.filter).toEqual({ period: '2020' });
      expect(capturedValue.limit).toBe(MAX_OBSERVATION_LIMIT);
      expect(capturedValue.offset).toBe(0);
    });
  });

  describe('getInsUatIndicators', () => {
    it('returns invalid filter error when dataset codes are missing', async () => {
      const repo = makeRepo();
      const result = await getInsUatIndicators(
        { insRepo: repo },
        { siruta_code: '123', dataset_codes: [] }
      );

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      if (error.type !== 'InvalidFilterError') {
        throw new Error(`Expected InvalidFilterError, got ${error.type}`);
      }
      expect(error.field).toBe('datasetCodes');
    });

    it('maps siruta and period filters and returns observations', async () => {
      let captured: {
        dataset_codes: string[];
        filter: InsObservationFilter | undefined;
        limit: number;
      } | null = null;

      const observations = [makeObservation({ id: 'obs-1' })];

      const repo = makeRepo({
        listObservations: async (input) => {
          captured = {
            dataset_codes: input.dataset_codes,
            filter: input.filter,
            limit: input.limit,
          };
          return ok({
            ...emptyObservationConnection,
            nodes: observations,
            pageInfo: {
              totalCount: observations.length,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          });
        },
      });

      const result = await getInsUatIndicators(
        { insRepo: repo },
        { siruta_code: '123', dataset_codes: ['ACC101B'], period: '2020' }
      );

      expect(result.isOk()).toBe(true);
      if (captured === null) {
        throw new Error('Expected listObservations to be called');
      }
      const capturedValue = captured as {
        dataset_codes: string[];
        filter?: InsObservationFilter;
        limit: number;
      };
      expect(capturedValue.dataset_codes).toEqual(['ACC101B']);
      expect(capturedValue.filter).toEqual({ siruta_codes: ['123'], period: '2020' });
      expect(capturedValue.limit).toBe(MAX_UAT_INDICATORS_LIMIT);
      expect(result._unsafeUnwrap()).toEqual(observations);
    });
  });

  describe('compareInsUats', () => {
    it('returns invalid filter error when siruta codes are missing', async () => {
      const repo = makeRepo();
      const result = await compareInsUats(
        { insRepo: repo },
        { siruta_codes: [], dataset_code: 'ACC101B' }
      );

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      if (error.type !== 'InvalidFilterError') {
        throw new Error(`Expected InvalidFilterError, got ${error.type}`);
      }
      expect(error.field).toBe('sirutaCodes');
    });

    it('returns invalid filter error when dataset code is empty', async () => {
      const repo = makeRepo();
      const result = await compareInsUats(
        { insRepo: repo },
        { siruta_codes: ['123'], dataset_code: ' ' }
      );

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      if (error.type !== 'InvalidFilterError') {
        throw new Error(`Expected InvalidFilterError, got ${error.type}`);
      }
      expect(error.field).toBe('datasetCode');
    });

    it('maps siruta and period filters and returns observations', async () => {
      let captured: {
        dataset_codes: string[];
        filter: InsObservationFilter | undefined;
        limit: number;
      } | null = null;

      const observations = [makeObservation({ id: 'obs-compare' })];

      const repo = makeRepo({
        listObservations: async (input) => {
          captured = {
            dataset_codes: input.dataset_codes,
            filter: input.filter,
            limit: input.limit,
          };
          return ok({
            ...emptyObservationConnection,
            nodes: observations,
            pageInfo: {
              totalCount: observations.length,
              hasNextPage: false,
              hasPreviousPage: false,
            },
          });
        },
      });

      const result = await compareInsUats(
        { insRepo: repo },
        { siruta_codes: ['123', '456'], dataset_code: 'ACC101B', period: '2020' }
      );

      expect(result.isOk()).toBe(true);
      if (captured === null) {
        throw new Error('Expected listObservations to be called');
      }
      const capturedValue = captured as {
        dataset_codes: string[];
        filter?: InsObservationFilter;
        limit: number;
      };
      expect(capturedValue.dataset_codes).toEqual(['ACC101B']);
      expect(capturedValue.filter).toEqual({ siruta_codes: ['123', '456'], period: '2020' });
      expect(capturedValue.limit).toBe(MAX_COMPARE_LIMIT);
      expect(result._unsafeUnwrap()).toEqual(observations);
    });
  });

  describe('getInsUatDashboard', () => {
    it('returns invalid filter error when siruta code is empty', async () => {
      const repo = makeRepo();
      const result = await getInsUatDashboard({ insRepo: repo }, { siruta_code: ' ' });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      if (error.type !== 'InvalidFilterError') {
        throw new Error(`Expected InvalidFilterError, got ${error.type}`);
      }
      expect(error.field).toBe('sirutaCode');
    });

    it('returns empty array when no UAT datasets found', async () => {
      const repo = makeRepo({
        listUatDatasetsWithObservations: async () => ok([]),
      });

      const result = await getInsUatDashboard({ insRepo: repo }, { siruta_code: '54975' });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('groups datasets with observations and extracts latest period', async () => {
      const dataset = makeDataset({ id: 1, code: 'LOC101B' });
      const obs1 = makeObservation({
        id: 'obs-1',
        dataset_code: 'LOC101B',
        time_period: {
          id: 2,
          year: 2022,
          quarter: null,
          month: null,
          periodicity: 'ANNUAL',
          period_start: new Date('2022-01-01'),
          period_end: new Date('2022-12-31'),
          label_ro: null,
          label_en: null,
          iso_period: '2022',
        },
      });
      const obs2 = makeObservation({
        id: 'obs-2',
        dataset_code: 'LOC101B',
        time_period: {
          id: 1,
          year: 2021,
          quarter: null,
          month: null,
          periodicity: 'ANNUAL',
          period_start: new Date('2021-01-01'),
          period_end: new Date('2021-12-31'),
          label_ro: null,
          label_en: null,
          iso_period: '2021',
        },
      });

      let captured: { sirutaCode: string; contextCode?: string; period?: string } | null = null;

      const repo = makeRepo({
        listUatDatasetsWithObservations: async (sirutaCode, contextCode, period) => {
          captured = { sirutaCode };
          if (contextCode !== undefined) captured.contextCode = contextCode;
          if (period !== undefined) captured.period = period;
          return ok([{ dataset, observations: [obs1, obs2] }]);
        },
      });

      const result = await getInsUatDashboard(
        { insRepo: repo },
        { siruta_code: '54975', period: '2022', context_code: 'CTX01' }
      );

      expect(result.isOk()).toBe(true);
      const groups = result._unsafeUnwrap();
      expect(groups).toHaveLength(1);
      expect(groups[0]!.dataset.code).toBe('LOC101B');
      expect(groups[0]!.observations).toHaveLength(2);
      expect(groups[0]!.latest_period).toBe('2022');

      if (captured === null) {
        throw new Error('Expected listUatDatasetsWithObservations to be called');
      }

      const capturedValue = captured as {
        sirutaCode: string;
        contextCode?: string;
        period?: string;
      };
      expect(capturedValue.sirutaCode).toBe('54975');
      expect(capturedValue.contextCode).toBe('CTX01');
      expect(capturedValue.period).toBe('2022');
    });

    it('passes through context_code and period to repo', async () => {
      let captured: { sirutaCode: string; contextCode?: string; period?: string } | null = null;

      const repo = makeRepo({
        listUatDatasetsWithObservations: async (sirutaCode, contextCode, period) => {
          captured = { sirutaCode };
          if (contextCode !== undefined) captured.contextCode = contextCode;
          if (period !== undefined) captured.period = period;
          return ok([]);
        },
      });

      await getInsUatDashboard({ insRepo: repo }, { siruta_code: '54975' });

      if (captured === null) {
        throw new Error('Expected listUatDatasetsWithObservations to be called');
      }

      const capturedValue = captured as {
        sirutaCode: string;
        contextCode?: string;
        period?: string;
      };
      expect(capturedValue.sirutaCode).toBe('54975');
      expect(capturedValue.contextCode).toBeUndefined();
      expect(capturedValue.period).toBeUndefined();
    });
  });
});
