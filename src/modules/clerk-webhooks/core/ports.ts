import type { ClerkWebhookVerificationError } from './errors.js';
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
