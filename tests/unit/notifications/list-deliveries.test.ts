/**
 * Unit tests for list-deliveries use case
 *
 * Tests cover:
 * - Basic listing with pagination
 * - Pagination parameter clamping
 * - Empty results handling
 * - Database error propagation
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DELIVERIES_LIMIT,
  MAX_DELIVERIES_LIMIT,
} from '@/modules/notifications/core/types.js';
import { listDeliveries } from '@/modules/notifications/core/usecases/list-deliveries.js';

import { makeFakeDeliveriesRepo, createTestDelivery } from '../../fixtures/fakes.js';

describe('listDeliveries use case', () => {
  describe('basic listing', () => {
    it('returns empty array when user has no deliveries', async () => {
      const repo = makeFakeDeliveriesRepo();

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns deliveries for user', async () => {
      const deliveries = [
        createTestDelivery({
          id: 'delivery-1',
          userId: 'user-1',
          periodKey: '2024-01',
        }),
        createTestDelivery({
          id: 'delivery-2',
          userId: 'user-1',
          periodKey: '2024-02',
        }),
        createTestDelivery({
          id: 'delivery-3',
          userId: 'user-2', // Different user
        }),
      ];
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
        expect(result.value.map((d) => d.id)).toContain('delivery-1');
        expect(result.value.map((d) => d.id)).toContain('delivery-2');
      }
    });

    it('returns deliveries ordered by sentAt descending', async () => {
      const now = new Date();
      const deliveries = [
        createTestDelivery({
          id: 'older',
          userId: 'user-1',
          sentAt: new Date(now.getTime() - 60000), // 1 minute ago
        }),
        createTestDelivery({
          id: 'newest',
          userId: 'user-1',
          sentAt: now,
        }),
        createTestDelivery({
          id: 'middle',
          userId: 'user-1',
          sentAt: new Date(now.getTime() - 30000), // 30 seconds ago
        }),
      ];
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(3);
        expect(result.value[0]?.id).toBe('newest');
        expect(result.value[1]?.id).toBe('middle');
        expect(result.value[2]?.id).toBe('older');
      }
    });
  });

  describe('pagination', () => {
    it('uses default limit when not specified', async () => {
      const deliveries = Array.from({ length: DEFAULT_DELIVERIES_LIMIT + 10 }, (_, i) =>
        createTestDelivery({
          id: `delivery-${String(i)}`,
          userId: 'user-1',
          sentAt: new Date(Date.now() - i * 1000),
        })
      );
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(DEFAULT_DELIVERIES_LIMIT);
      }
    });

    it('respects custom limit', async () => {
      const deliveries = Array.from({ length: 20 }, (_, i) =>
        createTestDelivery({
          id: `delivery-${String(i)}`,
          userId: 'user-1',
          sentAt: new Date(Date.now() - i * 1000),
        })
      );
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1', limit: 5 });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(5);
      }
    });

    it('respects offset', async () => {
      const deliveries = Array.from({ length: 10 }, (_, i) =>
        createTestDelivery({
          id: `delivery-${String(i)}`,
          userId: 'user-1',
          sentAt: new Date(Date.now() - i * 1000),
        })
      );
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries(
        { deliveriesRepo: repo },
        { userId: 'user-1', limit: 3, offset: 3 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(3);
        // Should get items 3, 4, 5 (0-indexed from sorted list)
        expect(result.value[0]?.id).toBe('delivery-3');
      }
    });
  });

  describe('pagination clamping', () => {
    it('clamps limit to at least 1', async () => {
      const deliveries = [createTestDelivery({ id: 'delivery-1', userId: 'user-1' })];
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1', limit: 0 });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(1);
      }
    });

    it('clamps negative limit to 1', async () => {
      const deliveries = [createTestDelivery({ id: 'delivery-1', userId: 'user-1' })];
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries(
        { deliveriesRepo: repo },
        { userId: 'user-1', limit: -10 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(1);
      }
    });

    it('clamps limit to MAX_DELIVERIES_LIMIT', async () => {
      const deliveries = Array.from({ length: MAX_DELIVERIES_LIMIT + 50 }, (_, i) =>
        createTestDelivery({
          id: `delivery-${String(i)}`,
          userId: 'user-1',
          sentAt: new Date(Date.now() - i * 1000),
        })
      );
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries(
        { deliveriesRepo: repo },
        { userId: 'user-1', limit: MAX_DELIVERIES_LIMIT + 100 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(MAX_DELIVERIES_LIMIT);
      }
    });

    it('clamps negative offset to 0', async () => {
      const deliveries = [
        createTestDelivery({ id: 'delivery-1', userId: 'user-1' }),
        createTestDelivery({ id: 'delivery-2', userId: 'user-1' }),
      ];
      const repo = makeFakeDeliveriesRepo({ deliveries });

      const result = await listDeliveries(
        { deliveriesRepo: repo },
        { userId: 'user-1', offset: -5 }
      );

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(2);
      }
    });
  });

  describe('delivery data', () => {
    it('returns all delivery fields', async () => {
      const now = new Date();
      const delivery = createTestDelivery({
        id: 'delivery-1',
        userId: 'user-1',
        notificationId: 'notification-1',
        periodKey: '2024-01',
        deliveryKey: 'user-1:notification-1:2024-01',
        emailBatchId: 'batch-123',
        sentAt: now,
        metadata: { subject: 'Test notification' },
        createdAt: now,
      });
      const repo = makeFakeDeliveriesRepo({ deliveries: [delivery] });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1' });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toHaveLength(1);
        const returned = result.value[0];
        expect(returned?.id).toBe('delivery-1');
        expect(returned?.userId).toBe('user-1');
        expect(returned?.notificationId).toBe('notification-1');
        expect(returned?.periodKey).toBe('2024-01');
        expect(returned?.deliveryKey).toBe('user-1:notification-1:2024-01');
        expect(returned?.emailBatchId).toBe('batch-123');
        expect(returned?.metadata).toEqual({ subject: 'Test notification' });
      }
    });
  });

  describe('database error handling', () => {
    it('propagates database errors', async () => {
      const repo = makeFakeDeliveriesRepo({ simulateDbError: true });

      const result = await listDeliveries({ deliveriesRepo: repo }, { userId: 'user-1' });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe('DatabaseError');
      }
    });
  });
});
