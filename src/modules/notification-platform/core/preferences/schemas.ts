import { Type, type Static } from '@sinclair/typebox';

import { CadenceSchema, ChannelSchema, NonEmptyStringSchema } from '../shared/schemas.js';

export const ChannelPreferenceSchema = Type.Object(
  { enabled: Type.Boolean(), cadence: CadenceSchema },
  { additionalProperties: false }
);
export type ChannelPreference = Static<typeof ChannelPreferenceSchema>;

export const UserNotificationPreferencesSchema = Type.Object(
  {
    userId: NonEmptyStringSchema,
    globalOptionalEnabled: Type.Boolean(),
    channels: Type.Object(
      { inbox: ChannelPreferenceSchema, email: ChannelPreferenceSchema },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);
export type UserNotificationPreferences = Static<typeof UserNotificationPreferencesSchema>;

export const UpdateGlobalPreferenceBodySchema = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false }
);
export type UpdateGlobalPreferenceBody = Static<typeof UpdateGlobalPreferenceBodySchema>;

export const ChannelPreferenceParamsSchema = Type.Object(
  { channel: ChannelSchema },
  { additionalProperties: false }
);
export type ChannelPreferenceParams = Static<typeof ChannelPreferenceParamsSchema>;

export const UpdateChannelPreferenceBodySchema = Type.Object(
  { enabled: Type.Boolean(), cadence: CadenceSchema },
  { additionalProperties: false }
);
export type UpdateChannelPreferenceBody = Static<typeof UpdateChannelPreferenceBodySchema>;

export const PreferencesResponseSchema = Type.Object(
  { ok: Type.Literal(true), data: UserNotificationPreferencesSchema },
  { additionalProperties: false }
);
export type PreferencesResponse = Static<typeof PreferencesResponseSchema>;
