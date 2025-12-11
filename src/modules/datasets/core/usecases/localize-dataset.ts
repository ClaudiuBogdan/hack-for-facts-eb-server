import { mapAxisType, mapFrequencyToGranularity } from './map-axis-type.js';

import type { Dataset, DatasetSummary, GraphQLAxis } from '../types.js';

/**
 * Intermediate type with localized content.
 */
export interface LocalizedDataset {
  id: string;
  metadata: Dataset['metadata'];
  i18n: Dataset['i18n'];
  axes: Dataset['axes'];
  points: Dataset['points'];
  localizedTitle: string;
  localizedDescription: string;
  localizedXAxisLabel: string;
  localizedYAxisLabel: string;
}

/**
 * Check if the language code is English.
 * Handles: 'en', 'en-US', 'en-GB', 'EN', etc.
 */
const isEnglishLang = (lang: string | undefined): boolean => {
  if (lang === undefined || lang === '') {
    return false;
  }
  return lang.toLowerCase().startsWith('en');
};

/**
 * Apply localization to a dataset based on language preference.
 * Falls back to Romanian (ro) if English is not available.
 */
export const localizeDataset = (dataset: Dataset, lang?: string): LocalizedDataset => {
  const useEnglish = isEnglishLang(lang);
  const i18n = useEnglish && dataset.i18n.en !== undefined ? dataset.i18n.en : dataset.i18n.ro;

  return {
    ...dataset,
    localizedTitle: i18n.title,
    localizedDescription: i18n.description ?? '',
    localizedXAxisLabel: i18n.xAxisLabel,
    localizedYAxisLabel: i18n.yAxisLabel,
  };
};

/**
 * Convert a localized dataset to a DatasetSummary for GraphQL response.
 * Maps internal types to GraphQL types.
 */
export const toDatasetSummary = (localized: LocalizedDataset): DatasetSummary => {
  const xAxis: GraphQLAxis = {
    name: localized.localizedXAxisLabel,
    type: mapAxisType(localized.axes.x.type),
    // Fallback to axis label (e.g., "Year", "Month") which often describes the unit
    unit: localized.axes.x.unit ?? localized.axes.x.label,
    // Granularity from x-axis frequency or metadata frequency
    granularity: mapFrequencyToGranularity(
      localized.axes.x.frequency ?? localized.metadata.frequency
    ),
  };

  const yAxis: GraphQLAxis = {
    name: localized.localizedYAxisLabel,
    type: mapAxisType(localized.axes.y.type),
    // Fallback to metadata.units which always contains the unit of measurement
    unit: localized.axes.y.unit ?? localized.metadata.units,
    // Y-axis typically doesn't have granularity, but include if specified
    granularity: mapFrequencyToGranularity(localized.axes.y.frequency),
  };

  return {
    id: localized.id,
    name: localized.localizedTitle,
    title: localized.localizedTitle,
    description: localized.localizedDescription,
    sourceName: localized.metadata.source,
    sourceUrl: localized.metadata.sourceUrl ?? null,
    xAxis,
    yAxis,
  };
};
