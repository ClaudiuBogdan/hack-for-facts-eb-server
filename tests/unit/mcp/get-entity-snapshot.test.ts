/**
 * Unit tests for get_entity_snapshot MCP use case.
 */

import { Decimal } from 'decimal.js';
import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { getEntitySnapshot, type GetEntitySnapshotDeps } from '@/modules/mcp/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface TestEntity {
  cui: string;
  name: string;
  address: string | null;
}

const TEST_ENTITY: TestEntity = {
  cui: '4305857',
  name: 'Municipiul Cluj-Napoca',
  address: 'Piata Unirii 1, Cluj-Napoca',
};

const TEST_SNAPSHOT = {
  totalIncome: new Decimal('1500000000'), // 1.5B
  totalExpenses: new Decimal('1400000000'), // 1.4B
};

const TEST_CONFIG = {
  clientBaseUrl: 'https://transparenta.eu',
};

/**
 * Creates a fake entity repository.
 */
function makeFakeEntityRepo(options: {
  entity?: typeof TEST_ENTITY | null;
  searchResults?: (typeof TEST_ENTITY)[];
  getByIdError?: boolean;
  getAllError?: boolean;
}): GetEntitySnapshotDeps['entityRepo'] {
  const {
    entity = TEST_ENTITY,
    searchResults,
    getByIdError = false,
    getAllError = false,
  } = options;

  return {
    async getById(cui: string) {
      if (getByIdError) {
        return err({ type: 'DatabaseError', message: 'Connection failed' });
      }
      if (entity !== null && entity.cui === cui) {
        return ok(entity);
      }
      return ok(null);
    },
    async getAll(filter: { search?: string }, limit: number, _offset: number) {
      if (getAllError) {
        return err({ type: 'DatabaseError', message: 'Connection failed' });
      }
      const results = searchResults ?? (entity !== null ? [entity] : []);
      // Simple search simulation
      const searchTerm = filter.search;
      const filtered =
        searchTerm !== undefined && searchTerm !== ''
          ? results.filter((e) => e.name.toLowerCase().includes(searchTerm.toLowerCase()))
          : results;
      return ok({ nodes: filtered.slice(0, limit) });
    },
  };
}

/**
 * Creates a fake execution repository.
 */
function makeFakeExecutionRepo(options: {
  snapshot?: typeof TEST_SNAPSHOT;
  error?: boolean;
  domainError?: { type: string; message: string };
}): GetEntitySnapshotDeps['executionRepo'] {
  const { snapshot = TEST_SNAPSHOT, error = false, domainError } = options;

  return {
    async getYearlySnapshotTotals(_cui: string, _year: number) {
      if (domainError !== undefined) {
        return err(domainError);
      }
      if (error) {
        return err({ message: 'Generic error' });
      }
      return ok(snapshot);
    },
  };
}

/**
 * Creates a fake share link service.
 */
function makeFakeShareLink(options: {
  shortUrl?: string;
  error?: boolean;
}): GetEntitySnapshotDeps['shareLink'] {
  const { shortUrl = 'https://t.eu/abc123', error = false } = options;

  return {
    async create(_url: string) {
      if (error) {
        return err({ type: 'ShareLinkError', message: 'Failed to create short link' });
      }
      return ok(shortUrl);
    },
  };
}

/**
 * Creates default test dependencies.
 */
function makeTestDeps(overrides: Partial<GetEntitySnapshotDeps> = {}): GetEntitySnapshotDeps {
  return {
    entityRepo: makeFakeEntityRepo({}),
    executionRepo: makeFakeExecutionRepo({}),
    shareLink: makeFakeShareLink({}),
    config: TEST_CONFIG,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getEntitySnapshot', () => {
  describe('entity resolution', () => {
    it('finds entity by CUI', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.item.cui).toBe('4305857');
      expect(output.item.name).toBe('Municipiul Cluj-Napoca');
    });

    it('finds entity by search when CUI not provided', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { entitySearch: 'Cluj-Napoca', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.item.cui).toBe('4305857');
    });

    it('prefers CUI over search when both provided', async () => {
      const anotherEntity: TestEntity = { cui: '9999999', name: 'Alt oras', address: null };
      const deps = makeTestDeps({
        entityRepo: makeFakeEntityRepo({
          entity: TEST_ENTITY,
          searchResults: [anotherEntity],
        }),
      });

      const result = await getEntitySnapshot(deps, {
        entityCui: '4305857',
        entitySearch: 'Alt',
        year: 2023,
      });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.item.cui).toBe('4305857'); // CUI takes priority
    });

    it('returns error when entity not found by CUI', async () => {
      const deps = makeTestDeps({
        entityRepo: makeFakeEntityRepo({ entity: null }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '0000000', year: 2023 });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('ENTITY_NOT_FOUND');
      expect(error.message).toContain('0000000');
    });

    it('returns error when entity not found by search', async () => {
      const deps = makeTestDeps({
        entityRepo: makeFakeEntityRepo({ entity: null, searchResults: [] }),
      });

      const result = await getEntitySnapshot(deps, { entitySearch: 'NonExistent', year: 2023 });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.code).toBe('ENTITY_NOT_FOUND');
      expect(error.message).toContain('NonExistent');
    });

    it('returns error when neither CUI nor search provided', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { year: 2023 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('ENTITY_NOT_FOUND');
    });

    it('returns error when CUI is empty string', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { entityCui: '', year: 2023 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('ENTITY_NOT_FOUND');
    });
  });

  describe('database errors', () => {
    it('returns database error when getById fails', async () => {
      const deps = makeTestDeps({
        entityRepo: makeFakeEntityRepo({ getByIdError: true }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
    });

    it('returns database error when getAll fails', async () => {
      const deps = makeTestDeps({
        entityRepo: makeFakeEntityRepo({ getAllError: true }),
      });

      const result = await getEntitySnapshot(deps, { entitySearch: 'Cluj', year: 2023 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
    });

    it('returns database error when snapshot fetch fails', async () => {
      const deps = makeTestDeps({
        executionRepo: makeFakeExecutionRepo({ error: true }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
    });

    it('converts domain errors via toMcpError', async () => {
      const deps = makeTestDeps({
        executionRepo: makeFakeExecutionRepo({
          domainError: { type: 'TimeoutError', message: 'Query timed out' },
        }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('TIMEOUT_ERROR');
    });
  });

  describe('output formatting', () => {
    it('formats amounts correctly', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();

      // Check numeric values
      expect(output.item.totalIncome).toBe(1_500_000_000);
      expect(output.item.totalExpenses).toBe(1_400_000_000);

      // Check formatted strings contain expected parts
      expect(output.item.totalIncomeFormatted).toContain('1.50B RON');
      expect(output.item.totalIncomeFormatted).toContain('Venituri totale');
      expect(output.item.totalIncomeFormatted).toContain('Total income');

      expect(output.item.totalExpensesFormatted).toContain('1.40B RON');
      expect(output.item.totalExpensesFormatted).toContain('Cheltuieli totale');
      expect(output.item.totalExpensesFormatted).toContain('Total expenses');
    });

    it('generates meaningful summary', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();

      expect(output.item.summary).toContain('2023');
      expect(output.item.summary).toContain('Municipiul Cluj-Napoca');
      expect(output.item.summary).toContain('income');
      expect(output.item.summary).toContain('expenses');
    });

    it('includes correct kind and query', async () => {
      const deps = makeTestDeps();
      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();

      expect(output.kind).toBe('entities.details');
      expect(output.query.cui).toBe('4305857');
      expect(output.query.year).toBe(2023);
    });
  });

  describe('link handling', () => {
    it('uses shortened link when available', async () => {
      const deps = makeTestDeps({
        shareLink: makeFakeShareLink({ shortUrl: 'https://t.eu/short' }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().link).toBe('https://t.eu/short');
    });

    it('falls back to full link when shortening fails', async () => {
      const deps = makeTestDeps({
        shareLink: makeFakeShareLink({ error: true }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const link = result._unsafeUnwrap().link;
      expect(link).toBe('https://transparenta.eu/entities/4305857?year=2023');
    });
  });

  describe('different amount scales', () => {
    it('formats millions correctly', async () => {
      const deps = makeTestDeps({
        executionRepo: makeFakeExecutionRepo({
          snapshot: {
            totalIncome: new Decimal('5234567.89'),
            totalExpenses: new Decimal('4123456.78'),
          },
        }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.item.totalIncomeFormatted).toContain('5.23M RON');
    });

    it('formats thousands correctly', async () => {
      const deps = makeTestDeps({
        executionRepo: makeFakeExecutionRepo({
          snapshot: {
            totalIncome: new Decimal('5234.56'),
            totalExpenses: new Decimal('4123.45'),
          },
        }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.item.totalIncomeFormatted).toContain('5.23K RON');
    });

    it('formats small amounts correctly', async () => {
      const deps = makeTestDeps({
        executionRepo: makeFakeExecutionRepo({
          snapshot: {
            totalIncome: new Decimal('523.45'),
            totalExpenses: new Decimal('412.34'),
          },
        }),
      });

      const result = await getEntitySnapshot(deps, { entityCui: '4305857', year: 2023 });

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.item.totalIncomeFormatted).toContain('523.45 RON');
    });
  });
});
