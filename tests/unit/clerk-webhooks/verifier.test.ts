import pinoLogger from 'pino';
import { Webhook } from 'svix';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeClerkWebhookVerifier } from '@/modules/clerk-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });

afterEach(() => {
  vi.useRealTimers();
});

describe('makeClerkWebhookVerifier', () => {
  const signingSecret = 'whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtMTIzNDU2Nzg5MDEy';
  const otherSigningSecret = 'whsec_b3RoZXItc2VjcmV0LTMyLWJ5dGVzLTEyMzQ1Njc4OTA=';
  const payload = JSON.stringify({
    data: {
      id: 'user_123',
      email_addresses: [],
    },
    object: 'event',
    type: 'user.created',
    timestamp: 1_654_012_591_835,
    instance_id: 'ins_123',
  });

  const signHeaders = (secret: string, date: Date) => {
    const webhook = new Webhook(secret);
    const signature = webhook.sign('msg_1', date, payload);

    return {
      svixId: 'msg_1',
      svixTimestamp: String(Math.floor(date.getTime() / 1000)),
      svixSignature: signature,
    };
  };

  it('verifies a payload signed with the configured secret', async () => {
    const verifier = makeClerkWebhookVerifier({
      signingSecret,
      logger: testLogger,
    });

    const now = new Date('2026-03-28T16:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const result = await verifier.verify(payload, signHeaders(signingSecret, now));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toMatchObject({
        object: 'event',
        type: 'user.created',
        instance_id: 'ins_123',
      });
    }
  });

  it('rejects payloads signed with a different secret', async () => {
    const verifier = makeClerkWebhookVerifier({
      signingSecret,
      logger: testLogger,
    });

    const now = new Date('2026-03-28T16:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const result = await verifier.verify(payload, signHeaders(otherSigningSecret, now));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('INVALID_SIGNATURE');
    }
  });

  it('rejects tampered payloads even when headers are otherwise valid', async () => {
    const verifier = makeClerkWebhookVerifier({
      signingSecret,
      logger: testLogger,
    });

    const now = new Date('2026-03-28T16:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const headers = signHeaders(signingSecret, now);
    const tamperedPayload = JSON.stringify({
      data: {
        id: 'user_456',
        email_addresses: [],
      },
      object: 'event',
      type: 'user.created',
      timestamp: 1_654_012_591_835,
      instance_id: 'ins_123',
    });

    const result = await verifier.verify(tamperedPayload, headers);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('INVALID_SIGNATURE');
    }
  });

  it('classifies expired signatures as EXPIRED', async () => {
    const verifier = makeClerkWebhookVerifier({
      signingSecret,
      logger: testLogger,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T17:30:00.000Z'));

    const oldDate = new Date('2026-03-28T16:00:00.000Z');
    const result = await verifier.verify(payload, signHeaders(signingSecret, oldDate));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('EXPIRED');
    }
  });
});
