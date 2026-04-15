import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { processSendJob } from './send-worker.js';
import {
  createTestDeliveryRecord,
  createTestNotification,
  makeFakeDeliveryRepo,
  makeFakeExtendedNotificationsRepo,
} from '../../../../../../tests/fixtures/fakes.js';

describe('processSendJob weekly progress digest', () => {
  it('skips when funky:notification:global is no longer eligible at send time', async () => {
    const deliveryRepo = makeFakeDeliveryRepo({
      deliveries: [
        createTestDeliveryRecord({
          id: 'outbox-weekly-optout',
          userId: 'user-1',
          notificationType: 'funky:outbox:weekly_progress_digest',
          referenceId: 'notif-global-1',
          scopeKey: 'digest:weekly_progress:funky:2026-W16',
          deliveryKey: 'digest:weekly_progress:funky:user-1:2026-W16',
          renderedSubject: 'Digest',
          renderedHtml: '<p>Hello</p>',
          renderedText: 'Hello',
          metadata: {
            digestType: 'weekly_progress_digest',
            campaignKey: 'funky',
            userId: 'user-1',
            weekKey: '2026-W16',
            periodLabel: '8-14 aprilie',
            watermarkAt: '2026-04-14T21:00:00.000Z',
            summary: {
              totalItemCount: 1,
              visibleItemCount: 1,
              hiddenItemCount: 0,
              actionNowCount: 1,
              approvedCount: 0,
              rejectedCount: 0,
              pendingCount: 1,
              draftCount: 0,
              failedCount: 0,
            },
            items: [
              {
                itemKey: 'item-1',
                interactionId: 'funky:interaction:public_debate_request',
                interactionLabel: 'Cererea de dezbatere publica',
                entityName: 'Municipiul Exemplu',
                statusLabel: 'Este salvat, dar netrimis',
                statusTone: 'warning',
                title: 'Cererea ta asteapta sa fie trimisa',
                description: 'Revino in cont si trimite cererea.',
                updatedAt: '2026-04-14T20:30:00.000Z',
                actionLabel: 'Continua cererea',
                actionUrl: 'https://transparenta.eu/primarie/12345678/provocari/cerere',
              },
            ],
            primaryCta: {
              label: 'Continua cererea',
              url: 'https://transparenta.eu/primarie/12345678/provocari/cerere',
            },
            secondaryCtas: [],
            allUpdatesUrl: 'https://transparenta.eu/provocare/notificari',
          },
        }),
      ],
    });

    const send = vi.fn(async () => ok({ emailId: 'mock-1' }));
    const getEmail = vi.fn(async () => ok('user@example.com'));
    const logger = pinoLogger({ level: 'silent' });

    const result = await processSendJob(
      {
        deliveryRepo,
        notificationsRepo: makeFakeExtendedNotificationsRepo({
          notifications: [
            createTestNotification({
              id: 'notif-global-1',
              userId: 'user-1',
              entityCui: null,
              notificationType: 'funky:notification:global',
              isActive: false,
            }),
          ],
        }),
        userEmailFetcher: {
          getEmail,
          getEmailsByUserIds: vi.fn(async () => ok(new Map())),
        },
        emailSender: { send },
        tokenSigner: {
          sign: vi.fn(() => 'token'),
        } as never,
        apiBaseUrl: 'https://api.transparenta.eu',
        environment: 'test',
        log: logger,
      },
      { outboxId: 'outbox-weekly-optout' }
    );

    expect(result).toEqual({
      outboxId: 'outbox-weekly-optout',
      status: 'skipped_unsubscribed',
    });
    expect(send).not.toHaveBeenCalled();
    expect(getEmail).not.toHaveBeenCalled();

    const stored = await deliveryRepo.findById('outbox-weekly-optout');
    expect(stored.isOk()).toBe(true);
    if (stored.isOk()) {
      expect(stored.value?.status).toBe('skipped_unsubscribed');
    }
  });
});
