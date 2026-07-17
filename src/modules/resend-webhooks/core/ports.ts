import type { ResendWebhookError } from './errors.js';
import type { ResendEmailWebhookEvent, StoredResendEmailEvent } from './types.js';
import type { Result } from 'neverthrow';

export interface SvixHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

export interface WebhookVerificationError {
  message: string;
}

export interface WebhookVerifier {
  verify(rawBody: string, headers: SvixHeaders): Promise<Result<unknown, WebhookVerificationError>>;
}

export interface InsertResendWebhookEmailEventInput {
  svixId: string;
  event: ResendEmailWebhookEvent;
}

export interface ResendWebhookEmailEventsRepository {
  insert(
    input: InsertResendWebhookEmailEventInput
  ): Promise<Result<StoredResendEmailEvent, ResendWebhookError>>;
  findBySvixId(svixId: string): Promise<Result<StoredResendEmailEvent | null, ResendWebhookError>>;
  findThreadKeyByMessageReferences(
    messageReferences: string[]
  ): Promise<Result<string | null, ResendWebhookError>>;
  updateStoredEvent(
    id: string,
    input: {
      threadKey?: string | null;
      messageId?: string | null;
      metadata?: Record<string, unknown>;
    }
  ): Promise<Result<StoredResendEmailEvent, ResendWebhookError>>;
}

export interface ResendWebhookSideEffectInput {
  event: ResendEmailWebhookEvent;
  storedEvent: StoredResendEmailEvent;
}

export interface ResendWebhookSideEffect {
  handle(input: ResendWebhookSideEffectInput): Promise<void>;
}
