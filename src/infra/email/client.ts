/**
 * Resend Email Client
 *
 * Provides email sending functionality via Resend API.
 * IMPORTANT: Uses correct Resend SDK idempotency key pattern.
 */

import { ok, err, type Result } from 'neverthrow';
import { Resend } from 'resend';

import type { Logger } from 'pino';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Email client configuration.
 */
export interface EmailClientConfig {
  /** Resend API key */
  apiKey: string;
  /** From address for outbound emails */
  fromAddress: string;
  /** Logger instance */
  logger: Logger;
}

/**
 * Email tag for Resend (name/value pairs).
 * IMPORTANT: Tag names and values must only contain ASCII letters, numbers,
 * underscores, and dashes. NO COLONS allowed.
 */
export interface EmailTag {
  name: string;
  value: string;
}

/**
 * Parameters for sending an email.
 */
export interface SendEmailParams {
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject: string;
  /** HTML content */
  html: string;
  /** Plain text content */
  text: string;
  /**
   * Idempotency key for deduplication (24h validity).
   * MUST be a UUID (no colons allowed).
   */
  idempotencyKey: string;
  /** Unsubscribe URL for List-Unsubscribe header */
  unsubscribeUrl: string;
  /** Tags for tracking and webhook correlation */
  tags: EmailTag[];
}

/**
 * Result of sending an email.
 */
export interface SendEmailResult {
  /** Resend email ID */
  emailId: string;
}

/**
 * Email sending error.
 */
export interface EmailError {
  type: 'RATE_LIMITED' | 'VALIDATION' | 'SERVER' | 'NETWORK' | 'UNKNOWN';
  message: string;
  retryable: boolean;
  statusCode?: number;
}

/**
 * Email sender interface (port).
 */
export interface EmailSender {
  /** Send an email via Resend */
  send(params: SendEmailParams): Promise<Result<SendEmailResult, EmailError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a Resend email client.
 *
 * CRITICAL: Idempotency key must be passed in the SDK options (2nd argument),
 * NOT as an email header. Tags must not contain colons.
 */
export const makeEmailClient = (config: EmailClientConfig): EmailSender => {
  const { apiKey, fromAddress, logger } = config;
  const log = logger.child({ component: 'EmailClient' });
  const resend = new Resend(apiKey);

  log.info('Initializing Resend email client');

  return {
    async send(params: SendEmailParams): Promise<Result<SendEmailResult, EmailError>> {
      const { to, subject, html, text, idempotencyKey, unsubscribeUrl, tags } = params;

      log.debug({ to, subject, idempotencyKey, tagCount: tags.length }, 'Sending email');

      try {
        // CORRECT: Idempotency key goes in SDK options (2nd argument), NOT headers
        const result = await resend.emails.send(
          {
            from: fromAddress,
            to,
            subject,
            html,
            text,
            headers: {
              // List-Unsubscribe headers for CAN-SPAM compliance
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
            tags,
          },
          {
            // SDK-level options (2nd argument)
            idempotencyKey,
          }
        );

        if (result.error !== null) {
          log.warn({ error: result.error, to, idempotencyKey }, 'Resend API returned error');
          return err(mapResendError(result.error));
        }

        // At this point TypeScript knows result.data is non-null
        log.info({ emailId: result.data.id, to, idempotencyKey }, 'Email sent successfully');

        return ok({
          emailId: result.data.id,
        });
      } catch (error) {
        log.error({ error, to, idempotencyKey }, 'Failed to send email');
        return err(mapCaughtError(error));
      }
    },
  };
};

/**
 * Maps Resend API error to our EmailError type.
 */
function mapResendError(error: {
  statusCode: number | null;
  message: string;
  name: string;
}): EmailError {
  const statusCode = error.statusCode ?? undefined;
  const message = error.message;

  if (statusCode === 429) {
    return {
      type: 'RATE_LIMITED',
      message: 'Rate limit exceeded',
      retryable: true,
      statusCode,
    };
  }

  if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
    return {
      type: 'VALIDATION',
      message,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return {
      type: 'SERVER',
      message,
      retryable: true,
      statusCode,
    };
  }

  const result: EmailError = {
    type: 'UNKNOWN',
    message,
    retryable: false,
  };
  if (statusCode !== undefined) {
    result.statusCode = statusCode;
  }
  return result;
}

/**
 * Maps caught errors to our EmailError type.
 */
function mapCaughtError(error: unknown): EmailError {
  if (error instanceof Error) {
    // Network errors are typically retryable
    if (
      error.message.includes('ECONNREFUSED') ||
      error.message.includes('ETIMEDOUT') ||
      error.message.includes('ENOTFOUND')
    ) {
      return {
        type: 'NETWORK',
        message: error.message,
        retryable: true,
      };
    }

    return {
      type: 'UNKNOWN',
      message: error.message,
      retryable: false,
    };
  }

  return {
    type: 'UNKNOWN',
    message: 'Unknown error occurred',
    retryable: false,
  };
}

/**
 * Checks if an error is retryable.
 */
export const isRetryableEmailError = (error: EmailError): boolean => error.retryable;

// ─────────────────────────────────────────────────────────────────────────────
// Webhook Verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Webhook verifier configuration.
 */
export interface WebhookVerifierConfig {
  /** Resend webhook signing secret */
  webhookSecret: string;
  /** Logger instance */
  logger: Logger;
}

/**
 * Svix headers from Resend webhooks.
 */
export interface SvixHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

/**
 * Resend webhook event types we handle.
 */
export type ResendEventType =
  | 'email.sent'
  | 'email.delivered'
  | 'email.delivery_delayed'
  | 'email.bounced'
  | 'email.complained'
  | 'email.suppressed'
  | 'email.failed';

/**
 * Resend webhook event structure.
 */
export interface ResendWebhookEvent {
  type: ResendEventType;
  data: {
    email_id: string;
    to?: string[];
    subject?: string;
    bounce?: {
      type: 'Permanent' | 'Transient';
      subType: string;
    };
    reason?: string;
    error?: string;
    tags?: { name: string; value: string }[] | Record<string, string>;
  };
}

/**
 * Webhook verification error.
 */
export interface WebhookError {
  type: 'INVALID_SIGNATURE' | 'INVALID_PAYLOAD' | 'EXPIRED' | 'UNKNOWN';
  message: string;
}

/**
 * Webhook verifier interface (port).
 */
export interface WebhookVerifier {
  /** Verify a Resend webhook signature and parse the event */
  verify(rawBody: string, headers: SvixHeaders): Promise<Result<ResendWebhookEvent, WebhookError>>;
}

/**
 * Creates a Resend webhook verifier.
 *
 * Uses the Resend SDK's built-in webhook verification which is based on svix.
 */
export const makeWebhookVerifier = (config: WebhookVerifierConfig): WebhookVerifier => {
  const { webhookSecret, logger } = config;
  const log = logger.child({ component: 'WebhookVerifier' });
  const resend = new Resend();

  log.info('Initializing Resend webhook verifier');

  return {
    // Resend SDK's verify method is synchronous, so we wrap in Promise.resolve
    verify(
      rawBody: string,
      headers: SvixHeaders
    ): Promise<Result<ResendWebhookEvent, WebhookError>> {
      const { svixId, svixTimestamp, svixSignature } = headers;

      log.debug({ svixId }, 'Verifying webhook signature');

      try {
        // Resend SDK's webhook verify method - single object argument (synchronous)
        const event = resend.webhooks.verify({
          payload: rawBody,
          headers: {
            id: svixId,
            timestamp: svixTimestamp,
            signature: svixSignature,
          },
          webhookSecret,
        });

        // The event is returned directly, not wrapped in a promise
        log.debug({ svixId, eventType: (event as ResendWebhookEvent).type }, 'Webhook verified');

        return Promise.resolve(ok(event as ResendWebhookEvent));
      } catch (error) {
        log.warn({ error, svixId }, 'Webhook verification failed');

        if (error instanceof Error) {
          if (error.message.includes('expired')) {
            return Promise.resolve(
              err({
                type: 'EXPIRED',
                message: error.message,
              })
            );
          }

          if (error.message.includes('signature')) {
            return Promise.resolve(
              err({
                type: 'INVALID_SIGNATURE',
                message: error.message,
              })
            );
          }
        }

        return Promise.resolve(
          err({
            type: 'UNKNOWN',
            message: error instanceof Error ? error.message : 'Unknown verification error',
          })
        );
      }
    },
  };
};
