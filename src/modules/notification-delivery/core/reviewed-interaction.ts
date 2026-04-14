import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

export const ADMIN_REVIEWED_INTERACTION_FAMILY_ID = 'admin_reviewed_interaction' as const;

export const AdminReviewedInteractionNextStepLinkSchema = Type.Object({
  kind: Type.Union([
    Type.Literal('retry_interaction'),
    Type.Literal('start_public_debate_request'),
    Type.Literal('view_entity'),
  ]),
  label: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String({ minLength: 1 })),
});

export type AdminReviewedInteractionNextStepLink = Static<
  typeof AdminReviewedInteractionNextStepLinkSchema
>;

const AdminReviewedInteractionBaseMetadataSchema = Type.Object({
  campaignKey: Type.Literal('funky'),
  familyId: Type.Literal(ADMIN_REVIEWED_INTERACTION_FAMILY_ID),
  recordKey: Type.String({ minLength: 1 }),
  interactionId: Type.String({ minLength: 1 }),
  interactionLabel: Type.String({ minLength: 1 }),
  reviewedAt: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
  entityCui: Type.String({ minLength: 1 }),
  entityName: Type.String({ minLength: 1 }),
  nextStepLinks: Type.Optional(
    Type.Array(AdminReviewedInteractionNextStepLinkSchema, { minItems: 1 })
  ),
  triggerSource: Type.Optional(Type.String({ minLength: 1 })),
  triggeredByUserId: Type.Optional(Type.String({ minLength: 1 })),
});

const AdminReviewedInteractionApprovedMetadataSchema = Type.Composite([
  AdminReviewedInteractionBaseMetadataSchema,
  Type.Object({
    reviewStatus: Type.Literal('approved'),
    feedbackText: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);

const AdminReviewedInteractionRejectedMetadataSchema = Type.Composite([
  AdminReviewedInteractionBaseMetadataSchema,
  Type.Object({
    reviewStatus: Type.Literal('rejected'),
    feedbackText: Type.String({ minLength: 1 }),
  }),
]);

export const AdminReviewedInteractionOutboxMetadataSchema = Type.Union([
  AdminReviewedInteractionApprovedMetadataSchema,
  AdminReviewedInteractionRejectedMetadataSchema,
]);

export type AdminReviewedInteractionOutboxMetadata = Static<
  typeof AdminReviewedInteractionOutboxMetadataSchema
>;

const getValidationMessage = (value: unknown): string => {
  const [firstError] = [...Value.Errors(AdminReviewedInteractionOutboxMetadataSchema, value)];
  if (firstError !== undefined && typeof firstError.message === 'string') {
    return firstError.message;
  }

  return 'Invalid reviewed-interaction metadata';
};

export const parseAdminReviewedInteractionOutboxMetadata = (
  value: unknown
): Result<AdminReviewedInteractionOutboxMetadata, string> => {
  if (!Value.Check(AdminReviewedInteractionOutboxMetadataSchema, value)) {
    return err(getValidationMessage(value));
  }

  return ok(value);
};
