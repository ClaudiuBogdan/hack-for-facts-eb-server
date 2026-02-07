/**
 * INS Module GraphQL Resolvers
 */

import { err, ok, type Result } from 'neverthrow';

import { Frequency } from '@/common/types/temporal.js';

import { createInvalidFilterError, type InsError } from '../../core/errors.js';
import { compareInsUats } from '../../core/usecases/compare-ins-uat.js';
import { getInsDataset } from '../../core/usecases/get-ins-dataset.js';
import { getInsUatDashboard } from '../../core/usecases/get-ins-uat-dashboard.js';
import { getInsUatIndicators } from '../../core/usecases/get-ins-uat-indicators.js';
import { listInsContexts } from '../../core/usecases/list-ins-contexts.js';
import { listInsDatasetDimensionValues } from '../../core/usecases/list-ins-dataset-dimension-values.js';
import { listInsDatasets } from '../../core/usecases/list-ins-datasets.js';
import { listInsDimensionValues } from '../../core/usecases/list-ins-dimension-values.js';
import { listInsLatestDatasetValues } from '../../core/usecases/list-ins-latest-dataset-values.js';
import { listInsObservations } from '../../core/usecases/list-ins-observations.js';

import type { InsRepository } from '../../core/ports.js';
import type {
  InsContextFilter,
  InsDataset,
  InsDimension,
  InsDimensionValueFilter,
  InsEntitySelectorInput,
  InsObservation,
  InsObservationFilter,
  ListInsObservationsInput,
} from '../../core/types.js';
import type {
  GqlReportPeriodInput,
  PeriodType,
  ReportPeriodInput,
} from '@/common/types/analytics.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Input Types
// ─────────────────────────────────────────────────────────────────────────────

interface GqlInsDatasetFilterInput {
  search?: string;
  codes?: string[];
  contextCode?: string;
  rootContextCode?: string;
  periodicity?: ('ANNUAL' | 'QUARTERLY' | 'MONTHLY')[];
  syncStatus?: ('PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'STALE')[];
  hasUatData?: boolean;
  hasCountyData?: boolean;
}

interface GqlInsContextFilterInput {
  search?: string;
  level?: number;
  parentCode?: string;
  rootContextCode?: string;
}

interface GqlInsEntitySelectorInput {
  sirutaCode?: string;
  territoryCode?: string;
  territoryLevel?: 'NATIONAL' | 'NUTS1' | 'NUTS2' | 'NUTS3' | 'LAU';
}

interface GqlInsObservationFilterInput {
  territoryCodes?: string[];
  sirutaCodes?: string[];
  territoryLevels?: ('NATIONAL' | 'NUTS1' | 'NUTS2' | 'NUTS3' | 'LAU')[];
  unitCodes?: string[];
  classificationValueCodes?: string[];
  classificationTypeCodes?: string[];
  period?: GqlReportPeriodInput | null;
  hasValue?: boolean;
}

interface GqlInsDimensionValueFilterInput {
  search?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const mapDatasetFilter = (input?: GqlInsDatasetFilterInput) => {
  const filter: {
    search?: string;
    codes?: string[];
    context_code?: string;
    root_context_code?: string;
    periodicity?: ('ANNUAL' | 'QUARTERLY' | 'MONTHLY')[];
    sync_status?: ('PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'STALE')[];
    has_uat_data?: boolean;
    has_county_data?: boolean;
  } = {};

  if (input === undefined) {
    return filter;
  }

  if (input.search !== undefined) filter.search = input.search;
  if (input.codes !== undefined) filter.codes = input.codes;
  if (input.contextCode !== undefined) filter.context_code = input.contextCode;
  if (input.rootContextCode !== undefined) filter.root_context_code = input.rootContextCode;
  if (input.periodicity !== undefined) filter.periodicity = input.periodicity;
  if (input.syncStatus !== undefined) filter.sync_status = input.syncStatus;
  if (input.hasUatData !== undefined) filter.has_uat_data = input.hasUatData;
  if (input.hasCountyData !== undefined) filter.has_county_data = input.hasCountyData;

  return filter;
};

const mapContextFilter = (input?: GqlInsContextFilterInput): InsContextFilter => {
  const filter: InsContextFilter = {};

  if (input === undefined) {
    return filter;
  }

  if (input.search !== undefined) filter.search = input.search;
  if (input.level !== undefined) filter.level = input.level;
  if (input.parentCode !== undefined) filter.parent_code = input.parentCode;
  if (input.rootContextCode !== undefined) filter.root_context_code = input.rootContextCode;

  return filter;
};

const mapEntitySelector = (input: GqlInsEntitySelectorInput): InsEntitySelectorInput => {
  const selector: InsEntitySelectorInput = {};

  if (input.sirutaCode !== undefined) selector.siruta_code = input.sirutaCode;
  if (input.territoryCode !== undefined) selector.territory_code = input.territoryCode;
  if (input.territoryLevel !== undefined) selector.territory_level = input.territoryLevel;

  return selector;
};

const mapPeriodTypeToFrequency = (periodType: PeriodType): Frequency => {
  switch (periodType) {
    case 'MONTH':
      return Frequency.MONTH;
    case 'QUARTER':
      return Frequency.QUARTER;
    case 'YEAR':
      return Frequency.YEAR;
  }
};

const mapReportPeriod = (input: GqlReportPeriodInput): ReportPeriodInput => ({
  type: mapPeriodTypeToFrequency(input.type),
  selection: input.selection,
});

const mapObservationFilter = (
  input?: GqlInsObservationFilterInput | null
): Result<InsObservationFilter, InsError> => {
  const filter: InsObservationFilter = {};

  if (input === undefined || input === null) {
    return ok(filter);
  }

  if (input.territoryCodes !== undefined) filter.territory_codes = input.territoryCodes;
  if (input.sirutaCodes !== undefined) filter.siruta_codes = input.sirutaCodes;
  if (input.territoryLevels !== undefined) filter.territory_levels = input.territoryLevels;
  if (input.unitCodes !== undefined) filter.unit_codes = input.unitCodes;
  if (input.classificationValueCodes !== undefined)
    filter.classification_value_codes = input.classificationValueCodes;
  if (input.classificationTypeCodes !== undefined)
    filter.classification_type_codes = input.classificationTypeCodes;
  if (input.period === null) {
    return err(createInvalidFilterError('period', 'Invalid period format'));
  }
  if (input.period !== undefined) filter.period = mapReportPeriod(input.period);
  if (input.hasValue !== undefined) filter.has_value = input.hasValue;

  return ok(filter);
};

const mapDimensionValueFilter = (
  input?: GqlInsDimensionValueFilterInput
): InsDimensionValueFilter => {
  const filter: InsDimensionValueFilter = {};
  if (input === undefined) {
    return filter;
  }
  if (input.search !== undefined) filter.search = input.search;
  return filter;
};

const toObservationOutput = (obs: InsObservation) => {
  return {
    ...obs,
    value: obs.value !== null ? obs.value.toString() : null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export interface MakeInsResolversDeps {
  insRepo: InsRepository;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver Factory
// ─────────────────────────────────────────────────────────────────────────────

export const makeInsResolvers = (deps: MakeInsResolversDeps): IResolvers => {
  const { insRepo } = deps;

  return {
    Query: {
      insDatasets: async (
        _parent: unknown,
        args: { filter?: GqlInsDatasetFilterInput; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapDatasetFilter(args.filter);
        const result = await listInsDatasets(
          { insRepo },
          {
            filter,
            limit: args.limit ?? 20,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          context.reply.log.error({ err: result.error, filter }, '[INS] list datasets failed');
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      insDataset: async (
        _parent: unknown,
        args: { code: string },
        context: MercuriusContext
      ): Promise<InsDataset | null> => {
        const result = await getInsDataset({ insRepo }, args.code);

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, code: args.code },
            '[INS] get dataset failed'
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      insDatasetDimensionValues: async (
        _parent: unknown,
        args: {
          datasetCode: string;
          dimensionIndex: number;
          filter?: GqlInsDimensionValueFilterInput;
          limit?: number;
          offset?: number;
        },
        context: MercuriusContext
      ) => {
        const filter = mapDimensionValueFilter(args.filter);
        const result = await listInsDatasetDimensionValues(
          { insRepo },
          {
            dataset_code: args.datasetCode,
            dimension_index: args.dimensionIndex,
            filter,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          context.reply.log.error(
            {
              err: result.error,
              datasetCode: args.datasetCode,
              dimensionIndex: args.dimensionIndex,
            },
            '[INS] list dataset dimension values failed'
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      insContexts: async (
        _parent: unknown,
        args: { filter?: GqlInsContextFilterInput; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapContextFilter(args.filter);
        const result = await listInsContexts(
          { insRepo },
          {
            filter,
            limit: args.limit ?? 20,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          context.reply.log.error({ err: result.error, filter }, '[INS] list contexts failed');
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },

      insObservations: async (
        _parent: unknown,
        args: {
          datasetCode: string;
          filter?: GqlInsObservationFilterInput;
          limit?: number;
          offset?: number;
        },
        context: MercuriusContext
      ) => {
        const mappedFilter = mapObservationFilter(args.filter);
        if (mappedFilter.isErr()) {
          context.reply.log.error(
            { err: mappedFilter.error, filter: args.filter },
            '[INS] invalid observations filter'
          );
          throw new Error(`[${mappedFilter.error.type}] ${mappedFilter.error.message}`);
        }

        const filter = mappedFilter.value;
        const input: ListInsObservationsInput = {
          dataset_codes: [args.datasetCode],
          filter,
          limit: args.limit ?? 50,
          offset: args.offset ?? 0,
        };

        const result = await listInsObservations({ insRepo }, input);

        if (result.isErr()) {
          context.reply.log.error({ err: result.error, filter }, '[INS] list observations failed');
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return {
          ...result.value,
          nodes: result.value.nodes.map(toObservationOutput),
        };
      },

      insUatIndicators: async (
        _parent: unknown,
        args: { sirutaCode: string; period?: string; datasetCodes: string[] },
        context: MercuriusContext
      ) => {
        const input = {
          siruta_code: args.sirutaCode,
          dataset_codes: args.datasetCodes,
        } as { siruta_code: string; dataset_codes: string[]; period?: string };

        if (args.period !== undefined) {
          input.period = args.period;
        }

        const result = await getInsUatIndicators({ insRepo }, input);

        if (result.isErr()) {
          context.reply.log.error({ err: result.error, args }, '[INS] uat indicators failed');
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value.map(toObservationOutput);
      },

      insCompare: async (
        _parent: unknown,
        args: { sirutaCodes: string[]; datasetCode: string; period?: string },
        context: MercuriusContext
      ) => {
        const input = {
          siruta_codes: args.sirutaCodes,
          dataset_code: args.datasetCode,
        } as { siruta_codes: string[]; dataset_code: string; period?: string };

        if (args.period !== undefined) {
          input.period = args.period;
        }

        const result = await compareInsUats({ insRepo }, input);

        if (result.isErr()) {
          context.reply.log.error({ err: result.error, args }, '[INS] compare failed');
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value.map(toObservationOutput);
      },

      insUatDashboard: async (
        _parent: unknown,
        args: { sirutaCode: string; period?: string | null; contextCode?: string | null },
        context: MercuriusContext
      ) => {
        const input = {
          siruta_code: args.sirutaCode,
        } as { siruta_code: string; period?: string; context_code?: string };

        if (args.period !== undefined && args.period !== null) {
          input.period = args.period;
        }
        if (args.contextCode !== undefined && args.contextCode !== null) {
          input.context_code = args.contextCode;
        }

        const result = await getInsUatDashboard({ insRepo }, input);

        if (result.isErr()) {
          context.reply.log.error({ err: result.error, args }, '[INS] uat dashboard failed');
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value.map((group) => ({
          dataset: group.dataset,
          observations: group.observations.map(toObservationOutput),
          latestPeriod: group.latest_period,
        }));
      },

      insLatestDatasetValues: async (
        _parent: unknown,
        args: {
          entity: GqlInsEntitySelectorInput;
          datasetCodes: string[];
          preferredClassificationCodes?: string[];
        },
        context: MercuriusContext
      ) => {
        const request = {
          entity: mapEntitySelector(args.entity),
          dataset_codes: args.datasetCodes,
        } as {
          entity: InsEntitySelectorInput;
          dataset_codes: string[];
          preferred_classification_codes?: string[];
        };
        if (args.preferredClassificationCodes !== undefined) {
          request.preferred_classification_codes = args.preferredClassificationCodes;
        }

        const result = await listInsLatestDatasetValues({ insRepo }, request);

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, args },
            '[INS] list latest dataset values failed'
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value.map((item) => ({
          dataset: item.dataset,
          observation: item.observation !== null ? toObservationOutput(item.observation) : null,
          latestPeriod: item.latest_period,
          matchStrategy: item.match_strategy,
          hasData: item.has_data,
        }));
      },
    },

    InsDataset: {
      dimensions: async (
        parent: InsDataset,
        _args: unknown,
        context: MercuriusContext
      ): Promise<InsDimension[]> => {
        const result = await insRepo.listDimensions(parent.id);

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, dataset: parent.code },
            '[INS] list dimensions failed'
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },
    },

    InsDimension: {
      values: async (
        parent: InsDimension,
        args: { filter?: GqlInsDimensionValueFilterInput; limit?: number; offset?: number },
        context: MercuriusContext
      ) => {
        const filter = mapDimensionValueFilter(args.filter);
        const result = await listInsDimensionValues(
          { insRepo },
          {
            matrix_id: parent.matrix_id,
            dim_index: parent.index,
            filter,
            limit: args.limit ?? 50,
            offset: args.offset ?? 0,
          }
        );

        if (result.isErr()) {
          context.reply.log.error(
            { err: result.error, matrixId: parent.matrix_id, dimIndex: parent.index },
            '[INS] list dimension values failed'
          );
          throw new Error(`[${result.error.type}] ${result.error.message}`);
        }

        return result.value;
      },
    },
  };
};
