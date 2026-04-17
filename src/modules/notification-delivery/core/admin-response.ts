import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

export const PUBLIC_DEBATE_ADMIN_RESPONSE_FAMILY_ID = 'public_debate_admin_response' as const;
export const PUBLIC_DEBATE_ADMIN_RESPONSE_EVENT_TYPE = 'admin_response_added' as const;

export const PublicDebateAdminResponseRecipientRoleSchema = Type.Union([
  Type.Literal('requester'),
  Type.Literal('subscriber'),
]);

export type PublicDebateAdminResponseRecipientRole = Static<
  typeof PublicDebateAdminResponseRecipientRoleSchema
>;

export const PublicDebateAdminResponseStatusSchema = Type.Union([
  Type.Literal('registration_number_received'),
  Type.Literal('request_confirmed'),
  Type.Literal('request_denied'),
]);

export type PublicDebateAdminResponseStatus = Static<typeof PublicDebateAdminResponseStatusSchema>;

export const PublicDebateAdminResponseOutboxMetadataSchema = Type.Object({
  campaignKey: Type.Literal('funky'),
  familyId: Type.Literal(PUBLIC_DEBATE_ADMIN_RESPONSE_FAMILY_ID),
  eventType: Type.Literal(PUBLIC_DEBATE_ADMIN_RESPONSE_EVENT_TYPE),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  threadId: Type.String({ minLength: 1 }),
  threadKey: Type.String({ minLength: 1 }),
  responseEventId: Type.String({ minLength: 1 }),
  responseStatus: PublicDebateAdminResponseStatusSchema,
  responseDate: Type.String({ minLength: 1 }),
  messageContent: Type.String({ minLength: 1 }),
  recipientRole: PublicDebateAdminResponseRecipientRoleSchema,
  triggerSource: Type.Optional(Type.String({ minLength: 1 })),
  triggeredByUserId: Type.Optional(Type.String({ minLength: 1 })),
});

export type PublicDebateAdminResponseOutboxMetadata = Static<
  typeof PublicDebateAdminResponseOutboxMetadataSchema
>;

export interface PublicDebateEntityAudienceSummary {
  readonly requesterCount: number;
  readonly subscriberCount: number;
  readonly eligibleRequesterCount: number;
  readonly eligibleSubscriberCount: number;
}

const normalizeRequesterUserId = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export const buildPublicDebateEntityAudienceSummaryKey = (input: {
  entityCui: string;
  requesterUserId: string | null;
}): string => {
  return `${input.entityCui}::${normalizeRequesterUserId(input.requesterUserId) ?? ''}`;
};

const getValidationMessage = (value: unknown): string => {
  const [firstError] = [...Value.Errors(PublicDebateAdminResponseOutboxMetadataSchema, value)];
  if (firstError !== undefined && typeof firstError.message === 'string') {
    return firstError.message;
  }

  return 'Invalid admin-response metadata';
};

export const parsePublicDebateAdminResponseOutboxMetadata = (
  value: unknown
): Result<PublicDebateAdminResponseOutboxMetadata, string> => {
  if (!Value.Check(PublicDebateAdminResponseOutboxMetadataSchema, value)) {
    return err(getValidationMessage(value));
  }

  return ok(value);
};
