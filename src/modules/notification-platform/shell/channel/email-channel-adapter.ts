import { createHash } from 'node:crypto';

import { err, ok, type Result } from 'neverthrow';

import {
  redactEmailAddress,
  type EmailError,
  type SendEmailParams,
  type SendEmailResult,
} from '@/infra/email/client.js';

import { computeDestinationFingerprint } from './destination-fingerprint.js';
import {
  createDeliveryRenderError,
  createProviderDeliveryError,
} from '../../core/delivery/errors.js';

import type { ChannelAdapterPort } from '../../core/delivery/ports.js';
import type { Delivery, DeliveryAttempt } from '../../core/delivery/types.js';
import type { LoggerPort } from '../../core/shared/ports.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type {
  EmailRenderer,
  EmailTemplateProps,
  RenderedEmail,
} from '@/modules/email-templates/index.js';
import type { UserEmailFetcher } from '@/modules/notification-delivery/index.js';

export interface NotificationPlatformEmailError extends EmailError {
  retryAfterMs?: number;
  /** Set only when the client knows the request may have reached the provider. */
  ambiguous?: boolean;
}

export interface NotificationPlatformEmailClient {
  getFromAddress(): string;
  send(params: SendEmailParams): Promise<Result<SendEmailResult, NotificationPlatformEmailError>>;
}

export interface EmailChannelAdapterConfig {
  emailClient: NotificationPlatformEmailClient;
  emailRenderer: EmailRenderer;
  tokenSigner: UnsubscribeTokenSigner;
  userEmailFetcher: UserEmailFetcher;
  fingerprintSecret: string;
  fromAddress: string;
  platformBaseUrl: string;
  apiBaseUrl: string;
  logger?: LoggerPort;
}

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/$/u, '')}/${path.replace(/^\//u, '')}`;

const makeUnsubscribeUrl = (
  config: Pick<EmailChannelAdapterConfig, 'apiBaseUrl' | 'tokenSigner'>,
  userId: string
): string =>
  joinUrl(
    config.apiBaseUrl,
    `/api/v1/notifications/unsubscribe/${config.tokenSigner.sign(userId)}`
  );

const frameHashSegment = (value: string): string =>
  `${String(Buffer.byteLength(value, 'utf8'))}:${value}`;

export const computeEmailContentHash = (
  rendered: Pick<RenderedEmail, 'subject' | 'html' | 'text'>
): string =>
  createHash('sha256')
    .update(
      [rendered.subject, rendered.html, rendered.text].map(frameHashSegment).join('\u0000'),
      'utf8'
    )
    .digest('hex');

const mapEmailLookupError = (error: { type: string; retryable?: boolean }) =>
  createProviderDeliveryError(
    'Failed to resolve email destination',
    error.retryable === true,
    error.type
  );

type FailedSendClassification = Exclude<
  Awaited<ReturnType<ChannelAdapterPort['send']>> extends Result<infer TValue, unknown>
    ? TValue
    : never,
  { classification: 'accepted' }
>;

const classifyEmailError = (error: NotificationPlatformEmailError): FailedSendClassification => {
  const base = {
    errorCode: error.type,
    errorMessage:
      error.type === 'VALIDATION'
        ? 'Email provider rejected the request'
        : 'Email provider request did not complete',
  };

  if (error.ambiguous === true) {
    return { classification: 'ambiguous', ...base };
  }

  if (error.type === 'VALIDATION') {
    return { classification: 'permanent_failure', ...base };
  }

  if (
    error.type === 'RATE_LIMITED' ||
    error.type === 'SERVER' ||
    error.type === 'NETWORK' ||
    error.retryable
  ) {
    return {
      classification: 'transient_failure',
      ...base,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }

  return {
    classification: 'permanent_failure',
    ...base,
    ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
  };
};

const renderWithHash = async (
  renderer: EmailRenderer,
  props: EmailTemplateProps
): ReturnType<ChannelAdapterPort['render']> => {
  const rendered = await renderer.render(props);
  if (rendered.isErr()) {
    return err(createDeliveryRenderError(rendered.error.message));
  }

  return ok({
    subject: rendered.value.subject,
    html: rendered.value.html,
    text: rendered.value.text,
    contentHash: computeEmailContentHash(rendered.value),
  });
};

const requireRenderedContent = (
  delivery: Delivery
): Result<
  { subject: string; html: string; text: string },
  ReturnType<typeof createDeliveryRenderError>
> => {
  if (
    delivery.renderedSubject === null ||
    delivery.renderedHtml === null ||
    delivery.renderedText === null
  ) {
    return err(createDeliveryRenderError('Delivery has no rendered email content'));
  }

  return ok({
    subject: delivery.renderedSubject,
    html: delivery.renderedHtml,
    text: delivery.renderedText,
  });
};

const makeSendParams = (
  config: EmailChannelAdapterConfig,
  delivery: Delivery,
  attempt: DeliveryAttempt,
  address: string,
  rendered: { subject: string; html: string; text: string }
): SendEmailParams => ({
  to: address,
  subject: rendered.subject,
  html: rendered.html,
  text: rendered.text,
  idempotencyKey: delivery.id,
  unsubscribeUrl: makeUnsubscribeUrl(config, delivery.userId),
  tags: [
    { name: 'delivery_id', value: delivery.id },
    { name: 'attempt_number', value: String(attempt.attemptNumber) },
  ],
});

export const makeEmailChannelAdapter = (config: EmailChannelAdapterConfig): ChannelAdapterPort => {
  if (
    config.emailClient.getFromAddress().trim().toLowerCase() !==
    config.fromAddress.trim().toLowerCase()
  ) {
    throw new Error('Notification platform email client from-address mismatch');
  }

  config.logger?.info('Initializing notification platform email adapter', {
    fromAddress: redactEmailAddress(config.fromAddress),
  });

  return {
    channel: 'email',

    async resolveDestination(userId) {
      const fetched = await config.userEmailFetcher.getEmail(userId);
      if (fetched.isErr()) {
        config.logger?.error('Failed to resolve notification email destination', {
          userId,
          errorType: fetched.error.type,
        });
        return err(mapEmailLookupError(fetched.error));
      }
      if (fetched.value === null) {
        return ok(null);
      }

      const address = fetched.value.trim().toLowerCase();
      if (address.length === 0) {
        return ok(null);
      }
      const fingerprint = computeDestinationFingerprint(config.fingerprintSecret, address);
      config.logger?.debug('Resolved notification email destination', {
        userId,
        address: redactEmailAddress(address),
        fingerprint,
      });
      return ok({ fingerprint, destination: { address } });
    },

    async render({ delivery, kind, projection, unsubscribeContext }) {
      const props = {
        ...projection.email.templatePayload,
        templateType: kind.templates.email.templateId,
        lang: 'ro',
        unsubscribeUrl: makeUnsubscribeUrl(config, unsubscribeContext.userId),
        preferencesUrl: joinUrl(config.platformBaseUrl, '/settings/notifications'),
        platformBaseUrl: config.platformBaseUrl,
        copyrightYear: delivery.createdAt.getUTCFullYear(),
      } as EmailTemplateProps;

      return renderWithHash(config.emailRenderer, props);
    },

    async renderDigest({ delivery, batch, items, overflowCount }) {
      const props: EmailTemplateProps = {
        templateType: 'notification-platform-digest',
        lang: 'ro',
        unsubscribeUrl: makeUnsubscribeUrl(config, batch.userId),
        preferencesUrl: joinUrl(config.platformBaseUrl, '/settings/notifications'),
        platformBaseUrl: config.platformBaseUrl,
        copyrightYear: delivery.createdAt.getUTCFullYear(),
        items: items.map((item) => ({
          title: item.inboxTitle,
          summary: item.inboxBody,
          actionUrl: item.inboxActionUrl,
        })),
        overflowCount,
        inboxUrl: joinUrl(config.platformBaseUrl, '/notifications'),
      };

      return renderWithHash(config.emailRenderer, props);
    },

    async send({ delivery, attempt, destination }) {
      const rendered = requireRenderedContent(delivery);
      if (rendered.isErr()) {
        return err(rendered.error);
      }

      const redactedAddress = redactEmailAddress(destination.address);
      config.logger?.debug('Sending notification platform email', {
        deliveryId: delivery.id,
        address: redactedAddress,
      });
      const sent = await config.emailClient.send(
        makeSendParams(config, delivery, attempt, destination.address, rendered.value)
      );
      if (sent.isErr()) {
        const classified = classifyEmailError(sent.error);
        config.logger?.warn('Notification platform email send failed', {
          deliveryId: delivery.id,
          address: redactedAddress,
          errorCode: classified.errorCode,
          classification: classified.classification,
        });
        return ok(classified);
      }

      config.logger?.info('Notification platform email accepted', {
        deliveryId: delivery.id,
        address: redactedAddress,
        providerRef: sent.value.emailId,
      });
      return ok({ classification: 'accepted', providerRef: sent.value.emailId });
    },

    // DESIGN NOTE: the current EmailClient exposes send but no outbound-email lookup.
    // Webhook delivery outcomes and audited manual resolution remain authoritative.
    reconcile() {
      return Promise.resolve(ok({ known: false }));
    },
  };
};
