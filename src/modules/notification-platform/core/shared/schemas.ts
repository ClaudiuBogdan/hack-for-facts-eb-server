import { Type, type Static } from '@sinclair/typebox';

export const ChannelSchema = Type.Union([Type.Literal('inbox'), Type.Literal('email')]);
export type Channel = Static<typeof ChannelSchema>;

export const ExternalChannelSchema = Type.Literal('email');
export type ExternalChannel = Static<typeof ExternalChannelSchema>;

export const CadenceSchema = Type.Union([
  Type.Literal('immediate'),
  Type.Literal('daily'),
  Type.Literal('weekly'),
  Type.Literal('off'),
]);
export type Cadence = Static<typeof CadenceSchema>;

export const DigestCadenceSchema = Type.Union([Type.Literal('daily'), Type.Literal('weekly')]);
export type DigestCadence = Static<typeof DigestCadenceSchema>;

export const LocaleSchema = Type.Literal('ro');
export type Locale = Static<typeof LocaleSchema>;

export const PreferenceClassSchema = Type.Union([
  Type.Literal('subscription-required'),
  Type.Literal('opt-out'),
  Type.Literal('required'),
]);
export type PreferenceClass = Static<typeof PreferenceClassSchema>;

export const SenderModeSchema = Type.Union([
  Type.Literal('legacy'),
  Type.Literal('shadow'),
  Type.Literal('active'),
]);
export type SenderMode = Static<typeof SenderModeSchema>;

export const NonEmptyStringSchema = Type.String({ minLength: 1 });
export type NonEmptyString = Static<typeof NonEmptyStringSchema>;

export const DateTimeSchema = Type.String({ format: 'date-time' });
export type DateTime = Static<typeof DateTimeSchema>;

export const UnknownRecordSchema = Type.Record(Type.String(), Type.Unknown());
export type UnknownRecord = Static<typeof UnknownRecordSchema>;

export const CursorQuerySchema = Type.Object(
  {
    cursor: Type.Optional(NonEmptyStringSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  },
  { additionalProperties: false }
);
export type CursorQuery = Static<typeof CursorQuerySchema>;

export const OkResponseSchema = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false }
);
export type OkResponse = Static<typeof OkResponseSchema>;
