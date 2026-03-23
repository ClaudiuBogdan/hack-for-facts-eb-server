import pinoLogger from 'pino';
import { describe, expect, it } from 'vitest';

import { makeResendWebhookEmailEventsRepo } from '@/modules/resend-webhooks/index.js';

import { dockerAvailable } from './setup.js';
import { getTestClients } from '../infra/test-db.js';

describe('Resend webhook email events repository', () => {
  it('persists email webhook rows and preserves thread_key from tags', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeResendWebhookEmailEventsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    const result = await repo.insert({
      svixId: 'svix_repo_insert_1',
      event: {
        type: 'email.clicked',
        created_at: '2026-03-23T10:01:00.000Z',
        data: {
          email_id: 'email_repo_1',
          from: 'noreply@transparenta.eu',
          to: ['contact@institutie.ro'],
          subject: 'Salut',
          created_at: '2026-03-23T10:00:00.000Z',
          tags: [{ name: 'thread_key', value: 'repo-thread-1' }],
          click: {
            ipAddress: '127.0.0.1',
            link: 'https://example.com',
            timestamp: '2026-03-23T10:01:30.000Z',
            userAgent: 'Mozilla/5.0',
          },
        },
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.svixId).toBe('svix_repo_insert_1');
      expect(result.value.threadKey).toBe('repo-thread-1');
      expect(result.value.clickLink).toBe('https://example.com');
    }
  });

  it('enforces svix_id uniqueness for canonical idempotency', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeResendWebhookEmailEventsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    await repo.insert({
      svixId: 'svix_repo_dup_1',
      event: {
        type: 'email.sent',
        created_at: '2026-03-23T11:00:00.000Z',
        data: {
          email_id: 'email_repo_dup_1',
          from: 'noreply@transparenta.eu',
          to: ['contact@institutie.ro'],
          subject: 'Salut',
          created_at: '2026-03-23T10:59:00.000Z',
        },
      },
    });

    const duplicate = await repo.insert({
      svixId: 'svix_repo_dup_1',
      event: {
        type: 'email.delivered',
        created_at: '2026-03-23T11:01:00.000Z',
        data: {
          email_id: 'email_repo_dup_2',
          from: 'noreply@transparenta.eu',
          to: ['contact@institutie.ro'],
          subject: 'Salut din nou',
          created_at: '2026-03-23T11:00:00.000Z',
        },
      },
    });

    expect(duplicate.isErr()).toBe(true);
    if (duplicate.isErr()) {
      expect(duplicate.error.type).toBe('DuplicateResendWebhookEvent');
    }
  });

  it('loads the stored row by svix_id for duplicate replay handling', async () => {
    if (!dockerAvailable) {
      return;
    }

    const { userDb } = getTestClients();
    const repo = makeResendWebhookEmailEventsRepo({
      db: userDb,
      logger: pinoLogger({ level: 'silent' }),
    });

    await repo.insert({
      svixId: 'svix_repo_find_1',
      event: {
        type: 'email.delivered',
        created_at: '2026-03-23T12:01:00.000Z',
        data: {
          email_id: 'email_repo_find_1',
          from: 'noreply@transparenta.eu',
          to: ['contact@institutie.ro'],
          subject: 'Salut',
          created_at: '2026-03-23T12:00:00.000Z',
          tags: [{ name: 'thread_key', value: 'repo-find-thread-1' }],
        },
      },
    });

    const found = await repo.findBySvixId('svix_repo_find_1');

    expect(found.isOk()).toBe(true);
    if (found.isOk()) {
      expect(found.value?.svixId).toBe('svix_repo_find_1');
      expect(found.value?.threadKey).toBe('repo-find-thread-1');
      expect(found.value?.eventType).toBe('email.delivered');
    }
  });
});
