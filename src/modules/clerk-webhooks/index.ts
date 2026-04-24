export type { ClerkWebhookEvent } from './core/types.js';
export { ClerkWebhookEventSchema, ClerkWebhookEventDataSchema } from './core/types.js';

export type {
  InvalidClerkWebhookPayloadError,
  ClerkWebhookVerificationError,
} from './core/errors.js';

export type {
  SvixHeaders,
  ClerkWebhookVerifier,
  ClerkWebhookEventVerifiedInput,
  ClerkWebhookEventVerifiedHandler,
} from './core/ports.js';

export { parseClerkWebhookEvent } from './core/usecases/parse-clerk-webhook-event.js';

export {
  makeClerkWebhookVerifier,
  type ClerkWebhookVerifierConfig,
} from './shell/svix/verifier.js';

export { makeClerkWebhookRoutes, type ClerkWebhookRoutesDeps } from './shell/rest/routes.js';

export {
  makeClerkUserDeletedAnonymizationHandler,
  type ClerkUserDeletedAnonymizationHandlerDeps,
} from './shell/handlers/user-deleted-anonymization-handler.js';
