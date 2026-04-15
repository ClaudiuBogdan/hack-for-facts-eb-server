import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  WeeklyProgressDigestCtaSchema,
  WeeklyProgressDigestItemSchema,
  WeeklyProgressDigestSummarySchema,
} from '@/modules/email-templates/index.js';

export const WEEKLY_PROGRESS_DIGEST_TEMPLATE_ID = 'weekly_progress_digest' as const;
export const WEEKLY_PROGRESS_DIGEST_FAMILY_ID = 'weekly_progress_digest' as const;
export const FUNKY_WEEKLY_PROGRESS_DIGEST_OUTBOX_TYPE =
  'funky:outbox:weekly_progress_digest' as const;
export const WEEKLY_PROGRESS_DIGEST_SCOPE_PREFIX = 'digest:weekly_progress:funky:' as const;

export const WeeklyProgressDigestSnapshotSchema = Type.Object(
  {
    weekKey: Type.String({ minLength: 1 }),
    periodLabel: Type.String({ minLength: 1 }),
    watermarkAt: Type.String({ minLength: 1 }),
    summary: WeeklyProgressDigestSummarySchema,
    items: Type.Array(WeeklyProgressDigestItemSchema),
    primaryCta: WeeklyProgressDigestCtaSchema,
    secondaryCtas: Type.Array(WeeklyProgressDigestCtaSchema, { maxItems: 2 }),
    allUpdatesUrl: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
  },
  { additionalProperties: false }
);

export type WeeklyProgressDigestSnapshot = Static<typeof WeeklyProgressDigestSnapshotSchema>;

export const WeeklyProgressDigestOutboxMetadataSchema = Type.Composite([
  WeeklyProgressDigestSnapshotSchema,
  Type.Object(
    {
      digestType: Type.Literal('weekly_progress_digest'),
      campaignKey: Type.Literal('funky'),
      userId: Type.String({ minLength: 1 }),
      triggerSource: Type.Optional(Type.String({ minLength: 1 })),
      triggeredByUserId: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false }
  ),
]);

export type WeeklyProgressDigestOutboxMetadata = Static<
  typeof WeeklyProgressDigestOutboxMetadataSchema
>;

const getValidationMessage = (value: unknown): string => {
  const [firstError] = [...Value.Errors(WeeklyProgressDigestOutboxMetadataSchema, value)];
  if (firstError !== undefined && typeof firstError.message === 'string') {
    return firstError.message;
  }

  return 'Invalid weekly progress digest metadata';
};

export const parseWeeklyProgressDigestOutboxMetadata = (
  value: unknown
): Result<WeeklyProgressDigestOutboxMetadata, string> => {
  if (!Value.Check(WeeklyProgressDigestOutboxMetadataSchema, value)) {
    return err(getValidationMessage(value));
  }

  return ok(value);
};

export const buildWeeklyProgressDigestScopeKey = (weekKey: string): string => {
  return `${WEEKLY_PROGRESS_DIGEST_SCOPE_PREFIX}${weekKey}`;
};

export const buildWeeklyProgressDigestDeliveryKey = (input: {
  userId: string;
  weekKey: string;
}): string => {
  return `${WEEKLY_PROGRESS_DIGEST_SCOPE_PREFIX}${input.userId}:${input.weekKey}`;
};
