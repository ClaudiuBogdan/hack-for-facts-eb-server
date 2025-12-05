/**
 * Unit tests for listExecutionLineItems use case.
 */

import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  MAX_LIMIT,
  SORTABLE_FIELDS,
  DEFAULT_SORT,
  type ExecutionLineItem,
  type ExecutionLineItemFilter,
  type SortInput,
} from '@/modules/execution-line-items/core/types.js';
import { listExecutionLineItems } from '@/modules/execution-line-items/core/usecases/list-execution-line-items.js';

import type { ExecutionLineItemRepository } from '@/modules/execution-line-items/core/ports.js';

const testItems: ExecutionLineItem[] = [
  {
    line_item_id: 'eli-1',
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
  },
  {
    line_item_id: 'eli-2',
    report_id: 'report-1',
    entity_cui: '1234567',
    funding_source_id: 1,
    budget_sector_id: 1,
    functional_code: '00.01',
    economic_code: null,
    account_category: 'vn',
    expense_type: null,
    program_code: null,
    year: 2024,
    month: 6,
    quarter: 2,
    ytd_amount: new Decimal('2000000.00'),
    monthly_amount: new Decimal('200000.00'),
    quarterly_amount: new Decimal('600000.00'),
  },
  {
    line_item_id: 'eli-3',
    report_id: 'report-2',
    entity_cui: '7654321',
    funding_source_id: 2,
    budget_sector_id: 2,
    functional_code: '54.02',
    economic_code: '20.01',
    account_category: 'ch',
    expense_type: 'dezvoltare',
    program_code: 'P001',
    year: 2023,
    month: 12,
    quarter: 4,
    ytd_amount: new Decimal('5000000.00'),
    monthly_amount: new Decimal('500000.00'),
    quarterly_amount: new Decimal('1500000.00'),
  },
  {
    line_item_id: 'eli-4',
    report_id: 'report-3',
    entity_cui: '9876543',
    funding_source_id: 1,
    budget_sector_id: 1,
    functional_code: '51.01',
    economic_code: '10.01',
    account_category: 'ch',
    expense_type: 'functionare',
    program_code: 'P002',
    year: 2022,
    month: 12,
    quarter: 4,
    ytd_amount: new Decimal('3000000.00'),
    monthly_amount: new Decimal('300000.00'),
    quarterly_amount: new Decimal('900000.00'),
  },
];

/**
 * Creates a fake repository that simulates filtering and pagination.
 */
const makeFakeRepo = (items: ExecutionLineItem[]): ExecutionLineItemRepository => ({
  findById: async () => ok(null),
  list: async (filter: ExecutionLineItemFilter, sort: SortInput, limit: number, offset: number) => {
    let filtered = [...items];

    // Apply account_category filter
    if (filter.account_category !== undefined) {
      filtered = filtered.filter((item) => item.account_category === filter.account_category);
    }

    // Apply entity_cuis filter
    if (filter.entity_cuis !== undefined && filter.entity_cuis.length > 0) {
      const cuisSet = new Set(filter.entity_cuis);
      filtered = filtered.filter((item) => cuisSet.has(item.entity_cui));
    }

    // Apply functional_codes filter
    if (filter.functional_codes !== undefined && filter.functional_codes.length > 0) {
      const codesSet = new Set(filter.functional_codes);
      filtered = filtered.filter((item) => codesSet.has(item.functional_code));
    }

    // Simple sort implementation
    if (sort.field === 'year') {
      filtered.sort((a, b) => (sort.order === 'ASC' ? a.year - b.year : b.year - a.year));
    } else if (sort.field === 'ytd_amount') {
      filtered.sort((a, b) =>
        sort.order === 'ASC'
          ? a.ytd_amount.comparedTo(b.ytd_amount)
          : b.ytd_amount.comparedTo(a.ytd_amount)
      );
    }

    const totalCount = filtered.length;
    const nodes = filtered.slice(offset, offset + limit);

    return ok({
      nodes,
      pageInfo: {
        totalCount,
        hasNextPage: offset + limit < totalCount,
        hasPreviousPage: offset > 0,
      },
    });
  },
});

const defaultFilter: ExecutionLineItemFilter = {
  account_category: 'ch',
  report_period: {
    frequency: Frequency.YEAR,
    selection: { interval: { start: '2022', end: '2024' } },
  },
};

describe('listExecutionLineItems', () => {
  describe('basic listing', () => {
    it('returns items matching filter', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: 100, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      // Only 'ch' account_category items (3 of them)
      expect(conn.nodes).toHaveLength(3);
      expect(conn.pageInfo.totalCount).toBe(3);
    });

    it('returns empty when no items match', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: { ...defaultFilter, entity_cuis: ['nonexistent'] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().nodes).toHaveLength(0);
      expect(result._unsafeUnwrap().pageInfo.totalCount).toBe(0);
    });
  });

  describe('pagination', () => {
    it('respects limit', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: 2, offset: 0 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.pageInfo.hasNextPage).toBe(true);
      expect(conn.pageInfo.hasPreviousPage).toBe(false);
    });

    it('respects offset', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: 2, offset: 1 }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      expect(conn.pageInfo.hasPreviousPage).toBe(true);
    });

    it('clamps negative offset to 0', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: 10, offset: -5 }
      );

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().pageInfo.hasPreviousPage).toBe(false);
    });

    it('clamps limit to MAX_LIMIT', async () => {
      let receivedLimit = 0;
      const repo: ExecutionLineItemRepository = {
        findById: async () => ok(null),
        list: async (_f, _s, limit, _o) => {
          receivedLimit = limit;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: 9999, offset: 0 }
      );
      expect(receivedLimit).toBe(MAX_LIMIT);
    });

    it('clamps negative limit to 1', async () => {
      let receivedLimit = 0;
      const repo: ExecutionLineItemRepository = {
        findById: async () => ok(null),
        list: async (_f, _s, limit, _o) => {
          receivedLimit = limit;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: -5, offset: 0 }
      );
      expect(receivedLimit).toBe(1);
    });
  });

  describe('sorting', () => {
    it('uses default sort when not specified', async () => {
      let receivedSort: SortInput | undefined;
      const repo: ExecutionLineItemRepository = {
        findById: async () => ok(null),
        list: async (_f, sort, _l, _o) => {
          receivedSort = sort;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listExecutionLineItems(
        { executionLineItemRepo: repo },
        { filter: defaultFilter, limit: 10, offset: 0 }
      );

      expect(receivedSort).toEqual(DEFAULT_SORT);
    });

    it('accepts valid sort field', async () => {
      let receivedSort: SortInput | undefined;
      const repo: ExecutionLineItemRepository = {
        findById: async () => ok(null),
        list: async (_f, sort, _l, _o) => {
          receivedSort = sort;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: defaultFilter,
          sort: { field: 'ytd_amount', order: 'ASC' },
          limit: 10,
          offset: 0,
        }
      );

      expect(receivedSort?.field).toBe('ytd_amount');
      expect(receivedSort?.order).toBe('ASC');
    });

    it('falls back to default for invalid sort field', async () => {
      let receivedSort: SortInput | undefined;
      const repo: ExecutionLineItemRepository = {
        findById: async () => ok(null),
        list: async (_f, sort, _l, _o) => {
          receivedSort = sort;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: defaultFilter,
          sort: { field: 'invalid_field' as (typeof SORTABLE_FIELDS)[number], order: 'DESC' },
          limit: 10,
          offset: 0,
        }
      );

      expect(receivedSort).toEqual(DEFAULT_SORT);
    });

    it('normalizes invalid sort order to DESC', async () => {
      let receivedSort: SortInput | undefined;
      const repo: ExecutionLineItemRepository = {
        findById: async () => ok(null),
        list: async (_f, sort, _l, _o) => {
          receivedSort = sort;
          return ok({
            nodes: [],
            pageInfo: { totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          });
        },
      };

      await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: defaultFilter,
          sort: { field: 'year', order: 'INVALID' as 'ASC' | 'DESC' },
          limit: 10,
          offset: 0,
        }
      );

      expect(receivedSort?.order).toBe('DESC');
    });
  });

  describe('filtering', () => {
    it('filters by account_category', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: { ...defaultFilter, account_category: 'vn' },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(1);
      expect(conn.nodes[0]?.account_category).toBe('vn');
    });

    it('filters by entity_cuis', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: { ...defaultFilter, entity_cuis: ['7654321'] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(1);
      expect(conn.nodes[0]?.entity_cui).toBe('7654321');
    });

    it('filters by functional_codes', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: { ...defaultFilter, functional_codes: ['51.01'] },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(2);
      conn.nodes.forEach((node) => {
        expect(node.functional_code).toBe('51.01');
      });
    });

    it('combines multiple filters', async () => {
      const repo = makeFakeRepo(testItems);
      const result = await listExecutionLineItems(
        { executionLineItemRepo: repo },
        {
          filter: {
            ...defaultFilter,
            entity_cuis: ['1234567'],
            functional_codes: ['51.01'],
          },
          limit: 100,
          offset: 0,
        }
      );

      expect(result.isOk()).toBe(true);
      const conn = result._unsafeUnwrap();
      expect(conn.nodes).toHaveLength(1);
      expect(conn.nodes[0]?.entity_cui).toBe('1234567');
      expect(conn.nodes[0]?.functional_code).toBe('51.01');
    });
  });

  describe('error handling', () => {
    it('propagates repository errors', async () => {
      const errorRepo: ExecutionLineItemRepository = {
        findById: async () => err({ type: 'DatabaseError', message: 'Failed', retryable: true }),
        list: async () =>
          err({ type: 'DatabaseError', message: 'Connection refused', retryable: true }),
      };

      const result = await listExecutionLineItems(
        { executionLineItemRepo: errorRepo },
        { filter: defaultFilter, limit: 10, offset: 0 }
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('DatabaseError');
      expect(result._unsafeUnwrapErr().message).toBe('Connection refused');
    });

    it('propagates timeout errors', async () => {
      const errorRepo: ExecutionLineItemRepository = {
        findById: async () =>
          err({ type: 'TimeoutError', message: 'Query timed out', retryable: true }),
        list: async () =>
          err({ type: 'TimeoutError', message: 'Query exceeded 30s', retryable: true }),
      };

      const result = await listExecutionLineItems(
        { executionLineItemRepo: errorRepo },
        { filter: defaultFilter, limit: 10, offset: 0 }
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().type).toBe('TimeoutError');
    });
  });
});
