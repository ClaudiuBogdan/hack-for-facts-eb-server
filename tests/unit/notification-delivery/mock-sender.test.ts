import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deserialize } from '@/infra/cache/serialization.js';
import { makeMockEmailSender } from '@/modules/notification-delivery/index.js';

describe('makeMockEmailSender', () => {
  it('writes index.json and index.html artifacts for each sent email', async () => {
    const baseDir = await mkdtemp(path.join(tmpdir(), 'notification-mock-'));
    const sender = makeMockEmailSender({ baseDir });

    const result = await sender.send({
      to: 'user@example.com',
      userId: 'user-1',
      notificationType: 'transactional_welcome',
      referenceId: null,
      subject: 'Welcome',
      html: '<p>Hello</p>',
      text: 'Hello',
      idempotencyKey: 'outbox-1',
      unsubscribeUrl: 'https://transparenta.eu/settings/notifications',
      tags: [{ name: 'delivery_id', value: 'outbox-1' }],
      templateName: 'welcome',
      templateVersion: '1.0.0',
      metadata: {
        source: 'clerk_webhook.user_created',
      },
    });

    expect(result.isOk()).toBe(true);

    const html = await readFile(path.join(baseDir, 'outbox-1', 'index.html'), 'utf8');
    const parsedJson = deserialize(
      await readFile(path.join(baseDir, 'outbox-1', 'index.json'), 'utf8')
    );

    expect(parsedJson.ok).toBe(true);
    const json = parsedJson.ok ? (parsedJson.value as Record<string, unknown>) : {};

    expect(html).toContain('Hello');
    expect(json['outboxId']).toBe('outbox-1');
    expect(json['notificationType']).toBe('transactional_welcome');
    expect(json['referenceId']).toBeNull();
    expect(json['userId']).toBe('user-1');
    expect(json['templateName']).toBe('welcome');
    expect(json['metadata']).toEqual({
      source: 'clerk_webhook.user_created',
    });
  });
});
