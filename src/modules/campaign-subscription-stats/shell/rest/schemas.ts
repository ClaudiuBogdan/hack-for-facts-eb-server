import { Type, type Static } from '@sinclair/typebox';

export const CampaignSubscriptionStatsParamsSchema = Type.Object(
  {
    campaignId: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z0-9-]+$',
      description: 'Supported public campaign identifier.',
    }),
  },
  { additionalProperties: false }
);

export type CampaignSubscriptionStatsParams = Static<typeof CampaignSubscriptionStatsParamsSchema>;

export const CampaignSubscriptionStatsItemSchema = Type.Object({
  siruta_code: Type.String({ minLength: 1 }),
  uat_name: Type.String({ minLength: 1 }),
  count: Type.Integer({ minimum: 0 }),
});

export const CampaignSubscriptionStatsResponseSchema = Type.Object({
  total: Type.Integer({ minimum: 0 }),
  per_uat: Type.Array(CampaignSubscriptionStatsItemSchema),
});

export const ErrorResponseSchema = Type.Object({
  ok: Type.Literal(false),
  error: Type.String(),
  message: Type.String(),
});
