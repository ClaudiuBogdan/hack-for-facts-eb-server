import { Kysely, PostgresDialect, sql } from 'kysely';
import { describe, it, expect } from 'vitest';

import {
  createFilterContext,
  toWhereClause,
  andConditions,
  orConditions,
  escapeLikeWildcards,
  toNumericIds,
  hasValues,
} from '@/infra/database/query-filters/index.js';

// Create a minimal Kysely instance just for compilation (no actual DB connection needed)
const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: null as unknown as never, // We won't execute, just compile
  }),
});

// Helper to compile a RawBuilder to SQL string and parameters
function compileSql(builder: ReturnType<typeof sql>) {
  return builder.compile(db);
}

// ============================================================================
// toWhereClause
// ============================================================================

describe('toWhereClause', () => {
  it('joins conditions with WHERE and AND', () => {
    const cond1 = sql`a = ${1}`;
    const cond2 = sql`b = ${'test'}`;
    const result = toWhereClause([cond1, cond2]);

    expect(result).not.toBeUndefined();
    if (result !== undefined) {
      const compiled = compileSql(result);
      expect(compiled.sql).toBe('WHERE a = $1 AND b = $2');
      expect(compiled.parameters).toEqual([1, 'test']);
    }
  });

  it('returns undefined for empty array', () => {
    expect(toWhereClause([])).toBeUndefined();
  });

  it('handles single condition', () => {
    const cond = sql`x = ${42}`;
    const result = toWhereClause([cond]);

    expect(result).not.toBeUndefined();
    if (result !== undefined) {
      const compiled = compileSql(result);
      expect(compiled.sql).toBe('WHERE x = $1');
      expect(compiled.parameters).toEqual([42]);
    }
  });
});

// ============================================================================
// andConditions
// ============================================================================

describe('andConditions', () => {
  it('joins conditions with AND', () => {
    const cond1 = sql`a = ${1}`;
    const cond2 = sql`b = ${2}`;
    const cond3 = sql`c = ${3}`;
    const result = andConditions([cond1, cond2, cond3]);

    const compiled = compileSql(result);
    expect(compiled.sql).toBe('a = $1 AND b = $2 AND c = $3');
    expect(compiled.parameters).toEqual([1, 2, 3]);
  });

  it('returns TRUE for empty array', () => {
    const result = andConditions([]);
    const compiled = compileSql(result);
    expect(compiled.sql).toBe('TRUE');
    expect(compiled.parameters).toEqual([]);
  });

  it('returns single condition as-is', () => {
    const cond = sql`x = ${42}`;
    const result = andConditions([cond]);
    const compiled = compileSql(result);
    expect(compiled.sql).toBe('x = $1');
    expect(compiled.parameters).toEqual([42]);
  });
});

// ============================================================================
// orConditions
// ============================================================================

describe('orConditions', () => {
  it('joins conditions with OR in parentheses', () => {
    const cond1 = sql`a = ${1}`;
    const cond2 = sql`b = ${2}`;
    const cond3 = sql`c = ${3}`;
    const result = orConditions([cond1, cond2, cond3]);

    const compiled = compileSql(result);
    expect(compiled.sql).toBe('(a = $1 OR b = $2 OR c = $3)');
    expect(compiled.parameters).toEqual([1, 2, 3]);
  });

  it('returns FALSE for empty array', () => {
    const result = orConditions([]);
    const compiled = compileSql(result);
    expect(compiled.sql).toBe('FALSE');
    expect(compiled.parameters).toEqual([]);
  });

  it('returns single condition as-is (no parentheses)', () => {
    const cond = sql`a = ${1}`;
    const result = orConditions([cond]);
    const compiled = compileSql(result);
    expect(compiled.sql).toBe('a = $1');
    expect(compiled.parameters).toEqual([1]);
  });
});

// ============================================================================
// escapeLikeWildcards (LIKE metacharacter escaping, NOT SQL injection prevention)
// ============================================================================

describe('escapeLikeWildcards', () => {
  it('escapes backslashes', () => {
    expect(escapeLikeWildcards('a\\b')).toBe('a\\\\b');
  });

  it('escapes percent signs', () => {
    expect(escapeLikeWildcards('100%')).toBe('100\\%');
  });

  it('escapes underscores', () => {
    expect(escapeLikeWildcards('a_b')).toBe('a\\_b');
  });

  it('handles multiple special characters', () => {
    expect(escapeLikeWildcards('100% test_value\\end')).toBe('100\\% test\\_value\\\\end');
  });

  it('returns unchanged string if no special chars', () => {
    expect(escapeLikeWildcards('normal')).toBe('normal');
  });

  it('does NOT escape single quotes (that is handled by parameterization)', () => {
    // Single quotes are handled by Kysely's parameterization, not by escapeLikeWildcards
    expect(escapeLikeWildcards("it's")).toBe("it's");
  });

  describe('LIKE metacharacter escaping', () => {
    it('prevents wildcard manipulation via %', () => {
      // User trying to match all records with %
      const input = '%';
      expect(escapeLikeWildcards(input)).toBe('\\%');
    });

    it('prevents single-char wildcard manipulation via _', () => {
      const input = '_____';
      expect(escapeLikeWildcards(input)).toBe('\\_\\_\\_\\_\\_');
    });

    it('handles realistic search input with special chars', () => {
      // User searching for "50% off_sale"
      const input = '50% off_sale';
      const escaped = escapeLikeWildcards(input);
      expect(escaped).toBe('50\\% off\\_sale');
    });
  });
});

// ============================================================================
// toNumericIds
// ============================================================================

describe('toNumericIds', () => {
  it('converts string numbers to integers', () => {
    expect(toNumericIds(['1', '2', '3'])).toEqual([1, 2, 3]);
  });

  it('filters out empty strings', () => {
    expect(toNumericIds(['1', '', '2', '   ', '3'])).toEqual([1, 2, 3]);
  });

  it('filters out non-numeric strings', () => {
    expect(toNumericIds(['1', 'abc', '2', 'def'])).toEqual([1, 2]);
  });

  it('handles empty array', () => {
    expect(toNumericIds([])).toEqual([]);
  });

  it('handles decimal strings', () => {
    expect(toNumericIds(['1.5', '2.9'])).toEqual([1.5, 2.9]);
  });
});

// ============================================================================
// hasValues
// ============================================================================

describe('hasValues', () => {
  it('returns true for non-empty array', () => {
    expect(hasValues(['a', 'b'])).toBe(true);
    expect(hasValues([1])).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(hasValues([])).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasValues(undefined)).toBe(false);
  });
});

// ============================================================================
// createFilterContext
// ============================================================================

describe('createFilterContext', () => {
  it('creates context with default values', () => {
    const ctx = createFilterContext();
    expect(ctx.lineItemAlias).toBe('eli');
    expect(ctx.entityAlias).toBe('e');
    expect(ctx.uatAlias).toBe('u');
    expect(ctx.hasEntityJoin).toBe(false);
    expect(ctx.hasUatJoin).toBe(false);
  });

  it('allows overriding individual values', () => {
    const ctx = createFilterContext({
      lineItemAlias: 'items',
      hasEntityJoin: true,
    });
    expect(ctx.lineItemAlias).toBe('items');
    expect(ctx.entityAlias).toBe('e');
    expect(ctx.hasEntityJoin).toBe(true);
    expect(ctx.hasUatJoin).toBe(false);
  });
});

// ============================================================================
// SQL Injection Prevention (via Parameterization)
// ============================================================================

describe('SQL Injection Prevention via Parameterization', () => {
  it('parameterizes values - injection attempt becomes parameter value', () => {
    const malicious = "'; DROP TABLE users; --";
    const cond = sql`account_category = ${malicious}`;

    const compiled = compileSql(cond);

    // The SQL string has a placeholder, not the value
    expect(compiled.sql).toBe('account_category = $1');
    expect(compiled.sql).not.toContain('DROP TABLE');
    // The malicious value is in parameters (sent separately to DB)
    expect(compiled.parameters).toEqual([malicious]);
  });

  it('handles arrays safely with sql.join()', () => {
    const values = ["test'; DROP TABLE;--", 'normal', "' OR '1'='1"];
    const condition = sql`col IN (${sql.join(values)})`;
    const compiled = compileSql(condition);

    expect(compiled.sql).toBe('col IN ($1, $2, $3)');
    expect(compiled.parameters).toEqual(values);
    // No SQL code in the SQL string
    expect(compiled.sql).not.toContain('DROP');
    expect(compiled.sql).not.toContain('OR');
  });

  it('LIKE patterns are parameterized even with wildcards', () => {
    // User searching for something with %
    const searchTerm = '50% off'; // Could be manipulated
    const escaped = escapeLikeWildcards(searchTerm);
    const condition = sql`name LIKE ${escaped + '%'}`;
    const compiled = compileSql(condition);

    expect(compiled.sql).toBe('name LIKE $1');
    expect(compiled.parameters).toEqual(['50\\% off%']);
  });
});
