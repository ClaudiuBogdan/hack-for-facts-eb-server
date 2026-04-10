import { Type, type Static } from '@sinclair/typebox';

import { PaginationSchema } from '@/common/schemas/base.js';

import { AdvancedMapDatasetJsonItemSchema } from '../../core/types.js';

export const DatasetVisibilitySchema = Type.Union([
  Type.Literal('private'),
  Type.Literal('unlisted'),
  Type.Literal('public'),
]);

export const DatasetIdParamsSchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export const DatasetPublicIdParamsSchema = Type.Object(
  {
    publicId: Type.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export const DatasetListQuerySchema = PaginationSchema;

export const UpdateDatasetBodySchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 255 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    markdown: Type.Optional(Type.Union([Type.String({ maxLength: 10000 }), Type.Null()])),
    unit: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    visibility: Type.Optional(DatasetVisibilitySchema),
  },
  { additionalProperties: false }
);

export const DatasetRowSchema = Type.Object(
  {
    sirutaCode: Type.String({ minLength: 1 }),
    valueNumber: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    valueJson: Type.Union([AdvancedMapDatasetJsonItemSchema, Type.Null()]),
  },
  { additionalProperties: false }
);

export const CreateDatasetJsonBodySchema = Type.Object(
  {
    title: Type.String({ maxLength: 255 }),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    markdown: Type.Optional(Type.Union([Type.String({ maxLength: 10000 }), Type.Null()])),
    unit: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
    visibility: Type.Optional(DatasetVisibilitySchema),
    rows: Type.Array(DatasetRowSchema),
  },
  { additionalProperties: false }
);

export const ReplaceDatasetRowsBodySchema = Type.Object(
  {
    rows: Type.Array(DatasetRowSchema),
  },
  { additionalProperties: false }
);

export const DatasetSummarySchema = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    publicId: Type.String({ format: 'uuid' }),
    userId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1 }),
    description: Type.Union([Type.String(), Type.Null()]),
    markdown: Type.Union([Type.String(), Type.Null()]),
    unit: Type.Union([Type.String(), Type.Null()]),
    visibility: DatasetVisibilitySchema,
    rowCount: Type.Number({ minimum: 0 }),
    replacedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const PublicDatasetSummarySchema = Type.Object(
  {
    publicId: Type.String({ format: 'uuid' }),
    title: Type.String({ minLength: 1 }),
    description: Type.Union([Type.String(), Type.Null()]),
    markdown: Type.Union([Type.String(), Type.Null()]),
    unit: Type.Union([Type.String(), Type.Null()]),
    visibility: DatasetVisibilitySchema,
    rowCount: Type.Number({ minimum: 0 }),
    replacedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const DatasetDetailSchema = Type.Object(
  {
    ...DatasetSummarySchema.properties,
    rows: Type.Array(DatasetRowSchema),
  },
  { additionalProperties: false }
);

export const PublicDatasetDetailSchema = Type.Object(
  {
    ...PublicDatasetSummarySchema.properties,
    rows: Type.Array(DatasetRowSchema),
  },
  { additionalProperties: false }
);

export const DatasetPageInfoSchema = Type.Object(
  {
    totalCount: Type.Number({ minimum: 0 }),
    hasNextPage: Type.Boolean(),
    hasPreviousPage: Type.Boolean(),
  },
  { additionalProperties: false }
);

export const DatasetConnectionSchema = Type.Object(
  {
    nodes: Type.Array(DatasetSummarySchema),
    pageInfo: DatasetPageInfoSchema,
  },
  { additionalProperties: false }
);

export const DatasetResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: DatasetDetailSchema,
  },
  { additionalProperties: false }
);

export const PublicDatasetResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: PublicDatasetDetailSchema,
  },
  { additionalProperties: false }
);

export const DatasetListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: DatasetConnectionSchema,
  },
  { additionalProperties: false }
);

export const PublicDatasetConnectionSchema = Type.Object(
  {
    nodes: Type.Array(PublicDatasetSummarySchema),
    pageInfo: DatasetPageInfoSchema,
  },
  { additionalProperties: false }
);

export const PublicDatasetListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: PublicDatasetConnectionSchema,
  },
  { additionalProperties: false }
);

export const DatasetDeleteResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
  },
  { additionalProperties: false }
);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    details: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false }
);

export type DatasetIdParams = Static<typeof DatasetIdParamsSchema>;
export type DatasetPublicIdParams = Static<typeof DatasetPublicIdParamsSchema>;
export type DatasetListQuery = Static<typeof DatasetListQuerySchema>;
export type UpdateDatasetBody = Static<typeof UpdateDatasetBodySchema>;
export type CreateDatasetJsonBody = Static<typeof CreateDatasetJsonBodySchema>;
export type ReplaceDatasetRowsBody = Static<typeof ReplaceDatasetRowsBodySchema>;
