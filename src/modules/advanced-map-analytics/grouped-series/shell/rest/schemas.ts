/**
 * Advanced Map Analytics REST API Schemas
 */

import { Type, type Static } from '@sinclair/typebox';

// ─────────────────────────────────────────────────────────────────────────────
// Request Schemas
// ─────────────────────────────────────────────────────────────────────────────

const MapSeriesBaseFields = {
  id: Type.String({ minLength: 1 }),
  unit: Type.Optional(Type.String()),
};

const MapSeriesInputBaseFields = {
  id: Type.Optional(Type.String({ minLength: 1 })),
  unit: Type.Optional(Type.String()),
};

const PeriodDateSchema = Type.String({ minLength: 4 });

const ReportPeriodSelectionSchema = Type.Union([
  Type.Object(
    {
      interval: Type.Object({
        start: PeriodDateSchema,
        end: PeriodDateSchema,
      }),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      dates: Type.Array(PeriodDateSchema, { minItems: 1 }),
    },
    { additionalProperties: false }
  ),
]);

const ReportPeriodInputSchema = Type.Object(
  {
    type: Type.Union([Type.Literal('YEAR'), Type.Literal('MONTH'), Type.Literal('QUARTER')]),
    selection: ReportPeriodSelectionSchema,
  },
  { additionalProperties: false }
);

const ExecutionFilterSchema = Type.Object(
  {
    account_category: Type.Union([Type.Literal('ch'), Type.Literal('vn')]),
    report_period: ReportPeriodInputSchema,
    report_type: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true }
);

const CommitmentsFilterSchema = Type.Object(
  {
    report_period: ReportPeriodInputSchema,
    report_type: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: true }
);

export const ExecutionMapSeriesSchema = Type.Object(
  {
    ...MapSeriesBaseFields,
    type: Type.Literal('line-items-aggregated-yearly'),
    filter: ExecutionFilterSchema,
  },
  { additionalProperties: true }
);

export const ExecutionMapSeriesInputSchema = Type.Object(
  {
    ...MapSeriesInputBaseFields,
    type: Type.Literal('line-items-aggregated-yearly'),
    filter: ExecutionFilterSchema,
  },
  { additionalProperties: true }
);

export const CommitmentsMapSeriesSchema = Type.Object(
  {
    ...MapSeriesBaseFields,
    type: Type.Literal('commitments-analytics'),
    metric: Type.Union([
      Type.Literal('CREDITE_ANGAJAMENT'),
      Type.Literal('PLATI_TREZOR'),
      Type.Literal('PLATI_NON_TREZOR'),
      Type.Literal('RECEPTII_TOTALE'),
      Type.Literal('RECEPTII_NEPLATITE_CHANGE'),
      Type.Literal('LIMITA_CREDIT_ANGAJAMENT'),
      Type.Literal('CREDITE_BUGETARE'),
      Type.Literal('CREDITE_ANGAJAMENT_INITIALE'),
      Type.Literal('CREDITE_BUGETARE_INITIALE'),
      Type.Literal('CREDITE_ANGAJAMENT_DEFINITIVE'),
      Type.Literal('CREDITE_BUGETARE_DEFINITIVE'),
      Type.Literal('CREDITE_ANGAJAMENT_DISPONIBILE'),
      Type.Literal('CREDITE_BUGETARE_DISPONIBILE'),
      Type.Literal('RECEPTII_NEPLATITE'),
    ]),
    filter: CommitmentsFilterSchema,
  },
  { additionalProperties: true }
);

export const CommitmentsMapSeriesInputSchema = Type.Object(
  {
    ...MapSeriesInputBaseFields,
    type: Type.Literal('commitments-analytics'),
    metric: CommitmentsMapSeriesSchema.properties.metric,
    filter: CommitmentsFilterSchema,
  },
  { additionalProperties: true }
);

export const InsMapSeriesSchema = Type.Object(
  {
    ...MapSeriesBaseFields,
    type: Type.Literal('ins-series'),
    datasetCode: Type.Optional(Type.String({ minLength: 1 })),
    period: Type.Optional(ReportPeriodInputSchema),
    aggregation: Type.Optional(
      Type.Union([Type.Literal('sum'), Type.Literal('average'), Type.Literal('first')])
    ),
    territoryCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    sirutaCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    unitCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    classificationSelections: Type.Optional(
      Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 })))
    ),
    hasValue: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true }
);

export const InsMapSeriesInputSchema = Type.Object(
  {
    ...MapSeriesInputBaseFields,
    type: Type.Literal('ins-series'),
    datasetCode: Type.Optional(Type.String({ minLength: 1 })),
    period: Type.Optional(ReportPeriodInputSchema),
    aggregation: Type.Optional(
      Type.Union([Type.Literal('sum'), Type.Literal('average'), Type.Literal('first')])
    ),
    territoryCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    sirutaCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    unitCodes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    classificationSelections: Type.Optional(
      Type.Record(Type.String(), Type.Array(Type.String({ minLength: 1 })))
    ),
    hasValue: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: true }
);

const UploadedMapDatasetSeriesByIdSchema = Type.Object(
  {
    ...MapSeriesBaseFields,
    type: Type.Literal('uploaded-map-dataset'),
    datasetId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

const UploadedMapDatasetSeriesByIdInputSchema = Type.Object(
  {
    ...MapSeriesInputBaseFields,
    type: Type.Literal('uploaded-map-dataset'),
    datasetId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

const UploadedMapDatasetSeriesByPublicIdSchema = Type.Object(
  {
    ...MapSeriesBaseFields,
    type: Type.Literal('uploaded-map-dataset'),
    datasetPublicId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

const UploadedMapDatasetSeriesByPublicIdInputSchema = Type.Object(
  {
    ...MapSeriesInputBaseFields,
    type: Type.Literal('uploaded-map-dataset'),
    datasetPublicId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export const UploadedMapDatasetSeriesSchema = Type.Union([
  UploadedMapDatasetSeriesByIdSchema,
  UploadedMapDatasetSeriesByPublicIdSchema,
]);

export const UploadedMapDatasetSeriesInputSchema = Type.Union([
  UploadedMapDatasetSeriesByIdInputSchema,
  UploadedMapDatasetSeriesByPublicIdInputSchema,
]);

export const MapRequestSeriesSchema = Type.Union([
  ExecutionMapSeriesSchema,
  CommitmentsMapSeriesSchema,
  InsMapSeriesSchema,
  UploadedMapDatasetSeriesSchema,
]);

export const MapRequestSeriesInputSchema = Type.Union([
  ExecutionMapSeriesInputSchema,
  CommitmentsMapSeriesInputSchema,
  InsMapSeriesInputSchema,
  UploadedMapDatasetSeriesInputSchema,
]);

export const GroupedSeriesPayloadRequestSchema = Type.Object(
  {
    format: Type.Literal('csv_wide_matrix_v1'),
    compression: Type.Literal('none'),
  },
  { additionalProperties: false }
);

export const GroupedSeriesDataBodySchema = Type.Object(
  {
    granularity: Type.Literal('UAT'),
    series: Type.Array(MapRequestSeriesSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    payload: GroupedSeriesPayloadRequestSchema,
  },
  { additionalProperties: false }
);

export const GroupedSeriesDataBodyInputSchema = Type.Object(
  {
    granularity: Type.Literal('UAT'),
    series: Type.Array(MapRequestSeriesInputSchema, {
      minItems: 1,
      maxItems: 64,
    }),
    payload: GroupedSeriesPayloadRequestSchema,
  },
  { additionalProperties: false }
);

export type GroupedSeriesDataBody = Static<typeof GroupedSeriesDataBodySchema>;
export type GroupedSeriesDataBodyInput = Static<typeof GroupedSeriesDataBodyInputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const GroupedSeriesWarningSchema = Type.Object(
  {
    type: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    seriesId: Type.Optional(Type.String({ minLength: 1 })),
    sirutaCode: Type.Optional(Type.String({ minLength: 1 })),
    details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false }
);

export const GroupedSeriesManifestEntrySchema = Type.Object(
  {
    series_id: Type.String({ minLength: 1 }),
    unit: Type.Optional(Type.String({ minLength: 1 })),
    defined_value_count: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false }
);

export const GroupedSeriesManifestSchema = Type.Object(
  {
    generated_at: Type.String({ format: 'date-time' }),
    format: Type.Literal('wide_matrix_v1'),
    granularity: Type.Literal('UAT'),
    series: Type.Array(GroupedSeriesManifestEntrySchema),
  },
  { additionalProperties: false }
);

export const GroupedSeriesPayloadResponseSchema = Type.Object(
  {
    mime: Type.Literal('text/csv'),
    compression: Type.Literal('none'),
    data: Type.String(),
  },
  { additionalProperties: false }
);

export const GroupedSeriesDataSchema = Type.Object(
  {
    manifest: GroupedSeriesManifestSchema,
    payload: GroupedSeriesPayloadResponseSchema,
    warnings: Type.Array(GroupedSeriesWarningSchema),
  },
  { additionalProperties: false }
);

export const GroupedSeriesDataResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: GroupedSeriesDataSchema,
  },
  { additionalProperties: false }
);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String({ minLength: 1 }),
    message: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export type GroupedSeriesData = Static<typeof GroupedSeriesDataSchema>;
