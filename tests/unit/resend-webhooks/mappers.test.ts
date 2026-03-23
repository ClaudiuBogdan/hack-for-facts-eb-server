import { describe, expect, it } from 'vitest';

import {
  extractTagValue,
  extractThreadKey,
  mapResendEmailWebhookEventToInsert,
  type ResendEmailWebhookEvent,
} from '@/modules/resend-webhooks/index.js';

const createEvent = (
  type: ResendEmailWebhookEvent['type'],
  overrides: {
    created_at?: string;
    data?: Partial<ResendEmailWebhookEvent['data']>;
  } = {}
): ResendEmailWebhookEvent => ({
  type,
  created_at: '2026-03-23T10:00:00.000Z',
  data: {
    email_id: 'email-1',
    from: 'noreply@transparenta.eu',
    to: ['user@example.com'],
    subject: 'Subject',
    created_at: '2026-03-23T09:59:00.000Z',
    ...(overrides.data ?? {}),
  },
  ...(overrides.created_at !== undefined ? { created_at: overrides.created_at } : {}),
});

describe('resend webhook mappers', () => {
  it.each([
    'email.sent',
    'email.delivered',
    'email.delivery_delayed',
    'email.complained',
    'email.bounced',
    'email.opened',
    'email.clicked',
    'email.failed',
    'email.scheduled',
    'email.suppressed',
    'email.received',
  ] as const)('maps %s into resend_wh_emails shape', (type) => {
    const event = createEvent(type, {
      data:
        type === 'email.bounced'
          ? ({
              bounce: {
                type: 'Permanent',
                subType: 'General',
                message: 'Mailbox unavailable',
                diagnosticCode: ['550'],
              },
            } satisfies Partial<ResendEmailWebhookEvent['data']>)
          : type === 'email.clicked'
            ? ({
                click: {
                  ipAddress: '127.0.0.1',
                  link: 'https://example.com',
                  timestamp: '2026-03-23T10:01:00.000Z',
                  userAgent: 'Mozilla/5.0',
                },
              } satisfies Partial<ResendEmailWebhookEvent['data']>)
            : ({} satisfies Partial<ResendEmailWebhookEvent['data']>),
    });

    const insert = mapResendEmailWebhookEventToInsert('svix-1', event);

    expect(insert.svix_id).toBe('svix-1');
    expect(insert.event_type).toBe(type);
    expect(insert.email_id).toBe('email-1');
    expect(insert.from_address).toBe('noreply@transparenta.eu');
    expect(insert.to_addresses).toEqual(['user@example.com']);
    expect(insert.subject).toBe('Subject');

    if (type === 'email.bounced') {
      expect(insert.bounce_type).toBe('Permanent');
      expect(insert.bounce_sub_type).toBe('General');
      expect(insert.bounce_message).toBe('Mailbox unavailable');
      expect(insert.bounce_diagnostic_code).toEqual(['550']);
    } else {
      expect(insert.bounce_type).toBeNull();
      expect(insert.bounce_sub_type).toBeNull();
      expect(insert.bounce_message).toBeNull();
      expect(insert.bounce_diagnostic_code).toBeNull();
    }

    if (type === 'email.clicked') {
      expect(insert.click_ip_address).toBe('127.0.0.1');
      expect(insert.click_link).toBe('https://example.com');
      expect(insert.click_timestamp).toEqual(new Date('2026-03-23T10:01:00.000Z'));
      expect(insert.click_user_agent).toBe('Mozilla/5.0');
    } else {
      expect(insert.click_ip_address).toBeNull();
      expect(insert.click_link).toBeNull();
      expect(insert.click_timestamp).toBeNull();
      expect(insert.click_user_agent).toBeNull();
    }
  });

  it('extracts tags from array form and derives thread_key', () => {
    const tags = [
      { name: 'thread_key', value: 'thread-1' },
      { name: 'delivery_id', value: 'delivery-1' },
    ];

    expect(extractTagValue(tags, 'delivery_id')).toBe('delivery-1');
    expect(extractThreadKey(tags)).toBe('thread-1');

    const insert = mapResendEmailWebhookEventToInsert(
      'svix-2',
      createEvent('email.sent', { data: { tags } })
    );

    expect(insert.thread_key).toBe('thread-1');
    expect(insert.tags).toBe(JSON.stringify(tags));
  });

  it('extracts tags from object form', () => {
    const tags = {
      thread_key: 'thread-2',
      delivery_id: 'delivery-2',
    };

    expect(extractTagValue(tags, 'delivery_id')).toBe('delivery-2');
    expect(extractThreadKey(tags)).toBe('thread-2');
  });

  it('maps absent optional fields to null instead of undefined', () => {
    const insert = mapResendEmailWebhookEventToInsert('svix-3', createEvent('email.failed'));

    expect(insert.broadcast_id).toBeNull();
    expect(insert.template_id).toBeNull();
    expect(insert.tags).toBeNull();
    expect(insert.bounce_type).toBeNull();
    expect(insert.click_ip_address).toBeNull();
    expect(insert.thread_key).toBeNull();
  });
});
