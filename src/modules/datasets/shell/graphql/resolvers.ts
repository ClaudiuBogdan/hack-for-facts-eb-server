import { type IResolvers, type MercuriusContext } from 'mercurius';

import { getStaticChartAnalytics } from '../../core/usecases/get-static-chart-analytics.js';
import { listDatasets } from '../../core/usecases/list-datasets.js';

import type { DatasetRepo } from '../../core/ports.js';
import type { DatasetFilter } from '../../core/types.js';

/** Default pagination limit */
const DEFAULT_LIMIT = 10;

/** Maximum allowed pagination limit to prevent excessive data retrieval */
const MAX_LIMIT = 100;

export interface MakeDatasetsResolversDeps {
  datasetRepo: DatasetRepo;
}

interface DatasetsQueryArgs {
  filter?: DatasetFilter;
  limit?: number;
  offset?: number;
  lang?: string;
}

interface StaticChartAnalyticsQueryArgs {
  seriesIds: string[];
  lang?: string;
}

export const makeDatasetsResolvers = (deps: MakeDatasetsResolversDeps): IResolvers => {
  return {
    Query: {
      datasets: async (_parent: unknown, args: DatasetsQueryArgs, context: MercuriusContext) => {
        const result = await listDatasets(
          { datasetRepo: deps.datasetRepo },
          {
            filter: args.filter,
            limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
            offset: Math.max(0, args.offset ?? 0),
            lang: args.lang,
          }
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            {
              err: error,
              errorType: error.type,
              filter: args.filter,
            },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },

      staticChartAnalytics: async (
        _parent: unknown,
        args: StaticChartAnalyticsQueryArgs,
        context: MercuriusContext
      ) => {
        const result = await getStaticChartAnalytics(
          { datasetRepo: deps.datasetRepo },
          {
            seriesIds: args.seriesIds,
            lang: args.lang,
          }
        );

        if (result.isErr()) {
          const error = result.error;
          context.reply.log.error(
            {
              err: error,
              errorType: error.type,
              seriesIds: args.seriesIds,
            },
            `[${error.type}] ${error.message}`
          );
          throw new Error(`[${error.type}] ${error.message}`);
        }

        return result.value;
      },
    },
  };
};
