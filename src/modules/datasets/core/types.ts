import { type Static, Type } from '@sinclair/typebox';
import { Decimal } from 'decimal.js';

const I18nContentSchema = Type.Object({
  title: Type.String(),
  description: Type.Optional(Type.String()),
  xAxisLabel: Type.String({ description: 'Translated label for X Axis' }),
  yAxisLabel: Type.String({ description: 'Translated label for Y Axis' }),
});

/**
 * Frequency schema for dataset files.
 * Uses lowercase values in YAML files for readability (annual, monthly, quarterly).
 */
const DatasetFrequencySchema = Type.Union([
  Type.Literal('yearly'),
  Type.Literal('monthly'),
  Type.Literal('quarterly'),
]);

const AxesTypeSchema = Type.Union([
  Type.Literal('date'),
  Type.Literal('category'),
  Type.Literal('number'),
]);

const AxisSchema = Type.Object({
  label: Type.String(),
  type: AxesTypeSchema,
  unit: Type.Optional(Type.String()),
  frequency: Type.Optional(DatasetFrequencySchema),
  format: Type.Optional(Type.String({ description: 'Display format hint, e.g. YYYY' })),
});

const DataPointSchema = Type.Object({
  x: Type.String({ description: 'Date string or Category Label' }),
  y: Type.String({ description: 'Decimal value as string (No Float Rule)' }),
});

export const DatasetFileSchema = Type.Object({
  metadata: Type.Object({
    id: Type.String(),
    source: Type.String(),
    sourceUrl: Type.Optional(Type.String()),
    lastUpdated: Type.String(),
    units: Type.String(),
    frequency: Type.Optional(DatasetFrequencySchema),
  }),

  i18n: Type.Object({
    ro: I18nContentSchema,
    en: Type.Optional(I18nContentSchema),
  }),

  axes: Type.Object({
    x: AxisSchema,
    y: AxisSchema,
  }),

  data: Type.Array(DataPointSchema),
});

export type DatasetFileDTO = Static<typeof DatasetFileSchema>;

export type DatasetAxesType = Static<typeof AxesTypeSchema>;

/**
 * Dataset frequency type (lowercase for YAML files).
 * Maps to Frequency enum: annual -> YEARLY, monthly -> MONTHLY, quarterly -> QUARTERLY
 */
export type DatasetFrequency = Static<typeof DatasetFrequencySchema>;

export interface DataPoint {
  x: string;
  y: Decimal;
}

export interface Dataset {
  id: string;
  metadata: DatasetFileDTO['metadata'];
  i18n: DatasetFileDTO['i18n'];
  axes: DatasetFileDTO['axes'];
  points: DataPoint[];
}

export interface DatasetFileEntry {
  id: string;
  absolutePath: string;
  relativePath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL-oriented types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GraphQL axis data type enum.
 * Mapped from internal 'date' | 'category' | 'number' types.
 */
export type AxisDataType = 'STRING' | 'INTEGER' | 'FLOAT' | 'DATE';

/**
 * Granularity of time-based axis data.
 * Used for charts to determine appropriate display formatting.
 */
export type AxisGranularity = 'YEAR' | 'QUARTER' | 'MONTH' | 'CATEGORY';

/**
 * GraphQL axis representation for chart display.
 */
export interface GraphQLAxis {
  name: string;
  type: AxisDataType;
  unit: string;
  granularity?: AxisGranularity;
}

/**
 * Dataset summary for listing (excludes data points).
 */
export interface DatasetSummary {
  id: string;
  name: string; // Mapped from i18n.{lang}.title
  title: string; // Mapped from i18n.{lang}.title
  description: string; // Mapped from i18n.{lang}.description ?? ''
  sourceName: string | null;
  sourceUrl: string | null;
  xAxis: GraphQLAxis;
  yAxis: GraphQLAxis;
}

/**
 * Pagination metadata for dataset listing.
 */
export interface DatasetPageInfo {
  totalCount: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Paginated dataset listing result.
 */
export interface DatasetConnection {
  nodes: DatasetSummary[];
  pageInfo: DatasetPageInfo;
}

/**
 * Filter input for dataset listing.
 */
export interface DatasetFilter {
  search?: string;
  ids?: string[];
}

/**
 * Input for list datasets use case.
 */
export interface ListDatasetsInput {
  filter?: DatasetFilter | undefined;
  limit: number;
  offset: number;
  lang?: string | undefined;
}

/**
 * Data point for analytics series (y as number for GraphQL).
 */
export interface AnalyticsDataPoint {
  x: string;
  y: number;
}

/**
 * Analytics series for chart display.
 */
export interface AnalyticsSeries {
  seriesId: string;
  xAxis: GraphQLAxis;
  yAxis: GraphQLAxis;
  data: AnalyticsDataPoint[];
}

/**
 * Input for get static chart analytics use case.
 */
export interface GetStaticChartAnalyticsInput {
  seriesIds: string[];
  lang?: string | undefined;
}
