import { Type } from '@sinclair/typebox';

const ShortStringSchema = Type.String({ maxLength: 256 });
const TextSchema = Type.String({ maxLength: 16_384 });
const TimestampSchema = Type.String({ minLength: 1, maxLength: 64 });

const JsonPrimitiveSchema = Type.Union([Type.Null(), Type.Boolean(), Type.Number(), TextSchema]);
const JsonLevelOneSchema = Type.Union([
  JsonPrimitiveSchema,
  Type.Array(JsonPrimitiveSchema, { maxItems: 256 }),
  Type.Record(ShortStringSchema, JsonPrimitiveSchema, { maxProperties: 256 }),
]);
const JsonLevelTwoSchema = Type.Union([
  JsonLevelOneSchema,
  Type.Array(JsonLevelOneSchema, { maxItems: 256 }),
  Type.Record(ShortStringSchema, JsonLevelOneSchema, { maxProperties: 256 }),
]);
const JsonObjectSchema = Type.Record(ShortStringSchema, JsonLevelTwoSchema, {
  maxProperties: 256,
});

const InteractionScopeSchema = Type.Union([
  Type.Object({ type: Type.Literal('global') }),
  Type.Object({
    type: Type.Literal('entity'),
    entityCui: Type.String({ minLength: 1, maxLength: 64 }),
  }),
]);

const InteractionValueSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('choice'),
    choice: Type.Object({ selectedId: Type.Union([ShortStringSchema, Type.Null()]) }),
  }),
  Type.Object({ kind: Type.Literal('text'), text: Type.Object({ value: TextSchema }) }),
  Type.Object({
    kind: Type.Literal('url'),
    url: Type.Object({ value: Type.String({ maxLength: 2048 }) }),
  }),
  Type.Object({
    kind: Type.Literal('number'),
    number: Type.Object({ value: Type.Union([Type.Number(), Type.Null()]) }),
  }),
  Type.Object({ kind: Type.Literal('json'), json: Type.Object({ value: JsonObjectSchema }) }),
]);

const InteractionResultSchema = Type.Object({
  outcome: Type.Union([Type.Literal('correct'), Type.Literal('incorrect'), Type.Null()]),
  score: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  feedbackText: Type.Optional(Type.Union([TextSchema, Type.Null()])),
  response: Type.Optional(Type.Union([JsonObjectSchema, Type.Null()])),
  evaluatedAt: Type.Optional(Type.Union([TimestampSchema, Type.Null()])),
});

const CompletionRuleSchema = Type.Union([
  Type.Object({
    type: Type.Literal('outcome'),
    outcome: Type.Union([Type.Literal('correct'), Type.Literal('incorrect')]),
  }),
  Type.Object({ type: Type.Literal('resolved') }),
  Type.Object({ type: Type.Literal('score-threshold'), minScore: Type.Number() }),
  Type.Object({ type: Type.Literal('component-flag'), flag: ShortStringSchema }),
]);

export const InteractiveStatePayloadSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 512 }),
    interactionId: Type.String({ minLength: 1, maxLength: 512 }),
    lessonId: Type.String({ minLength: 1, maxLength: 256 }),
    kind: Type.Union([
      Type.Literal('quiz'),
      Type.Literal('url'),
      Type.Literal('text-input'),
      Type.Literal('custom'),
    ]),
    scope: InteractionScopeSchema,
    completionRule: CompletionRuleSchema,
    phase: Type.Union([
      Type.Literal('idle'),
      Type.Literal('draft'),
      Type.Literal('pending'),
      Type.Literal('resolved'),
      Type.Literal('failed'),
    ]),
    value: Type.Union([InteractionValueSchema, Type.Null()]),
    result: Type.Union([InteractionResultSchema, Type.Null()]),
    sourceUrl: Type.Optional(Type.String({ maxLength: 2048 })),
    updatedAt: TimestampSchema,
    submittedAt: Type.Optional(Type.Union([TimestampSchema, Type.Null()])),
  },
  { additionalProperties: false }
);
