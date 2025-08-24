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
    staticChartAnalytics: async (_: any, { seriesIds }: { seriesIds: string[] }) => {
      const datasets = datasetRepository.getByIds(seriesIds);
      return datasets.map(d => ({
        seriesId: d.id,
        xAxis: { name: 'Year', type: 'INTEGER', unit: 'year' },
        yAxis: { name: d.name ?? 'Amount', type: 'FLOAT', unit: d.unit },
        data: d.yearlyTrend.map(p => ({ x: String(p.year), y: p.value })),
      }));
    },
  },
};
