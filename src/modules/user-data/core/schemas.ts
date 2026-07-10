import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { createInvalidPayload, type UserDataError } from './errors.js';

export const DecimalSequenceSchema = Type.String({ pattern: '^(0|[1-9][0-9]*)$' });
export const RecordIdentitySchema = Type.Object({
  ownerId: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
  logicalKey: Type.String({ minLength: 1 }),
});
export const RecordTargetSchema = Type.Object({
  targetType: Type.String({ minLength: 1 }),
  targetId: Type.String({ minLength: 1 }),
});
export const ActorContextSchema = Type.Union([
  Type.Object({ type: Type.Literal('owner') }),
  Type.Object({
    type: Type.Literal('system'),
    source: Type.String({ minLength: 1, maxLength: 256 }),
  }),
  Type.Object({
    type: Type.Literal('admin'),
    actorId: Type.String({ minLength: 1, maxLength: 256 }),
    reason: Type.String({ minLength: 1, maxLength: 1024 }),
  }),
]);
export type ValidatedActorContext = Static<typeof ActorContextSchema>;
export const createActorContext = (value: unknown): Result<ValidatedActorContext, UserDataError> =>
  Value.Check(ActorContextSchema, value)
    ? ok(value)
    : err(createInvalidPayload(['/actor:invalid']));
