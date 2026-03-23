import pinoLogger from 'pino';
import { Webhook } from 'svix';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { makeWebhookVerifier, redactEmailAddress } from '@/infra/email/client.js';

const testLogger = pinoLogger({ level: 'silent' });

afterEach(() => {
  vi.useRealTimers();
});

describe('redactEmailAddress', () => {
  it('redacts short local parts instead of logging the full address', () => {
    expect(redactEmailAddress('a@example.com')).toBe('a***@example.com');
    expect(redactEmailAddress('ab@example.com')).toBe('ab***@example.com');
    expect(redactEmailAddress('abc@example.com')).toBe('abc***@example.com');
  });

  it('keeps only the first three characters for longer local parts', () => {
    expect(redactEmailAddress('abcdef@example.com')).toBe('abc***@example.com');
  });

  it('falls back to a placeholder for malformed input', () => {
    expect(redactEmailAddress('not-an-email')).toBe('***');
  });
});

describe('makeWebhookVerifier', () => {
  const webhookSecret = 'whsec_dGVzdC1zZWNyZXQtMzItYnl0ZXMtMTIzNDU2Nzg5MDEy';
  const otherWebhookSecret = 'whsec_b3RoZXItc2VjcmV0LTMyLWJ5dGVzLTEyMzQ1Njc4OTA=';
  const payload = JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-03-23T10:00:00.000Z',
    data: {
      email_id: 'email-1',
      from: 'noreply@transparenta.eu',
      to: ['user@example.com'],
      subject: 'Subject',
      created_at: '2026-03-23T09:59:00.000Z',
    },
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

  it('verifies a payload signed with the configured webhook secret', async () => {
    const verifier = makeWebhookVerifier({
      webhookSecret,
      logger: testLogger,
    });

    const now = new Date('2026-03-23T10:05:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const result = await verifier.verify(payload, signHeaders(webhookSecret, now));

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.type).toBe('email.delivered');
      expect(result.value.data.email_id).toBe('email-1');
    }
  });

  it('rejects payloads signed with a different secret', async () => {
    const verifier = makeWebhookVerifier({
      webhookSecret,
      logger: testLogger,
    });

    const now = new Date('2026-03-23T10:05:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const result = await verifier.verify(payload, signHeaders(otherWebhookSecret, now));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('INVALID_SIGNATURE');
    }
  });

  it('rejects tampered payloads even when headers are otherwise valid', async () => {
    const verifier = makeWebhookVerifier({
      webhookSecret,
      logger: testLogger,
    });

    const now = new Date('2026-03-23T10:05:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const headers = signHeaders(webhookSecret, now);
    const tamperedPayload = JSON.stringify({
      type: 'email.delivered',
      created_at: '2026-03-23T10:00:00.000Z',
      data: {
        email_id: 'email-2',
        from: 'noreply@transparenta.eu',
        to: ['user@example.com'],
        subject: 'Tampered',
        created_at: '2026-03-23T09:59:00.000Z',
      },
    });

    const result = await verifier.verify(tamperedPayload, headers);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('INVALID_SIGNATURE');
    }
  });

  it('classifies expired signatures as EXPIRED', async () => {
    const verifier = makeWebhookVerifier({
      webhookSecret,
      logger: testLogger,
    });

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-23T11:30:00.000Z'));

    const oldDate = new Date('2026-03-23T10:00:00.000Z');
    const result = await verifier.verify(payload, signHeaders(webhookSecret, oldDate));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('EXPIRED');
    }
  });
});
