import fastifyLib, { type FastifyInstance } from 'fastify';
import { ok, err } from 'neverthrow';
import pinoLogger from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  makeResendWebhookRoutes,
  type ResendEmailWebhookEvent,
  type ResendWebhookRoutesDeps,
  type StoredResendEmailEvent,
} from '@/modules/resend-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });

const createEvent = (): ResendEmailWebhookEvent => ({
  type: 'email.delivered',
  created_at: '2026-03-23T10:00:00.000Z',
  data: {
    email_id: 'email-1',
    from: 'noreply@transparenta.eu',
    to: ['user@example.com'],
    subject: 'Subject',
    created_at: '2026-03-23T09:59:00.000Z',
    tags: [{ name: 'thread_key', value: 'thread-1' }],
  },
});

const createStoredEvent = (): StoredResendEmailEvent => ({
  id: 'stored-1',
  svixId: 'svix-1',
  eventType: 'email.delivered',
  webhookReceivedAt: new Date('2026-03-23T10:00:01.000Z'),
  eventCreatedAt: new Date('2026-03-23T10:00:00.000Z'),
  emailId: 'email-1',
  fromAddress: 'noreply@transparenta.eu',
  toAddresses: ['user@example.com'],
  subject: 'Subject',
  emailCreatedAt: new Date('2026-03-23T09:59:00.000Z'),
  broadcastId: null,
  templateId: null,
  tags: [{ name: 'thread_key', value: 'thread-1' }],
  bounceType: null,
  bounceSubType: null,
  bounceMessage: null,
  bounceDiagnosticCode: null,
  clickIpAddress: null,
  clickLink: null,
  clickTimestamp: null,
  clickUserAgent: null,
  threadKey: 'thread-1',
  metadata: {},
});

const createTestApp = async (
  overrides: Partial<ResendWebhookRoutesDeps> = {}
): Promise<FastifyInstance> => {
  const insert = vi.fn().mockResolvedValue(ok(createStoredEvent()));
  const findBySvixId = vi.fn().mockResolvedValue(ok(createStoredEvent()));
  const findThreadKeyByMessageReferences = vi.fn().mockResolvedValue(ok(null));
  const updateStoredEvent = vi.fn().mockResolvedValue(ok(createStoredEvent()));
  const handle = vi.fn().mockResolvedValue(undefined);

  const app = fastifyLib({ logger: false });
  await app.register(
    makeResendWebhookRoutes({
      webhookVerifier: {
        verify: async () => ok(createEvent()),
      },
      emailEventsRepo: {
        insert,
        findBySvixId,
        findThreadKeyByMessageReferences,
        updateStoredEvent,
      },
      sideEffect: {
        handle,
      },
      logger: testLogger,
      ...overrides,
    })
  );

  await app.ready();
  return app;
};

describe('makeResendWebhookRoutes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
    }
  });

  it('returns 400 when svix headers are missing', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing svix headers' });
  });

  it('returns 401 when webhook verification fails', async () => {
    app = await createTestApp({
      webhookVerifier: {
        verify: async () =>
          err({
            type: 'INVALID_SIGNATURE',
            message: 'bad signature',
          }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'svix-1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid signature' });
  });

  it('returns 200 and runs side effects for a newly stored event', async () => {
    const insert = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const findBySvixId = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const handle = vi.fn().mockResolvedValue(undefined);

    app = await createTestApp({
      emailEventsRepo: {
        insert,
        findBySvixId,
        findThreadKeyByMessageReferences: vi.fn().mockResolvedValue(ok(null)),
        updateStoredEvent: vi.fn().mockResolvedValue(ok(createStoredEvent())),
      },
      sideEffect: { handle },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'svix-1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'processed' });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(findBySvixId).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('returns 200 ignored for unsupported resend webhook payloads', async () => {
    const insert = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const handle = vi.fn().mockResolvedValue(undefined);

    app = await createTestApp({
      webhookVerifier: {
        verify: async () =>
          ok({
            type: 'domain.created',
            created_at: '2026-04-03T14:38:06.333123Z',
            data: {},
          } as unknown as ResendEmailWebhookEvent),
      },
      emailEventsRepo: {
        insert,
        findBySvixId: vi.fn().mockResolvedValue(ok(createStoredEvent())),
        findThreadKeyByMessageReferences: vi.fn().mockResolvedValue(ok(null)),
        updateStoredEvent: vi.fn().mockResolvedValue(ok(createStoredEvent())),
      },
      sideEffect: { handle },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'svix-unsupported-1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: {
        type: 'domain.created',
        created_at: '2026-04-03T14:38:06.333123Z',
        data: {},
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ignored' });
    expect(insert).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('returns 500 for malformed supported resend webhook payloads so delivery can retry', async () => {
    const insert = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const handle = vi.fn().mockResolvedValue(undefined);

    app = await createTestApp({
      webhookVerifier: {
        verify: async () =>
          ok({
            type: 'email.delivered',
            created_at: '2026-04-03T14:38:06.333123Z',
            data: {
              from: 'noreply@transparenta.eu',
              to: ['user@example.com'],
              subject: 'Subject',
              created_at: '2026-04-03T14:38:06.333123Z',
            },
          } as unknown as ResendEmailWebhookEvent),
      },
      emailEventsRepo: {
        insert,
        findBySvixId: vi.fn().mockResolvedValue(ok(createStoredEvent())),
        findThreadKeyByMessageReferences: vi.fn().mockResolvedValue(ok(null)),
        updateStoredEvent: vi.fn().mockResolvedValue(ok(createStoredEvent())),
      },
      sideEffect: { handle },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'svix-malformed-1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: {
        type: 'email.delivered',
        created_at: '2026-04-03T14:38:06.333123Z',
        data: {
          from: 'noreply@transparenta.eu',
          to: ['user@example.com'],
          subject: 'Subject',
          created_at: '2026-04-03T14:38:06.333123Z',
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(insert).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it('reruns side effects for duplicate svix ids using the stored event', async () => {
    const findBySvixId = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const handle = vi.fn().mockResolvedValue(undefined);

    app = await createTestApp({
      emailEventsRepo: {
        insert: async () =>
          err({
            type: 'DuplicateResendWebhookEvent',
            svixId: 'svix-1',
          }),
        findBySvixId,
        findThreadKeyByMessageReferences: vi.fn().mockResolvedValue(ok(null)),
        updateStoredEvent: vi.fn().mockResolvedValue(ok(createStoredEvent())),
      },
      sideEffect: { handle },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'svix-1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'already_processed' });
    expect(findBySvixId).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when side effects throw so webhook delivery can retry', async () => {
    const insert = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const findBySvixId = vi.fn().mockResolvedValue(ok(createStoredEvent()));
    const handle = vi.fn().mockRejectedValue(new Error('boom'));

    app = await createTestApp({
      emailEventsRepo: {
        insert,
        findBySvixId,
        findThreadKeyByMessageReferences: vi.fn().mockResolvedValue(ok(null)),
        updateStoredEvent: vi.fn().mockResolvedValue(ok(createStoredEvent())),
      },
      sideEffect: { handle },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/resend',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'svix-1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(findBySvixId).not.toHaveBeenCalled();
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
