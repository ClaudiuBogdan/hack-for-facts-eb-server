import { describe, expect, it } from 'vitest';

import { parseResendEmailWebhookEvent } from '@/modules/resend-webhooks/index.js';

describe('parseResendEmailWebhookEvent', () => {
  it('accepts supported email webhook payloads', () => {
    const result = parseResendEmailWebhookEvent({
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

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.data.email_id).toBe('email-1');
    }
  });

  it('rejects non-email resend webhook payloads', () => {
    const result = parseResendEmailWebhookEvent({
      type: 'domain.created',
      created_at: '2026-04-03T14:38:06.333123Z',
      data: {},
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe('InvalidResendWebhookPayload');
      expect(result.error.message).toContain('/type');
    }
  });

  it('rejects malformed email payloads that miss required identifiers', () => {
    const result = parseResendEmailWebhookEvent({
      type: 'email.delivered',
      created_at: '2026-03-23T10:00:00.000Z',
      data: {
        from: 'noreply@transparenta.eu',
        to: ['user@example.com'],
        subject: 'Subject',
        created_at: '2026-03-23T09:59:00.000Z',
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('/data/email_id');
    }
  });
});
