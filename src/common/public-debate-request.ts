import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const DEBATE_REQUEST_INTERACTION_ID = 'campaign:debate-request' as const;

export const DebateRequestPayloadSchema = Type.Object(
  {
    primariaEmail: Type.String({ minLength: 1 }),
    isNgo: Type.Boolean(),
    organizationName: Type.Union([Type.String(), Type.Null()]),
    threadKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ngoSenderEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    preparedSubject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    submissionPath: Type.Union([
      Type.Literal('send_yourself'),
      Type.Literal('request_platform'),
      Type.Null(),
    ]),
    submittedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false }
);

export type DebateRequestPayload = Static<typeof DebateRequestPayloadSchema>;

export const parseDebateRequestPayloadValue = (candidate: unknown): DebateRequestPayload | null => {
  return Value.Check(DebateRequestPayloadSchema, candidate) ? candidate : null;
};
