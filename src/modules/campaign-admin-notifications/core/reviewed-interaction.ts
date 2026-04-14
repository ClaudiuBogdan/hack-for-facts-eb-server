export {
  ADMIN_REVIEWED_INTERACTION_FAMILY_ID,
  parseAdminReviewedInteractionOutboxMetadata,
  type AdminReviewedInteractionNextStepLink as ReviewedInteractionNextStepLink,
  type AdminReviewedInteractionOutboxMetadata,
} from '@/modules/notification-delivery/index.js';

export const ADMIN_REVIEWED_USER_INTERACTION_TRIGGER_ID =
  'admin_reviewed_user_interaction' as const;
export const ADMIN_REVIEWED_USER_INTERACTION_TEMPLATE_ID =
  'admin_reviewed_user_interaction' as const;
export const REVIEWED_INTERACTION_BULK_DEFAULT_LIMIT = 100;
export const REVIEWED_INTERACTION_BULK_MAX_LIMIT = 500;
