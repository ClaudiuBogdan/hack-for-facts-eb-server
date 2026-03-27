/**
 * Resend Email Client
 *
 * Provides email sending functionality via Resend API.
 * IMPORTANT: Uses correct Resend SDK idempotency key pattern.
 */

import { ok, err, type Result } from 'neverthrow';
import { Resend } from 'resend';
import { Webhook } from 'svix';

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
  /** Optional CC recipients */
  cc?: string[];
  /** Optional BCC recipients */
  bcc?: string[];
  /** Optional Reply-To addresses */
  replyTo?: string[];
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
  /** Get the configured from address used for outbound emails */
  getFromAddress(): string;
  /** Send an email via Resend */
  send(params: SendEmailParams): Promise<Result<SendEmailResult, EmailError>>;
}

export interface ReceivedEmailAttachment {
  id: string;
  filename: string;
  contentType: string;
  contentDisposition: string | null;
  contentId: string | null;
}

export interface ReceivedEmail {
  id: string;
  to: string[];
  from: string;
  createdAt: Date;
  subject: string;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  bcc: string[];
  cc: string[];
  replyTo: string[];
  messageId: string | null;
  attachments: ReceivedEmailAttachment[];
  rawDownloadUrl: string | null;
  rawExpiresAt: Date | null;
}

export interface ReceivedEmailFetcher {
  getReceivedEmail(emailId: string): Promise<Result<ReceivedEmail, EmailError>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation
// ─────────────────────────────────────────────────────────────────────────────

export const redactEmailAddress = (email: string): string => {
  const separatorIndex = email.indexOf('@');
  if (separatorIndex <= 0 || separatorIndex === email.length - 1) {
    return '***';
  }

  const localPart = email.slice(0, separatorIndex);
  const domain = email.slice(separatorIndex);
  const visibleLength = Math.min(3, localPart.length);

  return `${localPart.slice(0, visibleLength)}***${domain}`;
};

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
    getFromAddress(): string {
      return fromAddress;
    },

    async send(params: SendEmailParams): Promise<Result<SendEmailResult, EmailError>> {
      const { to, cc, bcc, replyTo, subject, html, text, idempotencyKey, unsubscribeUrl, tags } =
        params;

      // SECURITY: SEC-013 - Redact email address in logs to prevent PII leakage
      const redactedTo = redactEmailAddress(to);
      log.debug(
        {
          to: redactedTo,
          subject,
          idempotencyKey,
          tagCount: tags.length,
          ccCount: cc?.length ?? 0,
          bccCount: bcc?.length ?? 0,
          replyToCount: replyTo?.length ?? 0,
        },
        'Sending email'
      );

      try {
        // CORRECT: Idempotency key goes in SDK options (2nd argument), NOT headers
        const result = await resend.emails.send(
          {
            from: fromAddress,
            to,
            ...(cc !== undefined && cc.length > 0 ? { cc } : {}),
            ...(bcc !== undefined && bcc.length > 0 ? { bcc } : {}),
            ...(replyTo !== undefined && replyTo.length > 0 ? { replyTo } : {}),
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
          log.warn(
            { error: result.error, to: redactedTo, idempotencyKey },
            'Resend API returned error'
          );
          return err(mapResendError(result.error));
        }

        // At this point TypeScript knows result.data is non-null
        log.info(
          { emailId: result.data.id, to: redactedTo, idempotencyKey },
          'Email sent successfully'
        );

        return ok({
          emailId: result.data.id,
        });
      } catch (error) {
        log.error({ error, to: redactedTo, idempotencyKey }, 'Failed to send email');
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

const mapReceivedEmail = (value: unknown): ReceivedEmail => {
  const row = value as {
    id: string;
    to?: string[];
    from: string;
    created_at: string;
    subject: string;
    html?: string | null;
    text?: string | null;
    headers?: Record<string, string>;
    bcc?: string[];
    cc?: string[];
    reply_to?: string[];
    message_id?: string | null;
    attachments?: {
      id: string;
      filename: string;
      content_type: string;
      content_disposition?: string | null;
      content_id?: string | null;
    }[];
    raw?: {
      download_url?: string | null;
      expires_at?: string | null;
    } | null;
  };

  return {
    id: row.id,
    to: row.to ?? [],
    from: row.from,
    createdAt: new Date(row.created_at),
    subject: row.subject,
    html: row.html ?? null,
    text: row.text ?? null,
    headers: row.headers ?? {},
    bcc: row.bcc ?? [],
    cc: row.cc ?? [],
    replyTo: row.reply_to ?? [],
    messageId: row.message_id ?? null,
    attachments:
      row.attachments?.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.content_type,
        contentDisposition: attachment.content_disposition ?? null,
        contentId: attachment.content_id ?? null,
      })) ?? [],
    rawDownloadUrl: row.raw?.download_url ?? null,
    rawExpiresAt:
      row.raw?.expires_at !== undefined && row.raw.expires_at !== null
        ? new Date(row.raw.expires_at)
        : null,
  };
};

export const makeReceivedEmailFetcher = (config: EmailClientConfig): ReceivedEmailFetcher => {
  const resend = new Resend(config.apiKey);
  const log = config.logger.child({ component: 'ReceivedEmailFetcher' });

  return {
    async getReceivedEmail(emailId: string): Promise<Result<ReceivedEmail, EmailError>> {
      try {
        const receiving = resend.emails as unknown as {
          receiving?: {
            get(id: string): Promise<{
              data: Record<string, unknown> | null;
              error: {
                statusCode: number | null;
                message: string;
                name: string;
              } | null;
            }>;
          };
        };

        if (receiving.receiving === undefined) {
          return err({
            type: 'UNKNOWN',
            message: 'Resend receiving client is unavailable in this SDK version',
            retryable: false,
          });
        }

        const result = await receiving.receiving.get(emailId);
        if (result.error !== null) {
          log.warn({ emailId, error: result.error }, 'Failed to fetch received email');
          return err(mapResendError(result.error));
        }

        if (result.data === null) {
          return err({
            type: 'UNKNOWN',
            message: 'Received email payload missing from Resend response',
            retryable: false,
          });
        }

        return ok(mapReceivedEmail(result.data));
      } catch (error) {
        log.error({ emailId, error }, 'Failed to fetch received email');
        return err(mapCaughtError(error));
      }
    },
  };
};

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
  | 'email.complained'
  | 'email.bounced'
  | 'email.opened'
  | 'email.clicked'
  | 'email.suppressed'
  | 'email.failed'
  | 'email.scheduled'
  | 'email.received';

/**
 * Resend webhook event structure.
 */
export interface ResendWebhookEvent {
  type: ResendEventType;
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    message_id?: string;
    subject: string;
    created_at: string;
    broadcast_id?: string;
    template_id?: string;
    attachments?: {
      id: string;
      filename: string;
      content_type: string;
      content_disposition?: string | null;
      content_id?: string | null;
    }[];
    bounce?: {
      diagnosticCode?: string[];
      message?: string;
      type: string;
      subType: string;
    };
    click?: {
      ipAddress: string;
      link: string;
      timestamp: string;
      userAgent: string;
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
 * Uses Svix directly, which is the same signature mechanism used by Resend webhooks.
 */
export const makeWebhookVerifier = (config: WebhookVerifierConfig): WebhookVerifier => {
  const { webhookSecret, logger } = config;
  const log = logger.child({ component: 'WebhookVerifier' });
  const webhook = new Webhook(webhookSecret);

  log.info('Initializing Resend webhook verifier');

  return {
    verify(
      rawBody: string,
      headers: SvixHeaders
    ): Promise<Result<ResendWebhookEvent, WebhookError>> {
      const { svixId, svixTimestamp, svixSignature } = headers;

      log.debug({ svixId }, 'Verifying webhook signature');

      try {
        const event = webhook.verify(rawBody, {
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': svixSignature,
        });

        log.debug({ svixId, eventType: (event as ResendWebhookEvent).type }, 'Webhook verified');

        return Promise.resolve(ok(event as ResendWebhookEvent));
      } catch (error) {
        log.warn({ error, svixId }, 'Webhook verification failed');

        if (error instanceof Error) {
          const lowerMessage = error.message.toLowerCase();

          if (
            lowerMessage.includes('expired') ||
            lowerMessage.includes('too old') ||
            lowerMessage.includes('too new')
          ) {
            return Promise.resolve(
              err({
                type: 'EXPIRED',
                message: error.message,
              })
            );
          }

          if (
            lowerMessage.includes('signature') ||
            lowerMessage.includes('matching signature') ||
            lowerMessage.includes('required headers')
          ) {
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
