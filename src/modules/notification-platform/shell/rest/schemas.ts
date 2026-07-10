import { Type, type Static } from '@sinclair/typebox';

export {
  InboxListQuerySchema,
  InboxIdParamsSchema,
  InboxListResponseSchema,
  UnreadCountResponseSchema,
  MarkAllReadResponseSchema,
} from '../../core/inbox/schemas.js';
export type {
  InboxListQuery,
  InboxIdParams,
  InboxListResponse,
  UnreadCountResponse,
  MarkAllReadResponse,
} from '../../core/inbox/schemas.js';

export {
  CreateSubscriptionBodySchema,
  SubscriptionIdParamsSchema,
  SubscriptionListQuerySchema,
  SubscriptionResponseSchema,
  SubscriptionListResponseSchema,
} from '../../core/subscriptions/schemas.js';
export type {
  CreateSubscriptionBody,
  SubscriptionIdParams,
  SubscriptionListQuery,
  SubscriptionResponse,
  SubscriptionListResponse,
} from '../../core/subscriptions/schemas.js';

export {
  ChannelPreferenceParamsSchema,
  UpdateChannelPreferenceBodySchema,
  UpdateGlobalPreferenceBodySchema,
  PreferencesResponseSchema,
} from '../../core/preferences/schemas.js';
export type {
  ChannelPreferenceParams,
  UpdateChannelPreferenceBody,
  UpdateGlobalPreferenceBody,
  PreferencesResponse,
} from '../../core/preferences/schemas.js';

export {
  AdminEventIdParamsSchema,
  EventTraceResponseSchema,
  DeadLetterSearchQuerySchema,
  DeadLetterSearchResponseSchema,
  AdminDeliveryIdParamsSchema,
  RequeueDeadLetterBodySchema,
  RequeueDeadLetterResponseSchema,
  RevealDeliveryContentBodySchema,
  RevealDeliveryContentResponseSchema,
  SuppressionListQuerySchema,
  SuppressionListResponseSchema,
  ShadowComparisonParamsSchema,
  ShadowComparisonQuerySchema,
  ShadowComparisonResponseSchema,
  AdminDigestBatchIdParamsSchema,
  CancelDigestBatchBodySchema,
  CancelDigestBatchResponseSchema,
} from '../../core/admin/schemas.js';
export type {
  AdminEventIdParams,
  EventTraceResponse,
  DeadLetterSearchQuery,
  DeadLetterSearchResponse,
  AdminDeliveryIdParams,
  RequeueDeadLetterBody,
  RequeueDeadLetterResponse,
  RevealDeliveryContentBody,
  RevealDeliveryContentResponse,
  SuppressionListQuery,
  SuppressionListResponse,
  ShadowComparisonParams,
  ShadowComparisonQuery,
  ShadowComparisonResponse,
  AdminDigestBatchIdParams,
  CancelDigestBatchBody,
  CancelDigestBatchResponse,
} from '../../core/admin/schemas.js';

export { OkResponseSchema } from '../../core/shared/schemas.js';
export type { OkResponse } from '../../core/shared/schemas.js';

export const ErrorResponseSchema = Type.Object(
  {
    ok: Type.Optional(Type.Literal(false)),
    error: Type.String({ minLength: 1 }),
    message: Type.String({ minLength: 1 }),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false }
);

export type ErrorResponse = Static<typeof ErrorResponseSchema>;
