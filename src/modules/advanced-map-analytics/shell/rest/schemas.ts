/**
 * Advanced Map Analytics REST Schemas
 */

import { Type, type Static } from '@sinclair/typebox';

import { GroupedSeriesDataSchema } from '../../grouped-series/shell/rest/schemas.js';

export const VisibilitySchema = Type.Union([Type.Literal('private'), Type.Literal('public')]);

export const MapIdParamsSchema = Type.Object(
  {
    mapId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const SnapshotParamsSchema = Type.Object(
  {
    mapId: Type.String({ minLength: 1 }),
    snapshotId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const PublicMapParamsSchema = Type.Object(
  {
    publicId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export const CreateMapBodySchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    visibility: Type.Optional(VisibilitySchema),
  },
  { additionalProperties: false }
);

export const UpdateMapBodySchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    visibility: Type.Optional(VisibilitySchema),
  },
  { additionalProperties: false }
);

export const MapPatchSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    visibility: Type.Optional(VisibilitySchema),
  },
  { additionalProperties: false }
);

export const SaveSnapshotBodySchema = Type.Object(
  {
    state: Type.Record(Type.String(), Type.Unknown()),
    title: Type.Optional(Type.String({ maxLength: 200 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    mapPatch: Type.Optional(MapPatchSchema),
  },
  { additionalProperties: false }
);

export const SnapshotDocumentSchema = Type.Object(
  {
    title: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    state: Type.Record(Type.String(), Type.Unknown()),
    savedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const MapSummarySchema = Type.Object(
  {
    mapId: Type.String(),
    title: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    visibility: VisibilitySchema,
    publicId: Type.Union([Type.String(), Type.Null()]),
    snapshotCount: Type.Number({ minimum: 0 }),
    viewCount: Type.Number({ minimum: 0 }),
    lastSnapshotId: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: 'date-time' }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const MapDetailSchema = Type.Object(
  {
    ...MapSummarySchema.properties,
    lastSnapshot: Type.Union([SnapshotDocumentSchema, Type.Null()]),
    groupedSeriesData: Type.Optional(GroupedSeriesDataSchema),
  },
  { additionalProperties: false }
);

export const SnapshotSummarySchema = Type.Object(
  {
    snapshotId: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
    title: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);

export const SnapshotDetailSchema = Type.Object(
  {
    ...SnapshotSummarySchema.properties,
    mapId: Type.String(),
    snapshot: SnapshotDocumentSchema,
  },
  { additionalProperties: false }
);

export const PublicMapViewSchema = Type.Object(
  {
    mapId: Type.String(),
    publicId: Type.String(),
    title: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    snapshotId: Type.String(),
    snapshot: SnapshotDocumentSchema,
    groupedSeriesData: Type.Optional(GroupedSeriesDataSchema),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false }
);

export const MapResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: MapDetailSchema,
  },
  { additionalProperties: false }
);

export const DeleteMapResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
  },
  { additionalProperties: false }
);

export const MapListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Array(MapSummarySchema),
  },
  { additionalProperties: false }
);

export const SnapshotListResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Array(SnapshotSummarySchema),
  },
  { additionalProperties: false }
);

export const SnapshotResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: SnapshotDetailSchema,
  },
  { additionalProperties: false }
);

export const SaveSnapshotResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: Type.Object(
      {
        map: MapDetailSchema,
        snapshot: SnapshotDetailSchema,
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const PublicMapResponseSchema = Type.Object(
  {
    ok: Type.Literal(true),
    data: PublicMapViewSchema,
  },
  { additionalProperties: false }
);

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Literal(false),
    error: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false }
);

export type MapIdParams = Static<typeof MapIdParamsSchema>;
export type SnapshotParams = Static<typeof SnapshotParamsSchema>;
export type PublicMapParams = Static<typeof PublicMapParamsSchema>;
export type CreateMapBody = Static<typeof CreateMapBodySchema>;
export type UpdateMapBody = Static<typeof UpdateMapBodySchema>;
export type SaveSnapshotBody = Static<typeof SaveSnapshotBodySchema>;
