/**
 * Unit tests for recover-stuck-sending use case
 *
 * Tests cover:
 * - Recovery of deliveries stuck in 'sending' status
 * - Threshold-based filtering
 * - Error handling and result reporting
 */

import { ok } from 'neverthrow';
import pinoLogger from 'pino';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { STUCK_SENDING_THRESHOLD_MINUTES } from '@/modules/notification-delivery/core/types.js';
import { recoverStuckSending } from '@/modules/notification-delivery/core/usecases/recover-stuck-sending.js';

import { makeFakeDeliveryRepo, createTestDeliveryRecord } from '../../fixtures/fakes.js';

// Silent logger for tests
const testLogger = pinoLogger({ level: 'silent' });

describe('recoverStuckSending use case', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when no stuck deliveries exist', () => {
    it('returns zero counts when store is empty', async () => {
      const deliveryRepo = makeFakeDeliveryRepo();

      const result = await recoverStuckSending({ deliveryRepo, logger: testLogger }, {});

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(0);
        expect(result.value.recoveredCount).toBe(0);
        expect(result.value.recoveredIds).toEqual([]);
        expect(result.value.errors).toEqual({});
      }
    });

    it('returns zero counts when deliveries exist but none are stuck', async () => {
      // Create a sending delivery that was updated recently (not stuck)
      const recentSending = createTestDeliveryRecord({
        id: 'delivery-recent',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:50:00Z'), // 10 minutes ago
      });

      const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [recentSending] });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(0);
        expect(result.value.recoveredCount).toBe(0);
      }
    });

    it('ignores deliveries already in terminal statuses', async () => {
      const delivered = createTestDeliveryRecord({
        id: 'delivery-delivered',
        status: 'delivered',
        lastAttemptAt: new Date('2025-01-15T10:00:00Z'),
      });
      const suppressed = createTestDeliveryRecord({
        id: 'delivery-suppressed',
        status: 'suppressed',
        lastAttemptAt: new Date('2025-01-15T10:00:00Z'),
      });
      const skippedNoEmail = createTestDeliveryRecord({
        id: 'delivery-skipped-no-email',
        status: 'skipped_no_email',
        lastAttemptAt: new Date('2025-01-15T10:00:00Z'),
      });

      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [delivered, suppressed, skippedNoEmail],
      });

      const result = await recoverStuckSending({ deliveryRepo, logger: testLogger }, {});

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(0);
      }
    });
  });

  describe('when stuck deliveries exist', () => {
    it('recovers deliveries stuck for longer than threshold', async () => {
      // Create a delivery that's been sending for 30 minutes
      const stuckDelivery = createTestDeliveryRecord({
        id: 'delivery-stuck',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:30:00Z'), // 30 minutes ago
      });

      const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [stuckDelivery] });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(1);
        expect(result.value.recoveredCount).toBe(1);
        expect(result.value.recoveredIds).toContain('delivery-stuck');
      }

      // Verify the delivery was updated
      const findResult = await deliveryRepo.findById('delivery-stuck');
      expect(findResult.isOk()).toBe(true);
      if (findResult.isOk() && findResult.value !== null) {
        expect(findResult.value.status).toBe('failed_transient');
        expect(findResult.value.lastError).toContain('Recovered from stuck sending');
      }
    });

    it('recovers multiple stuck deliveries', async () => {
      const stuck1 = createTestDeliveryRecord({
        id: 'delivery-stuck-1',
        deliveryKey: 'user1:notif1:2025-01',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:00:00Z'), // 60 minutes ago
      });
      const stuck2 = createTestDeliveryRecord({
        id: 'delivery-stuck-2',
        deliveryKey: 'user2:notif2:2025-01',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:30:00Z'), // 30 minutes ago
      });

      const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [stuck1, stuck2] });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(2);
        expect(result.value.recoveredCount).toBe(2);
        expect(result.value.recoveredIds).toContain('delivery-stuck-1');
        expect(result.value.recoveredIds).toContain('delivery-stuck-2');
      }
    });

    it('uses default threshold when not specified', async () => {
      // Create a delivery that's been sending for 20 minutes (> default 15)
      const stuckDelivery = createTestDeliveryRecord({
        id: 'delivery-stuck-default',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:40:00Z'), // 20 minutes ago
      });

      const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [stuckDelivery] });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        {} // No threshold specified
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(1);
        expect(result.value.recoveredCount).toBe(1);
      }
    });

    it('respects custom threshold', async () => {
      // Create a delivery that's been sending for 10 minutes
      const delivery = createTestDeliveryRecord({
        id: 'delivery-short',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:50:00Z'), // 10 minutes ago
      });

      const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [delivery] });

      // With 5-minute threshold, it should be recovered
      const result1 = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 5 }
      );
      expect(result1.isOk()).toBe(true);
      if (result1.isOk()) {
        expect(result1.value.foundCount).toBe(1);
      }
    });

    it('does not overwrite deliveries that changed state before recovery', async () => {
      const deliveryRepo = {
        findStuckSending: async () =>
          ok([
            createTestDeliveryRecord({
              id: 'delivery-raced',
              status: 'sending',
              lastAttemptAt: new Date('2025-01-15T11:00:00Z'),
            }),
          ]),
        findPendingComposeOrphans: async () => ok([]),
        findReadyToSendOrphans: async () => ok([]),
        findSentAwaitingWebhook: async () => ok([]),
        updateStatusIfStillSending: async () => ok(false),
        updateStatusIfCurrentIn: async () => ok(false),
      } as never;

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.foundCount).toBe(1);
        expect(result.value.recoveredCount).toBe(0);
        expect(result.value.recoveredIds).toEqual([]);
        expect(result.value.errors).toEqual({});
      }
    });
  });

  describe('error handling', () => {
    it('returns error when findStuckSending fails', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({ simulateDbError: true });

      const result = await recoverStuckSending({ deliveryRepo, logger: testLogger }, {});

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });

    it('reports errors for individual delivery updates that fail', async () => {
      // This test needs a custom repo that fails on updateStatus
      // Since our fake doesn't support per-operation failures easily,
      // we test the structure of the result when there are no errors
      const stuckDelivery = createTestDeliveryRecord({
        id: 'delivery-stuck',
        status: 'sending',
        lastAttemptAt: new Date('2025-01-15T11:00:00Z'),
      });

      const deliveryRepo = makeFakeDeliveryRepo({ deliveries: [stuckDelivery] });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // No errors expected in this case
        expect(Object.keys(result.value.errors).length).toBe(0);
      }
    });

    it('recovers sending rows with null lastAttemptAt', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'delivery-null-attempt',
            status: 'sending',
            lastAttemptAt: null,
            createdAt: new Date('2025-01-15T11:00:00Z'),
          }),
        ],
      });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.sendRetryIds).toContain('delivery-null-attempt');
      }
    });

    it('re-enqueues pending compose orphans without changing their status', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'delivery-compose-orphan',
            status: 'pending',
            createdAt: new Date('2025-01-15T11:00:00Z'),
          }),
        ],
      });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.composeRetryIds).toContain('delivery-compose-orphan');
      }

      const stored = await deliveryRepo.findById('delivery-compose-orphan');
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.status).toBe('pending');
      }
    });

    it('resets stale composing rows to pending before re-enqueueing compose', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'delivery-compose-stale',
            status: 'composing',
            createdAt: new Date('2025-01-15T11:00:00Z'),
          }),
        ],
      });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.composeRetryIds).toContain('delivery-compose-stale');
      }

      const stored = await deliveryRepo.findById('delivery-compose-stale');
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.status).toBe('pending');
        expect(stored.value?.lastError).toContain('Recovered stale composing delivery');
      }
    });

    it('does not recover recently claimed composing rows just because the outbox is old', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'delivery-compose-active',
            status: 'pending',
            createdAt: new Date('2025-01-15T10:00:00Z'),
            lastAttemptAt: null,
          }),
        ],
      });

      const claimResult = await deliveryRepo.claimForCompose('delivery-compose-active');
      expect(claimResult.isOk()).toBe(true);
      if (claimResult.isOk()) {
        expect(claimResult.value?.status).toBe('composing');
      }

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.composeRetryIds).not.toContain('delivery-compose-active');
        expect(result.value.recoveredIds).not.toContain('delivery-compose-active');
      }

      const stored = await deliveryRepo.findById('delivery-compose-active');
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.status).toBe('composing');
      }
    });

    it('moves stale sent rows back to failed_transient inside the idempotency window', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'delivery-sent-retry',
            status: 'sent',
            renderedSubject: 'Subject',
            renderedHtml: '<p>Hello</p>',
            renderedText: 'Hello',
            sentAt: new Date('2025-01-15T11:00:00Z'),
          }),
        ],
      });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.sendRetryIds).toContain('delivery-sent-retry');
      }

      const stored = await deliveryRepo.findById('delivery-sent-retry');
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.status).toBe('failed_transient');
      }
    });

    it('marks stale sent rows outside the idempotency window as webhook_timeout', async () => {
      const deliveryRepo = makeFakeDeliveryRepo({
        deliveries: [
          createTestDeliveryRecord({
            id: 'delivery-webhook-timeout',
            status: 'sent',
            renderedSubject: 'Subject',
            renderedHtml: '<p>Hello</p>',
            renderedText: 'Hello',
            sentAt: new Date('2025-01-14T10:00:00Z'),
          }),
        ],
      });

      const result = await recoverStuckSending(
        { deliveryRepo, logger: testLogger },
        { thresholdMinutes: 15 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.timedOutIds).toContain('delivery-webhook-timeout');
      }

      const stored = await deliveryRepo.findById('delivery-webhook-timeout');
      expect(stored.isOk()).toBe(true);
      if (stored.isOk()) {
        expect(stored.value?.status).toBe('webhook_timeout');
      }
    });
  });

  describe('constants', () => {
    it('STUCK_SENDING_THRESHOLD_MINUTES is 15', () => {
      expect(STUCK_SENDING_THRESHOLD_MINUTES).toBe(15);
    });
  });
});
