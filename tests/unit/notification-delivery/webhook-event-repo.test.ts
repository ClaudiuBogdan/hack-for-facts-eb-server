/**
 * Unit tests for webhook event repository (fake implementation)
 *
 * Tests cover:
 * - Inserting webhook events with svix-id deduplication
 * - Marking events as processed
 * - Finding unprocessed events
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { makeFakeWebhookEventRepo, createTestStoredWebhookEvent } from '../../fixtures/fakes.js';

describe('WebhookEventRepository (fake)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('insert', () => {
    it('creates a new webhook event', async () => {
      const repo = makeFakeWebhookEventRepo();

      const result = await repo.insert({
        svixId: 'svix-unique-123',
        eventType: 'email.delivered',
        resendEmailId: 'resend-email-456',
        deliveryId: 'delivery-789',
        payload: { type: 'email.delivered', data: { email_id: 'resend-email-456' } },
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.svixId).toBe('svix-unique-123');
        expect(result.value.eventType).toBe('email.delivered');
        expect(result.value.resendEmailId).toBe('resend-email-456');
        expect(result.value.deliveryId).toBe('delivery-789');
        expect(result.value.processedAt).toBeNull();
      }
    });

    it('returns error for duplicate svix_id', async () => {
      const existing = createTestStoredWebhookEvent({
        svixId: 'svix-duplicate',
      });
      const repo = makeFakeWebhookEventRepo({ events: [existing] });

      const result = await repo.insert({
        svixId: 'svix-duplicate',
        eventType: 'email.bounced',
        resendEmailId: 'resend-123',
        payload: {},
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DuplicateWebhookEvent');
      }
    });

    it('allows inserting event without deliveryId', async () => {
      const repo = makeFakeWebhookEventRepo();

      const result = await repo.insert({
        svixId: 'svix-no-delivery',
        eventType: 'email.sent',
        resendEmailId: 'resend-email',
        payload: {},
        // No deliveryId - tag might be missing
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.deliveryId).toBeNull();
      }
    });

    it('stores payload correctly', async () => {
      const repo = makeFakeWebhookEventRepo();
      const payload = {
        type: 'email.bounced',
        data: {
          email_id: 'resend-123',
          bounce: { type: 'Permanent', subType: 'General' },
          tags: [{ name: 'delivery_id', value: 'delivery-uuid' }],
        },
      };

      const result = await repo.insert({
        svixId: 'svix-with-payload',
        eventType: 'email.bounced',
        resendEmailId: 'resend-123',
        deliveryId: 'delivery-uuid',
        payload,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.payload).toEqual(payload);
      }
    });
  });

  describe('markProcessed', () => {
    it('marks event as processed with timestamp', async () => {
      const event = createTestStoredWebhookEvent({
        svixId: 'svix-to-process',
        processedAt: null,
      });
      const repo = makeFakeWebhookEventRepo({ events: [event] });

      const result = await repo.markProcessed('svix-to-process');

      expect(result.isOk()).toBe(true);

      // Verify by inserting the same svix-id (should fail as duplicate)
      // This indirectly verifies the event still exists
      const insertResult = await repo.insert({
        svixId: 'svix-to-process',
        eventType: 'email.sent',
        resendEmailId: 'resend',
        payload: {},
      });
      expect(insertResult.isErr()).toBe(true);
    });

    it('silently succeeds for nonexistent event', async () => {
      const repo = makeFakeWebhookEventRepo();

      const result = await repo.markProcessed('nonexistent-svix');

      expect(result.isOk()).toBe(true);
    });

    it('can mark already processed event again', async () => {
      const event = createTestStoredWebhookEvent({
        svixId: 'svix-already-processed',
        processedAt: new Date('2025-01-15T11:00:00Z'),
      });
      const repo = makeFakeWebhookEventRepo({ events: [event] });

      const result = await repo.markProcessed('svix-already-processed');

      expect(result.isOk()).toBe(true);
    });
  });

  describe('findUnprocessed', () => {
    it('finds unprocessed events older than threshold', async () => {
      const unprocessed = createTestStoredWebhookEvent({
        svixId: 'svix-unprocessed',
        processedAt: null,
        createdAt: new Date('2025-01-15T11:00:00Z'), // 60 minutes ago
      });
      const repo = makeFakeWebhookEventRepo({ events: [unprocessed] });

      const result = await repo.findUnprocessed(30); // 30 minute threshold

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.svixId).toBe('svix-unprocessed');
      }
    });

    it('excludes recent unprocessed events', async () => {
      const recent = createTestStoredWebhookEvent({
        svixId: 'svix-recent',
        processedAt: null,
        createdAt: new Date('2025-01-15T11:50:00Z'), // 10 minutes ago
      });
      const repo = makeFakeWebhookEventRepo({ events: [recent] });

      const result = await repo.findUnprocessed(30); // 30 minute threshold

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(0);
      }
    });

    it('excludes processed events', async () => {
      const processed = createTestStoredWebhookEvent({
        svixId: 'svix-processed',
        processedAt: new Date('2025-01-15T11:30:00Z'),
        createdAt: new Date('2025-01-15T10:00:00Z'), // 2 hours ago
      });
      const repo = makeFakeWebhookEventRepo({ events: [processed] });

      const result = await repo.findUnprocessed(30);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(0);
      }
    });

    it('returns multiple unprocessed events', async () => {
      const event1 = createTestStoredWebhookEvent({
        svixId: 'svix-1',
        processedAt: null,
        createdAt: new Date('2025-01-15T10:00:00Z'),
      });
      const event2 = createTestStoredWebhookEvent({
        svixId: 'svix-2',
        processedAt: null,
        createdAt: new Date('2025-01-15T11:00:00Z'),
      });
      const repo = makeFakeWebhookEventRepo({ events: [event1, event2] });

      const result = await repo.findUnprocessed(30);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.length).toBe(2);
      }
    });

    it('returns empty array when no events exist', async () => {
      const repo = makeFakeWebhookEventRepo();

      const result = await repo.findUnprocessed(30);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe('database error simulation', () => {
    it('returns database error when simulateDbError is true', async () => {
      const repo = makeFakeWebhookEventRepo({ simulateDbError: true });

      const insertResult = await repo.insert({
        svixId: 'svix-test',
        eventType: 'email.sent',
        resendEmailId: 'resend-123',
        payload: {},
      });

      expect(insertResult.isErr()).toBe(true);
      if (insertResult.isErr()) {
        expect(insertResult.error.type).toBe('DatabaseError');
      }

      const markResult = await repo.markProcessed('svix-test');
      expect(markResult.isErr()).toBe(true);

      const findResult = await repo.findUnprocessed(30);
      expect(findResult.isErr()).toBe(true);
    });
  });
});
