import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { computeDestinationFingerprint } from '@/modules/notification-platform/shell/channel/destination-fingerprint.js';
import {
  computeEmailContentHash,
  makeEmailChannelAdapter,
  type NotificationPlatformEmailClient,
  type NotificationPlatformEmailError,
} from '@/modules/notification-platform/shell/channel/email-channel-adapter.js';

import {
  makeDelivery,
  makeDeliveryAttempt,
  makeDigestBatch,
  makeFakeLoggerPort,
  makeLogicalNotification,
  makeTestKind,
} from '../../../fixtures/notification-platform/index.js';
import { makeSequentialIds, makeTestClock } from '../../../support/index.js';

import type { SendEmailParams, SendEmailResult } from '@/infra/email/client.js';
import type { UnsubscribeTokenSigner } from '@/infra/unsubscribe/token.js';
import type {
  EmailRenderer,
  EmailTemplateProps,
  RenderedEmail,
} from '@/modules/email-templates/index.js';
import type { DeliveryError, UserEmailFetcher } from '@/modules/notification-delivery/index.js';

const RENDERED_EMAIL: RenderedEmail = {
  subject: 'Subiect test',
  html: '<p>Conținut test</p>',
  text: 'Conținut test',
  templateName: 'test',
  templateVersion: '1.0.0',
};

const makeHarness = (
  options: {
    email?: string | null;
    sendResult?: Result<SendEmailResult, NotificationPlatformEmailError>;
  } = {}
) => {
  const clock = makeTestClock(new Date('2026-07-10T09:00:00.000Z'));
  const ids = makeSequentialIds('adapter');
  const logger = makeFakeLoggerPort();
  const renderCalls: EmailTemplateProps[] = [];
  const sendCalls: SendEmailParams[] = [];
  const email = options.email === undefined ? 'User@Example.COM' : options.email;
  const emailResult: Result<string | null, DeliveryError> = ok(email);
  const userEmailFetcher: UserEmailFetcher = {
    getEmail: async () => emailResult,
    getEmailsByUserIds: async (userIds) => ok(new Map(userIds.map((userId) => [userId, email]))),
  };
  const emailRenderer: EmailRenderer = {
    render: async (props) => {
      renderCalls.push(props);
      return ok(RENDERED_EMAIL);
    },
    getTemplates: () => [],
    getTemplate: () => undefined,
  };
  const emailClient: NotificationPlatformEmailClient = {
    getFromAddress: () => 'notificari@transparenta.eu',
    send: async (params) => {
      sendCalls.push(params);
      return options.sendResult ?? ok({ emailId: 'provider-email-1' });
    },
  };
  const tokenSigner: UnsubscribeTokenSigner = {
    sign: (userId) => `token-${userId}`,
    verify: (token) => (token.startsWith('token-') ? { userId: token.slice(6) } : null),
  };
  const adapter = makeEmailChannelAdapter({
    emailClient,
    emailRenderer,
    tokenSigner,
    userEmailFetcher,
    fingerprintSecret: 'fingerprint-secret',
    fromAddress: 'notificari@transparenta.eu',
    platformBaseUrl: 'https://transparenta.eu/',
    apiBaseUrl: 'https://api.transparenta.eu/',
    logger,
  });

  return { adapter, clock, ids, logger, renderCalls, sendCalls };
};

describe('makeEmailChannelAdapter', () => {
  it('frames subject, html, and text before hashing', () => {
    const first = computeEmailContentHash({ subject: 'ab', html: 'c', text: '' });
    const second = computeEmailContentHash({ subject: 'a', html: 'bc', text: '' });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('normalizes the live address and computes a deterministic fingerprint', async () => {
    const h = makeHarness({ email: '  User@Example.COM  ' });

    const resolved = await h.adapter.resolveDestination('user-1');

    expect(resolved.isOk()).toBe(true);
    if (resolved.isOk()) {
      expect(resolved.value).toEqual({
        fingerprint: computeDestinationFingerprint('fingerprint-secret', 'user@example.com'),
        destination: { address: 'user@example.com' },
      });
    }

    const serializedLogs = JSON.stringify(h.logger.entries);
    expect(serializedLogs).not.toContain('user@example.com');
    expect(serializedLogs).not.toContain('User@Example.COM');
    expect(serializedLogs).toContain('use***@example.com');
  });

  it('renders a pinned kind template with platform and unsubscribe props', async () => {
    const h = makeHarness();
    const delivery = makeDelivery({ clock: h.clock, ids: h.ids });
    const kind = makeTestKind({
      templates: {
        inbox: { templateId: 'test-inbox', version: 'v1' },
        email: { templateId: 'welcome', version: '1.0.0' },
      },
    });
    const projection = {
      inbox: { title: 'Titlu', body: 'Corp', actionUrl: null },
      email: { templatePayload: { registeredAt: '2026-07-10T09:00:00.000Z' } },
      digestItem: { title: 'Titlu', summary: 'Rezumat', actionUrl: null },
    };

    const rendered = await h.adapter.render({
      delivery,
      kind,
      projection,
      unsubscribeContext: { userId: 'user-1', kindId: kind.kindId },
    });

    expect(rendered.isOk()).toBe(true);
    if (rendered.isOk()) {
      expect(rendered.value).toMatchObject({
        subject: RENDERED_EMAIL.subject,
        html: RENDERED_EMAIL.html,
        text: RENDERED_EMAIL.text,
      });
      expect(rendered.value.contentHash).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(h.renderCalls).toEqual([
      {
        templateType: 'welcome',
        lang: 'ro',
        unsubscribeUrl: 'https://api.transparenta.eu/api/v1/notifications/unsubscribe/token-user-1',
        preferencesUrl: 'https://transparenta.eu/settings/notifications',
        platformBaseUrl: 'https://transparenta.eu/',
        copyrightYear: 2026,
        registeredAt: '2026-07-10T09:00:00.000Z',
      },
    ]);
  });

  it('renders digest snapshots with persisted inbox fields and overflow metadata', async () => {
    const h = makeHarness();
    const delivery = makeDelivery(
      { clock: h.clock, ids: h.ids },
      { logicalNotificationId: null, digestBatchId: 'batch-1' }
    );
    const batch = makeDigestBatch({ clock: h.clock, ids: h.ids }, { id: 'batch-1' });
    const items = [
      makeLogicalNotification(
        { clock: h.clock, ids: h.ids },
        {
          inboxTitle: 'Vot publicat',
          inboxBody: 'Inițiativa urmărită a fost votată.',
          inboxActionUrl: 'https://transparenta.eu/vot/1',
        }
      ),
      makeLogicalNotification(
        { clock: h.clock, ids: h.ids },
        { inboxTitle: 'Raport nou', inboxBody: 'Au apărut date noi.', inboxActionUrl: null }
      ),
    ];

    const rendered = await h.adapter.renderDigest({
      delivery,
      batch,
      items,
      overflowCount: 4,
    });

    expect(rendered.isOk()).toBe(true);
    expect(h.renderCalls[0]).toEqual({
      templateType: 'notification-platform-digest',
      lang: 'ro',
      unsubscribeUrl: 'https://api.transparenta.eu/api/v1/notifications/unsubscribe/token-user-1',
      preferencesUrl: 'https://transparenta.eu/settings/notifications',
      platformBaseUrl: 'https://transparenta.eu/',
      copyrightYear: 2026,
      items: [
        {
          title: 'Vot publicat',
          summary: 'Inițiativa urmărită a fost votată.',
          actionUrl: 'https://transparenta.eu/vot/1',
        },
        { title: 'Raport nou', summary: 'Au apărut date noi.', actionUrl: null },
      ],
      overflowCount: 4,
      inboxUrl: 'https://transparenta.eu/notifications',
    });
  });

  it('maps accepted provider sends and uses the delivery id as idempotency key', async () => {
    const h = makeHarness();
    const delivery = makeDelivery({ clock: h.clock, ids: h.ids });
    const attempt = makeDeliveryAttempt(
      { clock: h.clock, ids: h.ids },
      { deliveryId: delivery.id, attemptNumber: 2 }
    );

    const sent = await h.adapter.send({
      delivery,
      attempt,
      destination: { address: 'private.user@example.com' },
    });

    expect(sent).toEqual(ok({ classification: 'accepted', providerRef: 'provider-email-1' }));
    expect(h.sendCalls[0]).toMatchObject({
      to: 'private.user@example.com',
      idempotencyKey: delivery.id,
      unsubscribeUrl: 'https://api.transparenta.eu/api/v1/notifications/unsubscribe/token-user-1',
      tags: [
        { name: 'delivery_id', value: delivery.id },
        { name: 'attempt_number', value: '2' },
      ],
    });
    expect(JSON.stringify(h.logger.entries)).not.toContain('private.user@example.com');
    expect(JSON.stringify(h.logger.entries)).toContain('pri***@example.com');
  });

  it.each([
    {
      label: '429',
      providerError: {
        type: 'RATE_LIMITED' as const,
        message: 'rate limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 8_000,
      },
      expected: {
        classification: 'transient_failure',
        errorCode: 'RATE_LIMITED',
        errorMessage: 'Email provider request did not complete',
        retryAfterMs: 8_000,
      },
    },
    {
      label: 'validation',
      providerError: {
        type: 'VALIDATION' as const,
        message: 'invalid recipient',
        retryable: false,
        statusCode: 422,
      },
      expected: {
        classification: 'permanent_failure',
        errorCode: 'VALIDATION',
        errorMessage: 'Email provider rejected the request',
      },
    },
    {
      label: 'socket-after-write',
      providerError: {
        type: 'NETWORK' as const,
        message: 'socket hang up after write',
        retryable: true,
        ambiguous: true,
      },
      expected: {
        classification: 'ambiguous',
        errorCode: 'NETWORK',
        errorMessage: 'Email provider request did not complete',
      },
    },
    {
      label: 'retryable UNKNOWN',
      providerError: {
        type: 'UNKNOWN' as const,
        message: 'provider unavailable',
        retryable: true,
      },
      expected: {
        classification: 'transient_failure',
        errorCode: 'UNKNOWN',
        errorMessage: 'Email provider request did not complete',
      },
    },
    {
      label: 'non-retryable UNKNOWN',
      providerError: {
        type: 'UNKNOWN' as const,
        message: 'provider rejected request',
        retryable: false,
      },
      expected: {
        classification: 'permanent_failure',
        errorCode: 'UNKNOWN',
        errorMessage: 'Email provider request did not complete',
      },
    },
    {
      label: 'socket text without explicit ambiguity',
      providerError: {
        type: 'NETWORK' as const,
        message: 'socket hang up after write',
        retryable: true,
      },
      expected: {
        classification: 'transient_failure',
        errorCode: 'NETWORK',
        errorMessage: 'Email provider request did not complete',
      },
    },
  ])('classifies $label provider errors', async ({ providerError, expected }) => {
    const h = makeHarness({ sendResult: err(providerError) });
    const delivery = makeDelivery({ clock: h.clock, ids: h.ids });
    const attempt = makeDeliveryAttempt(
      { clock: h.clock, ids: h.ids },
      { deliveryId: delivery.id }
    );

    const sent = await h.adapter.send({
      delivery,
      attempt,
      destination: { address: 'private.user@example.com' },
    });

    expect(sent).toEqual(ok(expected));
    expect(JSON.stringify(h.logger.entries)).not.toContain('private.user@example.com');
  });

  it('returns unknown reconciliation when outbound lookup is unavailable', async () => {
    const h = makeHarness();

    await expect(
      h.adapter.reconcile({ providerIdempotencyKey: 'delivery-1', providerRef: 'email-1' })
    ).resolves.toEqual(ok({ known: false }));
  });
});
