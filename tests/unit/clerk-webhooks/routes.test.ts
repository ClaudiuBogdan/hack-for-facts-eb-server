import fastifyLib, { type FastifyInstance } from 'fastify';
import { err, ok } from 'neverthrow';
import pinoLogger from 'pino';
import { Webhook } from 'svix';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  makeClerkWebhookRoutes,
  makeClerkWebhookVerifier,
  type ClerkWebhookEvent,
  type ClerkWebhookRoutesDeps,
} from '@/modules/clerk-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });
const signingSecret = 'whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtMTIzNDU2Nzg5MDEy';

const createEvent = (): ClerkWebhookEvent => ({
  data: {
    id: 'user_123',
    email_addresses: [],
  },
  object: 'event',
  type: 'user.created',
  timestamp: 1_654_012_591_835,
  instance_id: 'ins_123',
});

const signHeaders = (payload: string, secret: string, date: Date) => {
  const webhook = new Webhook(secret);
  const signature = webhook.sign('msg_1', date, payload);

  return {
    'svix-id': 'msg_1',
    'svix-timestamp': String(Math.floor(date.getTime() / 1000)),
    'svix-signature': signature,
  };
};

const createTestApp = async (
  overrides: Partial<ClerkWebhookRoutesDeps> = {}
): Promise<FastifyInstance> => {
  const app = fastifyLib({ logger: false });
  await app.register(
    makeClerkWebhookRoutes({
      webhookVerifier: {
        verify: async () => ok(createEvent()),
      },
      logger: testLogger,
      ...overrides,
    })
  );

  await app.ready();
  return app;
};

describe('makeClerkWebhookRoutes', () => {
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
      url: '/api/v1/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing svix headers' });
  });

  it('returns 400 for malformed JSON bodies', async () => {
    const verify = vi.fn().mockResolvedValue(ok(createEvent()));
    app = await createTestApp({
      webhookVerifier: { verify },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: '{"broken":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid JSON in webhook body' });
    expect(verify).not.toHaveBeenCalled();
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
      url: '/api/v1/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Invalid signature' });
  });

  it('returns 400 when the verified payload fails Clerk schema validation', async () => {
    app = await createTestApp({
      webhookVerifier: {
        verify: async () =>
          ok({
            data: 'not-an-object',
            object: 'event',
            type: 'user.created',
            timestamp: 1_654_012_591_835,
          }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Invalid webhook payload' });
  });

  it('returns 200 for a verified Clerk event', async () => {
    app = await createTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_1',
        'svix-timestamp': '123',
        'svix-signature': 'sig',
      },
      payload: createEvent(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'received' });
  });

  it('verifies the raw body and acknowledges a signed request end-to-end', async () => {
    const realApp = fastifyLib({ logger: false });
    await realApp.register(
      makeClerkWebhookRoutes({
        webhookVerifier: makeClerkWebhookVerifier({
          signingSecret,
          logger: testLogger,
        }),
        logger: testLogger,
      })
    );
    await realApp.ready();
    app = realApp;

    const payload = JSON.stringify(createEvent());
    const now = new Date();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/clerk',
      headers: {
        'content-type': 'application/json',
        ...signHeaders(payload, signingSecret, now),
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'received' });
  });
});
