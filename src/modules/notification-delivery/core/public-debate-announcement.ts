import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

export const PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID = 'public_debate_announcement' as const;
export const PUBLIC_DEBATE_ANNOUNCEMENT_TEMPLATE_ID = 'public_debate_announcement' as const;

export const PublicDebateAnnouncementPayloadSchema = Type.Object(
  {
    date: Type.String({ minLength: 1 }),
    time: Type.String({ minLength: 1 }),
    location: Type.String({ minLength: 1 }),
    announcement_link: Type.String({ minLength: 1 }),
    online_participation_link: Type.Optional(Type.String({ minLength: 1 })),
    description: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false }
);

export type PublicDebateAnnouncementPayload = Static<typeof PublicDebateAnnouncementPayloadSchema>;

export const PublicDebateAnnouncementOutboxMetadataSchema = Type.Object({
  campaignKey: Type.Literal('funky'),
  familyId: Type.Literal(PUBLIC_DEBATE_ANNOUNCEMENT_FAMILY_ID),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  publicDebate: PublicDebateAnnouncementPayloadSchema,
  announcementFingerprint: Type.String({ minLength: 1 }),
  configUpdatedAt: Type.String({ minLength: 1 }),
  triggerSource: Type.Optional(Type.String({ minLength: 1 })),
  triggeredByUserId: Type.Optional(Type.String({ minLength: 1 })),
});

export type PublicDebateAnnouncementOutboxMetadata = Static<
  typeof PublicDebateAnnouncementOutboxMetadataSchema
>;

const getValidationMessage = (value: unknown): string => {
  const [firstError] = [...Value.Errors(PublicDebateAnnouncementOutboxMetadataSchema, value)];
  if (firstError !== undefined && typeof firstError.message === 'string') {
    return firstError.message;
  }

  return 'Invalid public-debate-announcement metadata';
};

export const parsePublicDebateAnnouncementOutboxMetadata = (
  value: unknown
): Result<PublicDebateAnnouncementOutboxMetadata, string> => {
  if (!Value.Check(PublicDebateAnnouncementOutboxMetadataSchema, value)) {
    return err(getValidationMessage(value));
  }

  return ok(value);
};
