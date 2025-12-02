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

export const DataPointSchema = Type.Object({
  date: Type.String({ format: 'date', description: 'ISO 8601 date (YYYY-MM-DD)' }),
  value: Type.String({ description: 'Decimal value as string (No Float Rule)' }),
});

export const DataSeriesSchema = Type.Object({
  frequency: FrequencySchema,
  data: Type.Array(DataPointSchema),
});

/**
 * DTO types for wire format
 */
export type DataPointDTO = Static<typeof DataPointSchema>;
export type DataSeriesDTO = Static<typeof DataSeriesSchema>;
