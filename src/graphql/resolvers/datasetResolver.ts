import { datasetRepository, DatasetFilter, Dataset } from '../../db/repositories/datasetRepository';

type AxisType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE';

const GRANULARITY_DEFAULTS: Record<
  NonNullable<Dataset['xAxis']['granularity']>,
  { name: string; unit: string; type: AxisType }
> = {
  YEAR: { name: 'Year', unit: 'year', type: 'INTEGER' },
  QUARTER: { name: 'Quarter', unit: 'quarter', type: 'STRING' },
  MONTH: { name: 'Month', unit: 'month', type: 'DATE' },
  CATEGORY: { name: 'Category', unit: 'category', type: 'STRING' },
};

function inferGranularity(dataset: Dataset): NonNullable<Dataset['xAxis']['granularity']> {
  if (dataset.xAxis.granularity) {
    return dataset.xAxis.granularity;
  }
  switch (dataset.xAxis.type) {
    case 'INTEGER':
      return 'YEAR';
    case 'DATE':
      return 'MONTH';
    default:
      return 'CATEGORY';
  }
}

function toXAxis(dataset: Dataset) {
  const granularity = inferGranularity(dataset);
  const defaults = GRANULARITY_DEFAULTS[granularity];
  return {
    name: dataset.xAxis.name ?? defaults.name,
    type: dataset.xAxis.type ?? defaults.type,
    unit: dataset.xAxis.unit ?? defaults.unit,
  };
}

function toYAxis(dataset: Dataset) {
  const defaults = {
    name: dataset.title ?? dataset.name ?? 'Value',
    type: (dataset.yAxis.type ?? 'FLOAT') as AxisType,
    unit: dataset.yAxis.unit ?? '',
  };

  return {
    name: dataset.yAxis.name ?? defaults.name,
    type: dataset.yAxis.type ?? defaults.type,
    unit: dataset.yAxis.unit ?? defaults.unit,
  };
}

export const datasetResolver = {
  Query: {
    datasets: async (
      _: any,
      {
        filter = {},
        limit = 100,
        offset = 0,
        lang,
      }: {
        filter?: DatasetFilter;
        limit?: number;
        offset?: number;
        lang?: string;
      }
    ) => {
      const nodes = datasetRepository.getAll(filter, limit, offset, lang);
      const totalCount = datasetRepository.count(filter, lang);

      return {
        nodes,
        pageInfo: {
          totalCount,
          hasNextPage: offset + limit < totalCount,
          hasPreviousPage: offset > 0,
        },
      };
    },
    staticChartAnalytics: async (
      _: any,
      { seriesIds, lang }: { seriesIds: string[]; lang?: string }
    ) => {
      const datasets = datasetRepository.getByIds(seriesIds, lang);
      return datasets.map(d => ({
        seriesId: d.id,
        xAxis: toXAxis(d),
        yAxis: toYAxis(d),
        data: d.data.map(p => ({ x: String(p.x), y: p.y })),
      }));
    },
  },
};
