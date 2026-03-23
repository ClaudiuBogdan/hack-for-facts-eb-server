export interface DatabaseError {
  type: 'DatabaseError';
  message: string;
  retryable: boolean;
}

export interface DuplicateResendWebhookEventError {
  type: 'DuplicateResendWebhookEvent';
  svixId: string;
}

export type ResendWebhookError = DatabaseError | DuplicateResendWebhookEventError;

export const createDatabaseError = (message: string, retryable = true): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

export const createDuplicateResendWebhookEventError = (
  svixId: string
): DuplicateResendWebhookEventError => ({
  type: 'DuplicateResendWebhookEvent',
  svixId,
});
