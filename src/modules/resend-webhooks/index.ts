export type {
  ResendEmailEventType,
  WebhookTag,
  ResendWebhookTags,
  BounceData,
  ClickData,
  ResendEmailWebhookEventData,
  ResendEmailWebhookEvent,
  StoredResendEmailEvent,
} from './core/types.js';

export type {
  InsertResendWebhookEmailEventInput,
  ResendWebhookEmailEventsRepository,
  ResendWebhookSideEffect,
  ResendWebhookSideEffectInput,
  SvixHeaders,
  WebhookVerifier,
} from './core/ports.js';

export type {
  ResendWebhookError,
  DatabaseError,
  DuplicateResendWebhookEventError,
} from './core/errors.js';

export {
  parseTags,
  extractTagValue,
  extractThreadKey,
  mapResendEmailWebhookEventToInsert,
} from './core/mappers.js';
export { combineResendWebhookSideEffects } from './shell/combine-side-effects.js';

export {
  makeResendWebhookEmailEventsRepo,
  type ResendWebhookEmailEventsRepoConfig,
} from './shell/repo/resend-webhook-email-events-repo.js';

export { makeResendWebhookRoutes, type ResendWebhookRoutesDeps } from './shell/rest/routes.js';
