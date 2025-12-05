/**
 * Unit tests for getExecutionLineItem use case.
 */

import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getExecutionLineItem } from '@/modules/execution-line-items/core/usecases/get-execution-line-item.js';

import type { ExecutionLineItemRepository } from '@/modules/execution-line-items/core/ports.js';
import type { ExecutionLineItem } from '@/modules/execution-line-items/core/types.js';

/**
 * Creates a fake repository with the given line items.
 */
const makeFakeRepo = (items: ExecutionLineItem[]): ExecutionLineItemRepository => ({
  findById: async (id: string) => {
    const item = items.find((i) => i.line_item_id === id);
    return ok(item ?? null);
  },
  list: async () =>
    ok({ nodes: [], pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false } }),
});

const testItem: ExecutionLineItem = {
  line_item_id: 'eli-123',
  report_id: 'report-1',
  entity_cui: '1234567',
  funding_source_id: 1,
  budget_sector_id: 1,
  functional_code: '51.01',
  economic_code: '10.01',
  account_category: 'ch',
  expense_type: 'functionare',
  program_code: null,
  year: 2024,
  month: 6,
  quarter: 2,
  ytd_amount: new Decimal('1000000.00'),
  monthly_amount: new Decimal('100000.00'),
  quarterly_amount: new Decimal('300000.00'),
};

describe('getExecutionLineItem', () => {
  describe('successful lookup', () => {
    it('returns line item when found', async () => {
      const repo = makeFakeRepo([testItem]);
      const result = await getExecutionLineItem({ executionLineItemRepo: repo }, 'eli-123');

      expect(result.isOk()).toBe(true);
      const item = result._unsafeUnwrap();
      expect(item).not.toBeNull();
      expect(item?.line_item_id).toBe('eli-123');
      expect(item?.entity_cui).toBe('1234567');
      expect(item?.ytd_amount.toString()).toBe('1000000');
    });

    it('returns correct item when multiple exist', async () => {
      const items: ExecutionLineItem[] = [
        testItem,
        {
          ...testItem,
          line_item_id: 'eli-456',
          entity_cui: '7654321',
          ytd_amount: new Decimal('2000000.00'),
        },
        {
          ...testItem,
          line_item_id: 'eli-789',
          entity_cui: '9876543',
          ytd_amount: new Decimal('3000000.00'),
        },
      ];

      const repo = makeFakeRepo(items);
      const result = await getExecutionLineItem({ executionLineItemRepo: repo }, 'eli-456');

      expect(result.isOk()).toBe(true);
      const item = result._unsafeUnwrap();
      expect(item?.line_item_id).toBe('eli-456');
      expect(item?.entity_cui).toBe('7654321');
    });
  });

  describe('not found', () => {
    it('returns null when not found', async () => {
      const repo = makeFakeRepo([]);
      const result = await getExecutionLineItem({ executionLineItemRepo: repo }, 'nonexistent');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns null for ID not in list', async () => {
      const repo = makeFakeRepo([testItem]);
      const result = await getExecutionLineItem({ executionLineItemRepo: repo }, 'eli-999');

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });
  });

  describe('error handling', () => {
    it('propagates repository errors', async () => {
      const errorRepo: ExecutionLineItemRepository = {
        findById: async () =>
          err({
            type: 'DatabaseError',
            message: 'Connection failed',
            retryable: true,
          }),
        list: async () =>
          err({
            type: 'DatabaseError',
            message: 'Connection failed',
            retryable: true,
          }),
      };

      const result = await getExecutionLineItem({ executionLineItemRepo: errorRepo }, 'eli-123');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
      expect(result._unsafeUnwrapErr().message).toBe('Connection failed');
    });

    it('propagates timeout errors', async () => {
      const errorRepo: ExecutionLineItemRepository = {
        findById: async () =>
          err({
            type: 'TimeoutError',
            message: 'Query timed out',
            retryable: true,
          }),
        list: async () =>
          err({
            type: 'TimeoutError',
            message: 'Query timed out',
            retryable: true,
          }),
      };

      const result = await getExecutionLineItem({ executionLineItemRepo: errorRepo }, 'eli-123');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TimeoutError');
    });
  });
});
