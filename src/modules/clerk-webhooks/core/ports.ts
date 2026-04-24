import type { ClerkWebhookVerificationError } from './errors.js';
import type { ClerkWebhookEvent } from './types.js';
import type { Result } from 'neverthrow';

export interface SvixHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

export interface ClerkWebhookVerifier {
  verify(
    rawBody: string,
    headers: SvixHeaders
  ): Promise<Result<unknown, ClerkWebhookVerificationError>>;
}

export interface ClerkWebhookEventVerifiedInput {
  event: ClerkWebhookEvent;
  svixId: string;
}

export type ClerkWebhookEventVerifiedHandler = (
  input: ClerkWebhookEventVerifiedInput
) => Promise<void>;
