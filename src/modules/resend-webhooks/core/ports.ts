import type { ResendWebhookError } from './errors.js';
import type { ResendEmailWebhookEvent, StoredResendEmailEvent } from './types.js';
import type { SvixHeaders, WebhookVerifier } from '@/infra/email/client.js';
import type { Result } from 'neverthrow';

export type { SvixHeaders, WebhookVerifier };

export interface InsertResendWebhookEmailEventInput {
  svixId: string;
  event: ResendEmailWebhookEvent;
}

export interface ResendWebhookEmailEventsRepository {
  insert(
    input: InsertResendWebhookEmailEventInput
  ): Promise<Result<StoredResendEmailEvent, ResendWebhookError>>;
  findBySvixId(svixId: string): Promise<Result<StoredResendEmailEvent | null, ResendWebhookError>>;
}

export interface ResendWebhookSideEffectInput {
  event: ResendEmailWebhookEvent;
  storedEvent: StoredResendEmailEvent;
}

export interface ResendWebhookSideEffect {
  handle(input: ResendWebhookSideEffectInput): Promise<void>;
}
