import { describe, expect, it } from 'vitest';

import { PUBLIC_DEBATE_REQUEST_TYPE } from '@/modules/institution-correspondence/index.js';

import { createPublicDebateNotificationHarness } from '../fixtures/public-debate-notification-harness.js';
import {
  createCorrespondenceEntry,
  createThreadAggregateRecord,
  createThreadRecord,
} from '../unit/institution-correspondence/fake-repo.js';

describe('public debate request notification snapshots', () => {
  it('publishes the current thread state for late subscribers and reuses the same outbox on repeated requests', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-1',
          entityCui: '12345678',
          phase: 'awaiting_reply',
          lastEmailAt: new Date('2026-04-03T16:43:04.930Z'),
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Oras Test',
      },
    });

    const firstResult = await harness.requestPlatformSend({
      ownerUserId: 'user-1',
      entityCui: '12345678',
      institutionEmail: 'contact@primarie.ro',
    });
    const secondResult = await harness.requestPlatformSend({
      ownerUserId: 'user-1',
      entityCui: '12345678',
      institutionEmail: 'contact@primarie.ro',
    });

    expect(firstResult.isOk()).toBe(true);
    expect(secondResult.isOk()).toBe(true);
    if (firstResult.isOk()) {
      expect(firstResult.value.created).toBe(false);
      expect(firstResult.value.thread.id).toBe('thread-1');
    }
    if (secondResult.isOk()) {
      expect(secondResult.value.created).toBe(false);
      expect(secondResult.value.thread.id).toBe('thread-1');
    }
    expect(harness.send).not.toHaveBeenCalled();

    expect(harness.snapshotResults).toHaveLength(2);
    const firstSnapshot = harness.snapshotResults[0];
    const secondSnapshot = harness.snapshotResults[1];

    expect(firstSnapshot).toBeDefined();
    expect(secondSnapshot).toBeDefined();
    if (firstSnapshot === undefined || secondSnapshot === undefined) {
      throw new Error('Expected snapshot results to be present');
    }
    expect(firstSnapshot.isOk()).toBe(true);
    expect(secondSnapshot.isOk()).toBe(true);
    if (firstSnapshot.isOk()) {
      expect(firstSnapshot.value.status).toBe('published');
      expect(firstSnapshot.value.eventType).toBe('thread_started');
      expect(firstSnapshot.value.publishResult?.createdOutboxIds).toHaveLength(1);
      expect(firstSnapshot.value.publishResult?.reusedOutboxIds).toEqual([]);

      const outbox = await harness.findOutboxById(
        firstSnapshot.value.publishResult?.createdOutboxIds[0] ?? ''
      );
      expect(outbox.isOk()).toBe(true);
      if (outbox.isOk()) {
        expect(outbox.value?.notificationType).toBe('funky:outbox:entity_update');
        expect(outbox.value?.metadata).toEqual(
          expect.objectContaining({
            eventType: 'thread_started',
            threadId: 'thread-1',
            entityName: 'Oras Test',
          })
        );
      }
    }
    if (secondSnapshot.isOk()) {
      expect(secondSnapshot.value.status).toBe('published');
      expect(secondSnapshot.value.publishResult?.createdOutboxIds).toEqual([]);
      expect(secondSnapshot.value.publishResult?.reusedOutboxIds).toHaveLength(1);
    }
  });

  it('maps reviewed platform threads to reply_reviewed snapshots', async () => {
    const reply = createCorrespondenceEntry({
      id: 'reply-1',
      direction: 'inbound',
      occurredAt: '2026-04-03T08:00:00.000Z',
      textBody: 'Raspunsul a fost analizat.',
    });
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-reviewed',
          entityCui: '12345678',
          phase: 'resolved_positive',
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
            correspondence: [reply],
            latestReview: {
              basedOnEntryId: 'reply-1',
              resolutionCode: 'debate_announced',
              notes: 'Dezbaterea a fost programata.',
              reviewedAt: '2026-04-04T10:00:00.000Z',
            },
          }),
        }),
      ],
      entityNames: {
        '12345678': 'Oras Test',
      },
    });

    const result = await harness.requestPlatformSend({
      ownerUserId: 'user-1',
      entityCui: '12345678',
      institutionEmail: 'contact@primarie.ro',
    });

    expect(result.isOk()).toBe(true);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.snapshotResults).toHaveLength(1);

    const snapshot = harness.snapshotResults[0];
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error('Expected snapshot result to be present');
    }
    expect(snapshot.isOk()).toBe(true);
    if (snapshot.isOk()) {
      expect(snapshot.value.status).toBe('published');
      expect(snapshot.value.eventType).toBe('reply_reviewed');
      expect(snapshot.value.publishResult?.createdOutboxIds).toHaveLength(1);

      const outbox = await harness.findOutboxById(
        snapshot.value.publishResult?.createdOutboxIds[0] ?? ''
      );
      expect(outbox.isOk()).toBe(true);
      if (outbox.isOk()) {
        expect(outbox.value?.metadata).toEqual(
          expect.objectContaining({
            eventType: 'reply_reviewed',
            basedOnEntryId: 'reply-1',
            resolutionCode: 'debate_announced',
            reviewNotes: 'Dezbaterea a fost programata.',
          })
        );
      }
    }
  });

  it('skips snapshot publishing when the latest platform thread is still sending', async () => {
    const harness = createPublicDebateNotificationHarness({
      threads: [
        createThreadRecord({
          id: 'thread-sending',
          entityCui: '12345678',
          phase: 'sending',
          record: createThreadAggregateRecord({
            campaign: PUBLIC_DEBATE_REQUEST_TYPE,
            campaignKey: 'funky',
            submissionPath: 'platform_send',
            subject: 'Cerere dezbatere buget local - Oras Test',
            institutionEmail: 'contact@primarie.ro',
          }),
        }),
      ],
    });

    const result = await harness.requestPlatformSend({
      ownerUserId: 'user-1',
      entityCui: '12345678',
      institutionEmail: 'contact@primarie.ro',
    });

    expect(result.isOk()).toBe(true);
    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.snapshotResults).toHaveLength(1);

    const snapshot = harness.snapshotResults[0];
    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error('Expected snapshot result to be present');
    }
    expect(snapshot.isOk()).toBe(true);
    if (snapshot.isOk()) {
      expect(snapshot.value.status).toBe('skipped_phase');
      expect(snapshot.value.eventType).toBeUndefined();
      expect(snapshot.value.publishResult).toBeUndefined();
    }
    expect(harness.composeJobScheduler.enqueue).not.toHaveBeenCalled();
  });
});
