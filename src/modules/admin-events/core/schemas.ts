import { Type } from '@sinclair/typebox';

export const AdminEventJobEnvelopeSchema = Type.Object(
  {
    eventType: Type.String({ minLength: 1 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false }
);

export const AdminEventExportBundleSchema = Type.Object(
  {
    jobId: Type.String({ minLength: 1 }),
    eventType: Type.String({ minLength: 1 }),
    schemaVersion: Type.Integer({ minimum: 1 }),
    payload: Type.Record(Type.String(), Type.Unknown()),
    context: Type.Unknown(),
    freshness: Type.Record(Type.String(), Type.Unknown()),
    instructions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    exportMetadata: Type.Object(
      {
        exportId: Type.String({ minLength: 1 }),
        exportedAt: Type.String({ minLength: 1 }),
        workspace: Type.String({ minLength: 1 }),
        environment: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false }
    ),
    outcomeSchema: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false }
);
