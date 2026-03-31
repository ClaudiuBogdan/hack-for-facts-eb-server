import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { combineResendWebhookSideEffects } from '@/modules/resend-webhooks/shell/combine-side-effects.js';

import type { ResendWebhookSideEffectInput } from '@/modules/resend-webhooks/index.js';

const testLogger = pinoLogger({ level: 'silent' });

const webhookInput: ResendWebhookSideEffectInput = {
  event: {
    type: 'email.delivered',
    created_at: '2026-03-23T10:00:00.000Z',
    data: {
      email_id: 'email-1',
      from: 'noreply@transparenta.eu',
      to: ['user@example.com'],
      subject: 'Subject',
      created_at: '2026-03-23T09:59:00.000Z',
      tags: [],
    },
  },
  storedEvent: {
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
    tags: [],
    bounceType: null,
    bounceSubType: null,
    bounceMessage: null,
    bounceDiagnosticCode: null,
    clickIpAddress: null,
    clickLink: null,
    clickTimestamp: null,
    clickUserAgent: null,
    threadKey: null,
    metadata: {},
  },
};

describe('combineResendWebhookSideEffects', () => {
  it('attempts all side effects and fails overall when any side effect throws', async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => {
      throw new Error('boom');
    });
    const third = vi.fn(async () => undefined);

    const combined = combineResendWebhookSideEffects(
      [{ handle: first }, { handle: second }, { handle: third }],
      testLogger
    );

    await expect(combined?.handle(webhookInput)).rejects.toThrow('boom');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).toHaveBeenCalledTimes(1);
  });
});
