/**
 * Notification Delivery Module - Error Types
 *
 * Discriminated union error types for the delivery pipeline.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Database error.
 */
export interface DatabaseError {
  type: 'DatabaseError';
  message: string;
  retryable: boolean;
}

/**
 * Duplicate delivery key error.
 */
export interface DuplicateDeliveryError {
  type: 'DuplicateDelivery';
  deliveryKey: string;
}

/**
 * Delivery not found error.
 */
export interface DeliveryNotFoundError {
  type: 'DeliveryNotFound';
  deliveryId: string;
}

/**
 * Notification not found error.
 */
export interface NotificationNotFoundError {
  type: 'NotificationNotFound';
  notificationId: string;
}

/**
 * User email not found error.
 */
export interface UserEmailNotFoundError {
  type: 'UserEmailNotFound';
  userId: string;
}

/**
 * Delivery already claimed error.
 */
export interface DeliveryAlreadyClaimedError {
  type: 'DeliveryAlreadyClaimed';
  deliveryId: string;
}

/**
 * Render error.
 */
export interface RenderError {
  type: 'RenderError';
  message: string;
  templateType: string;
}

/**
 * Email send error.
 */
export interface EmailSendError {
  type: 'EmailSendError';
  message: string;
  retryable: boolean;
}

/**
 * Webhook verification error.
 */
export interface WebhookVerificationError {
  type: 'WebhookVerificationError';
  message: string;
}

/**
 * Duplicate webhook event error.
 */
export interface DuplicateWebhookEventError {
  type: 'DuplicateWebhookEvent';
  svixId: string;
}

/**
 * Union of all delivery errors.
 */
export type DeliveryError =
  | DatabaseError
  | DuplicateDeliveryError
  | DeliveryNotFoundError
  | NotificationNotFoundError
  | UserEmailNotFoundError
  | DeliveryAlreadyClaimedError
  | RenderError
  | EmailSendError
  | WebhookVerificationError
  | DuplicateWebhookEventError;

// ─────────────────────────────────────────────────────────────────────────────
// Error Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a database error.
 */
export const createDatabaseError = (message: string, retryable = true): DatabaseError => ({
  type: 'DatabaseError',
  message,
  retryable,
});

/**
 * Creates a duplicate delivery error.
 */
export const createDuplicateDeliveryError = (deliveryKey: string): DuplicateDeliveryError => ({
  type: 'DuplicateDelivery',
  deliveryKey,
});

/**
 * Creates a delivery not found error.
 */
export const createDeliveryNotFoundError = (deliveryId: string): DeliveryNotFoundError => ({
  type: 'DeliveryNotFound',
  deliveryId,
});

/**
 * Creates a notification not found error.
 */
export const createNotificationNotFoundError = (
  notificationId: string
): NotificationNotFoundError => ({
  type: 'NotificationNotFound',
  notificationId,
});

/**
 * Creates a user email not found error.
 */
export const createUserEmailNotFoundError = (userId: string): UserEmailNotFoundError => ({
  type: 'UserEmailNotFound',
  userId,
});

/**
 * Creates a delivery already claimed error.
 */
export const createDeliveryAlreadyClaimedError = (
  deliveryId: string
): DeliveryAlreadyClaimedError => ({
  type: 'DeliveryAlreadyClaimed',
  deliveryId,
});

/**
 * Creates a render error.
 */
export const createRenderError = (message: string, templateType: string): RenderError => ({
  type: 'RenderError',
  message,
  templateType,
});

/**
 * Creates an email send error.
 */
export const createEmailSendError = (message: string, retryable: boolean): EmailSendError => ({
  type: 'EmailSendError',
  message,
  retryable,
});

/**
 * Creates a webhook verification error.
 */
export const createWebhookVerificationError = (message: string): WebhookVerificationError => ({
  type: 'WebhookVerificationError',
  message,
});

/**
 * Creates a duplicate webhook event error.
 */
export const createDuplicateWebhookEventError = (svixId: string): DuplicateWebhookEventError => ({
  type: 'DuplicateWebhookEvent',
  svixId,
});

// ─────────────────────────────────────────────────────────────────────────────
// Error Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if an error is retryable.
 */
export const isRetryableError = (error: DeliveryError): boolean => {
  switch (error.type) {
    case 'DatabaseError':
    case 'EmailSendError':
      return error.retryable;
    default:
      return false;
  }
};

/**
 * Gets a human-readable message from a delivery error.
 */
export const getErrorMessage = (error: DeliveryError): string => {
  switch (error.type) {
    case 'DatabaseError':
      return error.message;
    case 'DuplicateDelivery':
      return `Duplicate delivery: ${error.deliveryKey}`;
    case 'DeliveryNotFound':
      return `Delivery not found: ${error.deliveryId}`;
    case 'NotificationNotFound':
      return `Notification not found: ${error.notificationId}`;
    case 'UserEmailNotFound':
      return `User email not found: ${error.userId}`;
    case 'DeliveryAlreadyClaimed':
      return `Delivery already claimed: ${error.deliveryId}`;
    case 'RenderError':
      return `Render error (${error.templateType}): ${error.message}`;
    case 'EmailSendError':
      return error.message;
    case 'WebhookVerificationError':
      return error.message;
    case 'DuplicateWebhookEvent':
      return `Duplicate webhook event: ${error.svixId}`;
  }
};
