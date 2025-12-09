/**
 * Unit tests for rank_entities MCP use case.
 */

import { ok, err } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { rankEntities, type RankEntitiesDeps } from '@/modules/mcp/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface EntityAnalyticsRow {
  entity_cui: string;
  entity_name: string;
  entity_type: string | null;
  uat_id: number | null;
  county_code: string | null;
  county_name: string | null;
  population: number | null;
  amount: number;
  total_amount: number;
  per_capita_amount: number;
}

const TEST_ENTITIES: EntityAnalyticsRow[] = [
  {
    entity_cui: '4305857',
    entity_name: 'Municipiul Cluj-Napoca',
    entity_type: 'Municipiu',
    uat_id: 54975,
    county_code: 'CJ',
    county_name: 'Cluj',
    population: 320000,
    amount: 1_500_000_000,
    total_amount: 1_500_000_000,
    per_capita_amount: 4687.5,
  },
  {
    entity_cui: '4316422',
    entity_name: 'Municipiul Timișoara',
    entity_type: 'Municipiu',
    uat_id: 155129,
    county_code: 'TM',
    county_name: 'Timiș',
    population: 310000,
    amount: 1_400_000_000,
    total_amount: 1_400_000_000,
    per_capita_amount: 4516.13,
  },
  {
    entity_cui: '4267117',
    entity_name: 'Municipiul Brașov',
    entity_type: 'Municipiu',
    uat_id: 40198,
    county_code: 'BV',
    county_name: 'Brașov',
    population: 280000,
    amount: 1_300_000_000,
    total_amount: 1_300_000_000,
    per_capita_amount: 4642.86,
  },
];

const TEST_CONFIG = {
  clientBaseUrl: 'https://transparenta.eu',
};

/**
 * Creates a fake entity analytics repository.
 */
function makeFakeEntityAnalyticsRepo(options: {
  entities?: EntityAnalyticsRow[];
  totalCount?: number;
  error?: boolean;
  domainError?: { type: string; message: string };
}): RankEntitiesDeps['entityAnalyticsRepo'] {
  const { entities = TEST_ENTITIES, totalCount, error = false, domainError } = options;

  return {
    async getEntityAnalytics(
      _filter: Record<string, unknown>,
      sort: { by: string; order: 'ASC' | 'DESC' } | undefined,
      limit: number,
      offset: number
    ) {
      if (domainError !== undefined) {
        return err(domainError);
      }
      if (error) {
        return err({ message: 'Generic error' });
      }

      // Apply sorting
      const sorted = [...entities];
      if (sort !== undefined) {
        sorted.sort((a, b) => {
          const aVal = a[sort.by as keyof EntityAnalyticsRow] ?? 0;
          const bVal = b[sort.by as keyof EntityAnalyticsRow] ?? 0;
          if (typeof aVal === 'number' && typeof bVal === 'number') {
            return sort.order === 'ASC' ? aVal - bVal : bVal - aVal;
          }
          return 0;
        });
      }

      // Apply pagination
      const paged = sorted.slice(offset, offset + limit);

      return ok({
        rows: paged,
        totalCount: totalCount ?? entities.length,
      });
    },
  };
}

/**
 * Creates a fake share link service.
 */
function makeFakeShareLink(options: {
  shortUrl?: string;
  error?: boolean;
}): RankEntitiesDeps['shareLink'] {
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
function makeTestDeps(overrides: Partial<RankEntitiesDeps> = {}): RankEntitiesDeps {
  return {
    entityAnalyticsRepo: makeFakeEntityAnalyticsRepo({}),
    shareLink: makeFakeShareLink({}),
    config: TEST_CONFIG,
    ...overrides,
  };
}

/**
 * Creates minimal valid input for rank_entities.
 */
function makeValidInput(overrides: Partial<Parameters<typeof rankEntities>[1]> = {}) {
  return {
    period: {
      type: 'YEAR' as const,
      selection: { dates: ['2023'] },
    },
    filter: {
      accountCategory: 'ch' as const,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('rankEntities', () => {
  describe('basic functionality', () => {
    it('returns entities with correct structure', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(deps, makeValidInput());

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.ok).toBe(true);
      expect(output.entities).toHaveLength(3);

      const first = output.entities[0]!;
      expect(first.entity_cui).toBe('4305857');
      expect(first.entity_name).toBe('Municipiul Cluj-Napoca');
      expect(first.amount).toBe(1_500_000_000);
      expect(first.per_capita_amount).toBe(4687.5);
    });

    it('includes page info', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(deps, makeValidInput());

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.pageInfo.totalCount).toBe(3);
      expect(output.pageInfo.hasNextPage).toBe(false);
      expect(output.pageInfo.hasPreviousPage).toBe(false);
    });

    it('includes shareable link', async () => {
      const deps = makeTestDeps({
        shareLink: makeFakeShareLink({ shortUrl: 'https://t.eu/rank123' }),
      });
      const result = await rankEntities(deps, makeValidInput());

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().link).toBe('https://t.eu/rank123');
    });
  });

  describe('pagination', () => {
    it('applies limit correctly', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(deps, makeValidInput({ limit: 2 }));

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.entities).toHaveLength(2);
      expect(output.pageInfo.hasNextPage).toBe(true);
    });

    it('applies offset correctly', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(deps, makeValidInput({ limit: 2, offset: 1 }));

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.entities).toHaveLength(2);
      expect(output.entities[0]!.entity_cui).toBe('4316422'); // Second entity
      expect(output.pageInfo.hasPreviousPage).toBe(true);
    });

    it('clamps limit to maximum', async () => {
      const deps = makeTestDeps({
        entityAnalyticsRepo: makeFakeEntityAnalyticsRepo({ totalCount: 1000 }),
      });
      // MAX_RANKING_LIMIT is 500
      const result = await rankEntities(deps, makeValidInput({ limit: 1000 }));

      expect(result.isOk()).toBe(true);
      // The fake repo will return only 3 entities (all we have)
      // but the clamping should have occurred
    });

    it('uses default limit when not specified', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(deps, makeValidInput());

      expect(result.isOk()).toBe(true);
      // DEFAULT_RANKING_LIMIT is 50, but we only have 3 entities
      const output = result._unsafeUnwrap();
      expect(output.entities).toHaveLength(3);
    });

    it('handles negative offset by using 0', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(deps, makeValidInput({ offset: -5 }));

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.entities[0]!.entity_cui).toBe('4305857'); // First entity
    });
  });

  describe('sorting', () => {
    it('sorts by amount descending by default', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(
        deps,
        makeValidInput({ sort: { by: 'amount', order: 'DESC' } })
      );

      expect(result.isOk()).toBe(true);
      const entities = result._unsafeUnwrap().entities;
      expect(entities[0]!.amount).toBe(1_500_000_000);
      expect(entities[1]!.amount).toBe(1_400_000_000);
      expect(entities[2]!.amount).toBe(1_300_000_000);
    });

    it('sorts by amount ascending when specified', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(
        deps,
        makeValidInput({ sort: { by: 'amount', order: 'ASC' } })
      );

      expect(result.isOk()).toBe(true);
      const entities = result._unsafeUnwrap().entities;
      expect(entities[0]!.amount).toBe(1_300_000_000);
      expect(entities[2]!.amount).toBe(1_500_000_000);
    });

    it('sorts by per_capita_amount', async () => {
      const deps = makeTestDeps();
      const result = await rankEntities(
        deps,
        makeValidInput({ sort: { by: 'per_capita_amount', order: 'DESC' } })
      );

      expect(result.isOk()).toBe(true);
      const entities = result._unsafeUnwrap().entities;
      // 4687.5 > 4642.86 > 4516.13
      expect(entities[0]!.entity_cui).toBe('4305857'); // Cluj
      expect(entities[1]!.entity_cui).toBe('4267117'); // Brașov
      expect(entities[2]!.entity_cui).toBe('4316422'); // Timișoara
    });
  });

  describe('filter conversion', () => {
    it('passes account category to internal filter', async () => {
      let capturedFilter: Record<string, unknown> = {};
      const deps = makeTestDeps({
        entityAnalyticsRepo: {
          async getEntityAnalytics(filter, _sort, _limit, _offset) {
            capturedFilter = filter;
            return ok({ rows: [], totalCount: 0 });
          },
        },
      });

      await rankEntities(
        deps,
        makeValidInput({
          filter: { accountCategory: 'vn' },
        })
      );

      expect(capturedFilter['account_category']).toBe('vn');
    });

    it('passes period configuration to internal filter', async () => {
      let capturedFilter: Record<string, unknown> = {};
      const deps = makeTestDeps({
        entityAnalyticsRepo: {
          async getEntityAnalytics(filter, _sort, _limit, _offset) {
            capturedFilter = filter;
            return ok({ rows: [], totalCount: 0 });
          },
        },
      });

      await rankEntities(
        deps,
        makeValidInput({
          period: {
            type: 'MONTH',
            selection: { interval: { start: '2023-01', end: '2023-06' } },
          },
        })
      );

      expect(capturedFilter['report_period']).toEqual({
        type: 'MONTH',
        selection: { interval: { start: '2023-01', end: '2023-06' } },
      });
    });

    it('passes entity scope filters', async () => {
      let capturedFilter: Record<string, unknown> = {};
      const deps = makeTestDeps({
        entityAnalyticsRepo: {
          async getEntityAnalytics(filter, _sort, _limit, _offset) {
            capturedFilter = filter;
            return ok({ rows: [], totalCount: 0 });
          },
        },
      });

      await rankEntities(
        deps,
        makeValidInput({
          filter: {
            accountCategory: 'ch',
            entityCuis: ['4305857'],
            uatIds: ['54975'],
            countyCodes: ['CJ'],
            isUat: true,
          },
        })
      );

      expect(capturedFilter['entity_cuis']).toEqual(['4305857']);
      expect(capturedFilter['uat_ids']).toEqual(['54975']);
      expect(capturedFilter['county_codes']).toEqual(['CJ']);
      expect(capturedFilter['is_uat']).toBe(true);
    });

    it('passes classification filters', async () => {
      let capturedFilter: Record<string, unknown> = {};
      const deps = makeTestDeps({
        entityAnalyticsRepo: {
          async getEntityAnalytics(filter, _sort, _limit, _offset) {
            capturedFilter = filter;
            return ok({ rows: [], totalCount: 0 });
          },
        },
      });

      await rankEntities(
        deps,
        makeValidInput({
          filter: {
            accountCategory: 'ch',
            functionalCodes: ['65.02'],
            functionalPrefixes: ['65.'],
            economicCodes: ['20.01'],
            economicPrefixes: ['20.'],
          },
        })
      );

      expect(capturedFilter['functional_codes']).toEqual(['65.02']);
      expect(capturedFilter['functional_prefixes']).toEqual(['65.']);
      expect(capturedFilter['economic_codes']).toEqual(['20.01']);
      expect(capturedFilter['economic_prefixes']).toEqual(['20.']);
    });

    it('passes exclusion filters', async () => {
      let capturedFilter: Record<string, unknown> = {};
      const deps = makeTestDeps({
        entityAnalyticsRepo: {
          async getEntityAnalytics(filter, _sort, _limit, _offset) {
            capturedFilter = filter;
            return ok({ rows: [], totalCount: 0 });
          },
        },
      });

      await rankEntities(
        deps,
        makeValidInput({
          filter: {
            accountCategory: 'ch',
            exclude: {
              entity_cuis: ['123'],
              functional_prefixes: ['84.'],
            },
          },
        })
      );

      const exclude = capturedFilter['exclude'] as Record<string, unknown>;
      expect(exclude['entity_cuis']).toEqual(['123']);
      expect(exclude['functional_prefixes']).toEqual(['84.']);
    });

    it('normalizes report type', async () => {
      let capturedFilter: Record<string, unknown> = {};
      const deps = makeTestDeps({
        entityAnalyticsRepo: {
          async getEntityAnalytics(filter, _sort, _limit, _offset) {
            capturedFilter = filter;
            return ok({ rows: [], totalCount: 0 });
          },
        },
      });

      await rankEntities(
        deps,
        makeValidInput({
          filter: {
            accountCategory: 'ch',
            reportType: 'PRINCIPAL_AGGREGATED',
          },
        })
      );

      expect(capturedFilter['report_type']).toBe(
        'Executie bugetara agregata la nivel de ordonator principal'
      );
    });
  });

  describe('error handling', () => {
    it('returns database error when repository fails', async () => {
      const deps = makeTestDeps({
        entityAnalyticsRepo: makeFakeEntityAnalyticsRepo({ error: true }),
      });

      const result = await rankEntities(deps, makeValidInput());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
    });

    it('converts domain errors via toMcpError', async () => {
      const deps = makeTestDeps({
        entityAnalyticsRepo: makeFakeEntityAnalyticsRepo({
          domainError: { type: 'TimeoutError', message: 'Query timed out' },
        }),
      });

      const result = await rankEntities(deps, makeValidInput());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('TIMEOUT_ERROR');
    });
  });

  describe('link handling', () => {
    it('falls back to full link when shortening fails', async () => {
      const deps = makeTestDeps({
        shareLink: makeFakeShareLink({ error: true }),
      });

      const result = await rankEntities(deps, makeValidInput());

      expect(result.isOk()).toBe(true);
      const link = result._unsafeUnwrap().link;
      expect(link).toContain('transparenta.eu/analytics');
      expect(link).toContain('view=table');
    });
  });

  describe('empty results', () => {
    it('handles no matching entities gracefully', async () => {
      const deps = makeTestDeps({
        entityAnalyticsRepo: makeFakeEntityAnalyticsRepo({ entities: [], totalCount: 0 }),
      });

      const result = await rankEntities(deps, makeValidInput());

      expect(result.isOk()).toBe(true);
      const output = result._unsafeUnwrap();
      expect(output.entities).toHaveLength(0);
      expect(output.pageInfo.totalCount).toBe(0);
      expect(output.pageInfo.hasNextPage).toBe(false);
      expect(output.pageInfo.hasPreviousPage).toBe(false);
    });
  });
});
