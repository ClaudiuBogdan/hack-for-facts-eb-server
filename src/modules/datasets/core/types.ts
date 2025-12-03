import { Static, Type } from '@sinclair/typebox';
import { Decimal } from 'decimal.js';

const I18nContentSchema = Type.Object({
  title: Type.String(),
  description: Type.Optional(Type.String()),
  xAxisLabel: Type.String({ description: 'Translated label for X Axis' }),
  yAxisLabel: Type.String({ description: 'Translated label for Y Axis' }),
});

const GranularitySchema = Type.Union([
  Type.Literal('annual'),
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
  granularity: Type.Optional(GranularitySchema),
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
    granularity: Type.Optional(GranularitySchema),
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
export type DatasetGranularity = Static<typeof GranularitySchema>;

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
