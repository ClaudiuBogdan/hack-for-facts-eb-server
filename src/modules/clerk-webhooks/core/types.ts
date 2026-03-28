import { Type, type Static } from '@sinclair/typebox';

export const ClerkWebhookEventDataSchema = Type.Record(Type.String(), Type.Unknown());

export const ClerkWebhookEventSchema = Type.Object(
  {
    data: ClerkWebhookEventDataSchema,
    object: Type.Literal('event'),
    type: Type.String({ minLength: 1 }),
    timestamp: Type.Number(),
    instance_id: Type.String({ minLength: 1 }),
  },
  { additionalProperties: true }
);

export type ClerkWebhookEvent = Static<typeof ClerkWebhookEventSchema>;
