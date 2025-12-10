/**
 * Query Builders Security Tests
 *
 * Verifies that the refactored query builders (joinClause, orderByClause, etc.)
 * prevent SQL injection by using parameterized queries or strict validation.
 */

import { Kysely, PostgresDialect } from 'kysely';
import { describe, it, expect } from 'vitest';

import { columnRef } from '@/infra/database/query-builders/columns.js';
import {
  joinClause,
  orderByClause,
  groupByClause,
  CommonOrderBy,
  CommonGroupBy,
  type SortDirection,
  type NullsPosition,
} from '@/infra/database/query-builders/expressions.js';

// ============================================================================
// Test Setup
// ============================================================================

// Create a minimal Kysely instance just for compilation
const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: null as unknown as never,
  }),
});

// ============================================================================
// Test Vectors
// ============================================================================

const INJECTION_VECTOR = "'; DROP TABLE users; --";

// ============================================================================
// Tests
// ============================================================================

describe('Query Builders Security', () => {
  describe('joinClause', () => {
    it('constructs valid JOIN clause safely', () => {
      const result = joinClause('LEFT', 'entities', 'e', 'eli.entity_cui', 'e.cui');
      const compiled = result.compile(db);

      expect(compiled.sql).toBe('LEFT JOIN "entities" e ON "eli"."entity_cui" = "e"."cui"');
    });

    it('rejects invalid join type', () => {
      expect(() => {
        joinClause(INJECTION_VECTOR as any, 'entities', 'e', 'col1', 'col2');
      }).toThrow();
    });
  });

  describe('orderByClause', () => {
    it('constructs valid ORDER BY clause safely', () => {
      const result = orderByClause([
        ['year', 'ASC', 'NULLS LAST'],
        ['amount', 'DESC'],
      ]);
      const compiled = result.compile(db);

      expect(compiled.sql).toBe('ORDER BY "year" ASC NULLS LAST, "amount" DESC NULLS LAST');
    });

    it('rejects invalid sort direction', () => {
      expect(() => {
        orderByClause([['year', INJECTION_VECTOR as SortDirection]]);
      }).toThrow();
    });

    it('rejects invalid nulls position', () => {
      expect(() => {
        orderByClause([['year', 'ASC', INJECTION_VECTOR as NullsPosition]]);
      }).toThrow();
    });

    // Note: The column name is escaped by sql.ref ("col"), so even if we pass weird chars,
    // they become identifiers "weird chars", not SQL.
    it('escapes column names', () => {
      const result = orderByClause([[INJECTION_VECTOR, 'ASC']]);
      const compiled = result.compile(db);

      // Should quote the identifier
      expect(compiled.sql).toContain(`"${INJECTION_VECTOR}"`);
    });
  });

  describe('groupByClause', () => {
    it('constructs valid GROUP BY clause safely', () => {
      const result = groupByClause(['year', 'month']);
      const compiled = result.compile(db);

      expect(compiled.sql).toBe('GROUP BY "year", "month"');
    });

    it('escapes column names', () => {
      const result = groupByClause([INJECTION_VECTOR]);
      const compiled = result.compile(db);

      expect(compiled.sql).toContain(`"${INJECTION_VECTOR}"`);
    });
  });

  describe('CommonOrderBy', () => {
    it('does NOT include ORDER BY prefix (regression test)', () => {
      const result = CommonOrderBy.yearAsc();
      const compiled = result.compile(db);

      // Should just be the expression
      expect(compiled.sql).toBe('eli.year ASC');
      expect(compiled.sql).not.toContain('ORDER BY');
    });
  });

  describe('CommonGroupBy', () => {
    it('does NOT include GROUP BY prefix (regression test)', () => {
      const result = CommonGroupBy.year();
      const compiled = result.compile(db);

      // Should just be the expression
      expect(compiled.sql).toBe('eli.year');
      expect(compiled.sql).not.toContain('GROUP BY');
    });
  });

  describe('columnRef', () => {
    it('validates alias and column', () => {
      // Valid
      expect(() => columnRef('eli', 'year')).not.toThrow();

      // Invalid Alias
      expect(() => columnRef('invalid' as any, 'year')).toThrow();

      // Invalid Column
      expect(() => columnRef('eli', 'invalid_col' as any)).toThrow();
    });
  });
});
