import { err, ok, type Result } from 'neverthrow';

import { localizeDataset } from './localize-dataset.js';
import { mapAxisType, mapFrequencyToGranularity } from './map-axis-type.js';

import type { DatasetRepoError } from '../errors.js';
import type { DatasetRepo } from '../ports.js';
import type {
  AnalyticsDataPoint,
  AnalyticsSeries,
  Dataset,
  GetStaticChartAnalyticsInput,
  GraphQLAxis,
} from '../types.js';

export interface GetStaticChartAnalyticsDeps {
  datasetRepo: DatasetRepo;
}

/**
 * Convert a dataset to an AnalyticsSeries for GraphQL response.
 * Converts Decimal y values to numbers.
 */
const toAnalyticsSeries = (dataset: Dataset, lang?: string): AnalyticsSeries => {
  const localized = localizeDataset(dataset, lang);

  const xAxis: GraphQLAxis = {
    name: localized.localizedXAxisLabel,
    type: mapAxisType(dataset.axes.x.type),
    // Fallback to axis label (e.g., "Year", "Month") which often describes the unit
    unit: dataset.axes.x.unit ?? dataset.axes.x.label,
    // Granularity from x-axis frequency or metadata frequency
    granularity: mapFrequencyToGranularity(dataset.axes.x.frequency ?? dataset.metadata.frequency),
  };

  const yAxis: GraphQLAxis = {
    name: localized.localizedYAxisLabel,
    type: mapAxisType(dataset.axes.y.type),
    // Fallback to metadata.units which always contains the unit of measurement
    unit: dataset.axes.y.unit ?? dataset.metadata.units,
    // Y-axis typically doesn't have granularity, but include if specified
    granularity: mapFrequencyToGranularity(dataset.axes.y.frequency),
  };

  const data: AnalyticsDataPoint[] = dataset.points.map((point) => ({
    x: point.x,
    y: point.y.toNumber(),
  }));

  return {
    seriesId: dataset.id,
    xAxis,
    yAxis,
    data,
  };
};

/**
 * Get static chart analytics for specified series IDs.
 *
 * Processing:
 * 1. Filter out empty/duplicate seriesIds
 * 2. Fetch datasets by IDs (non-existent IDs silently omitted)
 * 3. Apply localization
 * 4. Map to AnalyticsSeries format
 * 5. Maintain order of requested seriesIds
 */
export const getStaticChartAnalytics = async (
  deps: GetStaticChartAnalyticsDeps,
  input: GetStaticChartAnalyticsInput
): Promise<Result<AnalyticsSeries[], DatasetRepoError>> => {
  // Handle empty seriesIds
  if (input.seriesIds.length === 0) {
    return ok([]);
  }

  // Remove duplicates while preserving order
  const uniqueIds = [...new Set(input.seriesIds)];

  // Fetch datasets by IDs
  const datasetsResult = await deps.datasetRepo.getByIds(uniqueIds);
  if (datasetsResult.isErr()) {
    return err(datasetsResult.error);
  }

  const datasets = datasetsResult.value;

  // Create a map for quick lookup
  const datasetMap = new Map(datasets.map((d) => [d.id, d]));

  // Maintain order of requested seriesIds, skip missing
  const series: AnalyticsSeries[] = [];
  for (const id of uniqueIds) {
    const dataset = datasetMap.get(id);
    if (dataset !== undefined) {
      series.push(toAnalyticsSeries(dataset, input.lang));
    }
  }

  return ok(series);
};
