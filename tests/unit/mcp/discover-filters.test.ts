/**
 * Unit tests for discover_filters MCP use case.
 */

import { ok } from 'neverthrow';
import { describe, it, expect } from 'vitest';

import { discoverFilters, type DiscoverFiltersDeps } from '@/modules/mcp/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const createFakeDeps = (overrides: Partial<DiscoverFiltersDeps> = {}): DiscoverFiltersDeps => ({
  entityRepo: {
    getAll: async () =>
      ok({
        nodes: [
          {
            cui: '4305857',
            name: 'Municipiul Cluj-Napoca',
            address: 'Str. Moților 3',
            relevance: 0.95,
          },
          {
            cui: '4316787',
            name: 'Municipiul București',
            address: 'Bd. Regina Elisabeta',
            relevance: 0.9,
          },
        ],
      }),
  },
  uatRepo: {
    getAll: async () =>
      ok({
        nodes: [
          {
            id: 54975,
            name: 'Cluj-Napoca',
            county_code: 'CJ',
            population: 324576,
            relevance: 0.95,
          },
          { id: 1, name: 'București', county_code: 'B', population: 1800000, relevance: 0.9 },
        ],
      }),
  },
  functionalClassificationRepo: {
    getAll: async () =>
      ok({
        nodes: [
          { functional_code: '65', functional_name: 'Învățământ', relevance: 0.95 },
          { functional_code: '66', functional_name: 'Sănătate', relevance: 0.85 },
        ],
      }),
  },
  economicClassificationRepo: {
    getAll: async () =>
      ok({
        nodes: [
          { economic_code: '10', economic_name: 'Cheltuieli cu salariile', relevance: 0.9 },
          { economic_code: '20', economic_name: 'Bunuri și servicii', relevance: 0.85 },
        ],
      }),
  },
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('discoverFilters', () => {
  describe('entity category', () => {
    it('returns entity results with correct filterKey', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'entity',
        query: 'Cluj',
        limit: 10,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.ok).toBe(true);
        expect(result.value.results).toHaveLength(2);
        expect(result.value.results[0]?.filterKey).toBe('entity_cuis');
        expect(result.value.results[0]?.filterValue).toBe('4305857');
      }
    });

    it('identifies best match when score is high', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'entity',
        query: 'Cluj-Napoca',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.bestMatch).toBeDefined();
        expect(result.value.bestMatch?.name).toBe('Municipiul Cluj-Napoca');
      }
    });
  });

  describe('uat category', () => {
    it('returns UAT results with correct filterKey', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'uat',
        query: 'București',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // All results should have uat_ids as filterKey
        expect(result.value.results.every((r) => r.filterKey === 'uat_ids')).toBe(true);
        // Should have 2 results
        expect(result.value.results).toHaveLength(2);
      }
    });

    it('includes county context', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'uat',
        query: 'Cluj',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.results[0]?.context).toContain('County: CJ');
      }
    });
  });

  describe('functional_classification category', () => {
    it('returns functional codes with correct filterKey', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'functional_classification',
        query: 'educație',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.results[0]?.filterKey).toBe('functional_codes');
        expect(result.value.results[0]?.context).toContain('COFOG');
      }
    });

    it('uses functional_prefixes for prefix codes', async () => {
      const deps = createFakeDeps({
        functionalClassificationRepo: {
          getAll: async () =>
            ok({
              nodes: [{ functional_code: '65.', functional_name: 'Învățământ', relevance: 0.9 }],
            }),
        },
      });

      const result = await discoverFilters(deps, {
        category: 'functional_classification',
        query: 'învățământ',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.results[0]?.filterKey).toBe('functional_prefixes');
      }
    });
  });

  describe('economic_classification category', () => {
    it('returns economic codes with correct filterKey', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'economic_classification',
        query: 'salarii',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.results[0]?.filterKey).toBe('economic_codes');
        expect(result.value.results[0]?.context).toContain('Economic');
      }
    });
  });

  describe('input validation', () => {
    it('returns error for empty query', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'entity',
        query: '   ',
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.code).toBe('INVALID_INPUT');
      }
    });

    it('clamps limit to maximum', async () => {
      const deps = createFakeDeps();
      const result = await discoverFilters(deps, {
        category: 'entity',
        query: 'test',
        limit: 1000, // Exceeds MAX_FILTER_LIMIT (50)
      });

      expect(result.isOk()).toBe(true);
      // The query should still succeed, limit is clamped internally
    });
  });

  describe('scoring', () => {
    it('sorts results by score descending', async () => {
      const deps = createFakeDeps({
        entityRepo: {
          getAll: async () =>
            ok({
              nodes: [
                { cui: '1', name: 'Low Score', relevance: 0.5 },
                { cui: '2', name: 'High Score', relevance: 0.95 },
                { cui: '3', name: 'Medium Score', relevance: 0.75 },
              ],
            }),
        },
      });

      const result = await discoverFilters(deps, {
        category: 'entity',
        query: 'test',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const scores = result.value.results.map((r) => r.score);
        expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? 0);
        expect(scores[1] ?? 0).toBeGreaterThanOrEqual(scores[2] ?? 0);
      }
    });

    it('boosts score for exact name match', async () => {
      const deps = createFakeDeps({
        entityRepo: {
          getAll: async () =>
            ok({
              nodes: [
                { cui: '1', name: 'Test', relevance: 0.7 },
                { cui: '2', name: 'Testing Something', relevance: 0.7 },
              ],
            }),
        },
      });

      const result = await discoverFilters(deps, {
        category: 'entity',
        query: 'Test',
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // First result should be "Test" (exact match boost)
        expect(result.value.results[0]?.name).toBe('Test');
        expect(result.value.results[0]?.score).toBeGreaterThan(result.value.results[1]?.score ?? 0);
      }
    });
  });
});
