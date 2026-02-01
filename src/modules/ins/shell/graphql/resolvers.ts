/**
 * INS Module GraphQL Resolvers
 */

import { compareInsUats } from '../../core/usecases/compare-ins-uat.js';
import { getInsDataset } from '../../core/usecases/get-ins-dataset.js';
import { getInsUatDashboard } from '../../core/usecases/get-ins-uat-dashboard.js';
import { getInsUatIndicators } from '../../core/usecases/get-ins-uat-indicators.js';
import { listInsDatasets } from '../../core/usecases/list-ins-datasets.js';
import { listInsDimensionValues } from '../../core/usecases/list-ins-dimension-values.js';
import { listInsObservations } from '../../core/usecases/list-ins-observations.js';

import type { InsRepository } from '../../core/ports.js';
import type {
  InsDataset,
  InsDimension,
  InsDimensionValueFilter,
  InsObservation,
  InsObservationFilter,
  ListInsObservationsInput,
} from '../../core/types.js';
import type { IResolvers, MercuriusContext } from 'mercurius';

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL Input Types
// ─────────────────────────────────────────────────────────────────────────────

interface GqlInsDatasetFilterInput {
  search?: string;
  codes?: string[];
  contextCode?: string;
  periodicity?: ('ANNUAL' | 'QUARTERLY' | 'MONTHLY')[];
  syncStatus?: ('PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'STALE')[];
  hasUatData?: boolean;
}

interface GqlInsObservationFilterInput {
  territoryCodes?: string[];
  sirutaCodes?: string[];
  territoryLevels?: ('NATIONAL' | 'NUTS1' | 'NUTS2' | 'NUTS3' | 'LAU')[];
  unitCodes?: string[];
  classificationValueCodes?: string[];
  classificationTypeCodes?: string[];
  periodicity?: 'ANNUAL' | 'QUARTERLY' | 'MONTHLY';
  years?: number[];
  quarters?: number[];
  months?: number[];
  period?: string;
  periodRange?: { start: string; end: string };
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
    periodicity?: ('ANNUAL' | 'QUARTERLY' | 'MONTHLY')[];
    sync_status?: ('PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'STALE')[];
    has_uat_data?: boolean;
  } = {};

  if (input === undefined) {
    return filter;
  }

  if (input.search !== undefined) filter.search = input.search;
  if (input.codes !== undefined) filter.codes = input.codes;
  if (input.contextCode !== undefined) filter.context_code = input.contextCode;
  if (input.periodicity !== undefined) filter.periodicity = input.periodicity;
  if (input.syncStatus !== undefined) filter.sync_status = input.syncStatus;
  if (input.hasUatData !== undefined) filter.has_uat_data = input.hasUatData;

  return filter;
};

const mapObservationFilter = (input?: GqlInsObservationFilterInput): InsObservationFilter => {
  const filter: InsObservationFilter = {};

  if (input === undefined) {
    return filter;
  }

  if (input.territoryCodes !== undefined) filter.territory_codes = input.territoryCodes;
  if (input.sirutaCodes !== undefined) filter.siruta_codes = input.sirutaCodes;
  if (input.territoryLevels !== undefined) filter.territory_levels = input.territoryLevels;
  if (input.unitCodes !== undefined) filter.unit_codes = input.unitCodes;
  if (input.classificationValueCodes !== undefined)
    filter.classification_value_codes = input.classificationValueCodes;
  if (input.classificationTypeCodes !== undefined)
    filter.classification_type_codes = input.classificationTypeCodes;
  if (input.periodicity !== undefined) filter.periodicity = input.periodicity;
  if (input.years !== undefined) filter.years = input.years;
  if (input.quarters !== undefined) filter.quarters = input.quarters;
  if (input.months !== undefined) filter.months = input.months;
  if (input.period !== undefined) filter.period = input.period;
  if (input.periodRange !== undefined) filter.period_range = input.periodRange;
  if (input.hasValue !== undefined) filter.has_value = input.hasValue;

  return filter;
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
        const filter = mapObservationFilter(args.filter);
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
        args: { sirutaCode: string; period?: string; contextCode?: string },
        context: MercuriusContext
      ) => {
        const input = {
          siruta_code: args.sirutaCode,
        } as { siruta_code: string; period?: string; context_code?: string };

        if (args.period !== undefined) {
          input.period = args.period;
        }
        if (args.contextCode !== undefined) {
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
