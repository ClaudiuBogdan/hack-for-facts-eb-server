import { Type, Static } from '@sinclair/typebox';

/**
 * TypeBox schemas for temporal data validation
 */

export const FrequencySchema = Type.Enum(
  {
    MONTHLY: 'MONTHLY',
    QUARTERLY: 'QUARTERLY',
    YEARLY: 'YEARLY',
  },
  { description: 'Frequency of temporal data points' }
);

export const DataPointSchema = Type.Object(
  {
    date: Type.String({ description: 'Date string: YYYY, YYYY-MM, or YYYY-Q[1-4]' }),
    value: Type.String({ description: 'Decimal value as string (No Float Rule)' }),
  },
  { description: 'A single data point in a time series' }
);

export const DataSeriesSchema = Type.Object(
  {
    frequency: FrequencySchema,
    data: Type.Array(DataPointSchema),
  },
  {
    description:
      'Time series data with consistent frequency. All data requiring normalization ' +
      '(inflation adjustment, currency conversion, etc.) should be in this format.',
  }
);

/**
 * Schema for normalizable data point (internal use)
 */
export const NormalizableDataPointSchema = Type.Object(
  {
    date: Type.String({ description: 'Original date label (YYYY, YYYY-MM, or YYYY-QN)' }),
    year: Type.Integer({ description: 'Parsed year for factor lookups' }),
    value: Type.String({ description: 'Decimal value as string' }),
  },
  { description: 'Data point enriched with parsed year for normalization lookups' }
);

/**
 * DTO types for wire format
 */
export type DataPointDTO = Static<typeof DataPointSchema>;
export type DataSeriesDTO = Static<typeof DataSeriesSchema>;
export type NormalizableDataPointDTO = Static<typeof NormalizableDataPointSchema>;
