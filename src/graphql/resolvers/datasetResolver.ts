import { datasetRepository, DatasetFilter } from '../../db/repositories/datasetRepository';

export const datasetResolver = {
  Query: {
    datasets: async (
      _: any,
      {
        filter = {},
        limit = 100,
        offset = 0,
      }: {
        filter?: DatasetFilter;
        limit?: number;
        offset?: number;
      }
    ) => {
      const nodes = datasetRepository.getAll(filter, limit, offset);
      const totalCount = datasetRepository.count(filter);

      return {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
    staticChartAnalytics: async (_: any, { datasetIds }: { datasetIds: string[] }) => {
      const datasets = datasetRepository.getByIds(datasetIds);
      return datasets.map(d => ({
        datasetId: d.id,
        unit: d.unit,
        yearlyTrend: d.yearlyTrend,
      }));
    },
  },
};
