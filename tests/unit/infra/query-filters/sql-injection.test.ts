/**
 * SQL Injection Prevention Tests
 *
 * These tests verify that the query filter builders properly prevent
 * SQL injection attacks through parameterization (NOT through escaping).
 *
 * With Kysely's RawBuilder pattern, user values are NEVER embedded in
 * the SQL string - they are sent as parameters ($1, $2, etc.) that the
 * database handles safely.
 *
 * Test vectors based on OWASP SQL Injection cheat sheet:
 * https://owasp.org/www-community/attacks/SQL_Injection
 */

import { Kysely, PostgresDialect } from 'kysely';
import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  createFilterContext,
  buildDimensionConditions,
  buildCodeConditions,
  buildEntityConditions,
  buildExclusionConditions,
  buildAmountConditions,
  col,
  andConditions,
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

// ============================================================================
// Test Setup
// ============================================================================

// Create a minimal Kysely instance just for compilation (no actual DB connection needed)
const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: null as unknown as never, // We won't execute, just compile
  }),
});

const defaultCtx = createFilterContext({
  hasEntityJoin: true,
  hasUatJoin: true,
});

// Helper to compile conditions to SQL string for assertions
function compileConditions(conditions: SqlCondition[]): {
  sql: string;
  parameters: readonly unknown[];
} {
  const combined = andConditions(conditions);
  return combined.compile(db);
}

// ============================================================================
// SQL Injection Test Vectors
// ============================================================================

const INJECTION_VECTORS = {
  // Classic SQL injection
  basicInjection: "'; DROP TABLE users; --",
  orBypass: "' OR '1'='1",
  unionSelect: "' UNION SELECT * FROM passwords --",
  commentInjection: "admin'--",

  // LIKE pattern manipulation
  wildcardAll: '%',
  wildcardSingle: '_____',

  // Escape sequence attacks
  backslashEscape: "test\\' OR 1=1",
  doubleQuote: 'test"\'injection',

  // Unicode/encoding attacks
  nullByte: "test\x00'; DROP TABLE",
};

// ============================================================================
// Identifier Injection Hardening
// ============================================================================

describe('Identifier Injection Hardening', () => {
  it('rejects invalid table alias in col()', () => {
    const maliciousAlias = 'eli; DROP TABLE users; --';

    expect(() => col(maliciousAlias as unknown as never, 'year' as unknown as never)).toThrow(
      /Invalid table alias/
    );
  });

  it('rejects invalid column name in col()', () => {
    const maliciousColumn = 'year; DROP TABLE users; --';

    expect(() => col('eli', maliciousColumn as unknown as never)).toThrow(/Invalid column name/);
  });
});

// ============================================================================
// buildDimensionConditions Tests
// ============================================================================

describe('buildDimensionConditions - SQL Injection Prevention via Parameterization', () => {
  it('parameterizes account_category - injection attempt becomes a harmless parameter value', () => {
    const filter = {
      account_category: INJECTION_VECTORS.basicInjection,
    };

    const conditions = buildDimensionConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should NOT contain the malicious value - only parameter placeholder
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.sql).not.toContain(INJECTION_VECTORS.basicInjection);
    expect(compiled.sql).toContain('account_category = $');

    // The malicious value is safely in parameters, sent separately to DB
    expect(compiled.parameters).toContain(INJECTION_VECTORS.basicInjection);
  });

  it('parameterizes report_type - OR bypass attempt is just a string value', () => {
    const filter = {
      account_category: 'ch',
      report_type: INJECTION_VECTORS.orBypass,
    };

    const conditions = buildDimensionConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should NOT contain the injection attempt
    expect(compiled.sql).not.toContain("OR '1'='1");
    expect(compiled.sql).toContain('report_type = $');

    // Value is safely in parameters
    expect(compiled.parameters).toContain(INJECTION_VECTORS.orBypass);
  });

  it('parameterizes main_creditor_cui - UNION SELECT becomes parameter', () => {
    const filter = {
      account_category: 'ch',
      main_creditor_cui: INJECTION_VECTORS.unionSelect,
    };

    const conditions = buildDimensionConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should NOT contain UNION SELECT
    expect(compiled.sql).not.toContain('UNION SELECT');
    expect(compiled.parameters).toContain(INJECTION_VECTORS.unionSelect);
  });
});

// ============================================================================
// buildCodeConditions Tests
// ============================================================================

describe('buildCodeConditions - SQL Injection Prevention via Parameterization', () => {
  it('parameterizes functional_prefixes - injection in LIKE pattern', () => {
    const filter = {
      functional_prefixes: [INJECTION_VECTORS.basicInjection],
    };

    const conditions = buildCodeConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should NOT contain the malicious value
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.sql).toContain('LIKE $');

    // Value should be in parameters (with % appended for LIKE)
    const likeParam = compiled.parameters.find(
      (p) => typeof p === 'string' && p.includes('DROP TABLE')
    );
    expect(likeParam).toBeDefined();
  });

  it('escapes LIKE wildcards to prevent matching all records', () => {
    const filter = {
      functional_prefixes: [INJECTION_VECTORS.wildcardAll],
    };

    const conditions = buildCodeConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // The % from user input should be escaped
    const likeParam = compiled.parameters[0] as string;
    expect(likeParam).toContain('\\%');
    // It should have the search % at the end
    expect(likeParam.endsWith('%')).toBe(true);
  });

  it('escapes underscores in LIKE patterns', () => {
    const filter = {
      economic_prefixes: [INJECTION_VECTORS.wildcardSingle],
    };

    const conditions = buildCodeConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // Underscores should be escaped
    const likeParam = compiled.parameters[0] as string;
    expect(likeParam).toContain('\\_');
  });

  it('parameterizes functional_codes array values', () => {
    const filter = {
      functional_codes: [INJECTION_VECTORS.basicInjection, 'normal'],
    };

    const conditions = buildCodeConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should have IN clause with parameter placeholders
    expect(compiled.sql).toContain('IN');
    expect(compiled.sql).not.toContain('DROP TABLE');

    // Both values should be in parameters
    expect(compiled.parameters).toContain(INJECTION_VECTORS.basicInjection);
    expect(compiled.parameters).toContain('normal');
  });
});

// ============================================================================
// buildEntityConditions Tests
// ============================================================================

describe('buildEntityConditions - SQL Injection Prevention via Parameterization', () => {
  it('parameterizes search filter - injection becomes search string', () => {
    const filter = {
      search: INJECTION_VECTORS.basicInjection,
    };

    const conditions = buildEntityConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should NOT contain the injection
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.sql).toContain('ILIKE $');

    // Value is in parameters (wrapped with %)
    const likeParam = compiled.parameters[0] as string;
    expect(likeParam).toContain('DROP TABLE');
    expect(likeParam.startsWith('%')).toBe(true);
    expect(likeParam.endsWith('%')).toBe(true);
  });

  it('escapes LIKE wildcards in search', () => {
    const filter = {
      search: INJECTION_VECTORS.wildcardAll,
    };

    const conditions = buildEntityConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // The % should be escaped in the parameter
    const likeParam = compiled.parameters[0] as string;
    expect(likeParam).toContain('\\%');
  });

  it('handles is_uat boolean safely - only allows true/false values', () => {
    const filter = {
      is_uat: true,
    };

    const conditions = buildEntityConditions(filter, defaultCtx);
    const compiled = compileConditions(conditions);

    // Boolean may be inlined (TRUE/FALSE) or parameterized - both are safe
    // since the TypeScript type ensures only boolean values
    expect(compiled.sql).toContain('is_uat = ');
    expect(compiled.sql).toMatch(/is_uat = (TRUE|FALSE|\$\d+)/);
  });
});

// ============================================================================
// buildExclusionConditions Tests
// ============================================================================

describe('buildExclusionConditions - SQL Injection Prevention via Parameterization', () => {
  it('parameterizes functional_prefixes exclusion', () => {
    const exclude = {
      functional_prefixes: [INJECTION_VECTORS.basicInjection],
    };

    const conditions = buildExclusionConditions(exclude, 'ch', defaultCtx);
    const compiled = compileConditions(conditions);

    // SQL should have NOT LIKE with parameter placeholder
    expect(compiled.sql).toContain('NOT LIKE');
    expect(compiled.sql).not.toContain('DROP TABLE');

    // Value is in parameters
    const likeParam = compiled.parameters.find(
      (p) => typeof p === 'string' && p.includes('DROP TABLE')
    );
    expect(likeParam).toBeDefined();
  });

  it('escapes LIKE wildcards in exclusion prefixes', () => {
    const exclude = {
      economic_prefixes: [INJECTION_VECTORS.wildcardAll, INJECTION_VECTORS.wildcardSingle],
    };

    const conditions = buildExclusionConditions(exclude, 'ch', defaultCtx);
    const compiled = compileConditions(conditions);

    // Parameters should have escaped wildcards
    const params = compiled.parameters as string[];
    expect(params.some((p) => p.includes('\\%'))).toBe(true);
    expect(params.some((p) => p.includes('\\_'))).toBe(true);
  });
});

// ============================================================================
// buildAmountConditions Tests
// ============================================================================

describe('buildAmountConditions - Numeric Validation & Parameterization', () => {
  it('accepts valid finite numbers and parameterizes them', () => {
    const filter = {
      item_min_amount: 1000,
      item_max_amount: 5000,
    };

    const conditions = buildAmountConditions(filter, Frequency.YEAR, defaultCtx);
    const compiled = compileConditions(conditions);

    expect(conditions).toHaveLength(2);
    expect(compiled.sql).toContain('>= $');
    expect(compiled.sql).toContain('<= $');
    expect(compiled.parameters).toContain(1000);
    expect(compiled.parameters).toContain(5000);
  });

  it('rejects Infinity', () => {
    const filter = {
      item_min_amount: Infinity,
      item_max_amount: 5000,
    };

    const conditions = buildAmountConditions(filter, Frequency.YEAR, defaultCtx);

    // Infinity should be filtered out
    expect(conditions).toHaveLength(1);

    const compiled = compileConditions(conditions);
    expect(compiled.parameters).toContain(5000);
    expect(compiled.parameters).not.toContain(Infinity);
  });

  it('rejects NaN', () => {
    const filter = {
      item_min_amount: NaN,
      item_max_amount: NaN,
    };

    const conditions = buildAmountConditions(filter, Frequency.YEAR, defaultCtx);

    // NaN values should be filtered out
    expect(conditions).toHaveLength(0);
  });

  it('handles negative numbers correctly', () => {
    const filter = {
      item_min_amount: -1000,
    };

    const conditions = buildAmountConditions(filter, Frequency.YEAR, defaultCtx);
    const compiled = compileConditions(conditions);

    expect(conditions).toHaveLength(1);
    expect(compiled.parameters).toContain(-1000);
  });

  it('handles decimal numbers correctly', () => {
    const filter = {
      item_min_amount: 1000.5,
    };

    const conditions = buildAmountConditions(filter, Frequency.YEAR, defaultCtx);
    const compiled = compileConditions(conditions);

    expect(conditions).toHaveLength(1);
    expect(compiled.parameters).toContain(1000.5);
  });
});

// ============================================================================
// Integration: Full Filter Pipeline
// ============================================================================

describe('Full Filter Pipeline - SQL Injection Prevention', () => {
  it('all injection attempts are parameterized, never in SQL string', () => {
    // Simulate an attacker providing malicious values for every field
    const maliciousFilter = {
      account_category: INJECTION_VECTORS.basicInjection,
      report_type: INJECTION_VECTORS.orBypass,
      main_creditor_cui: INJECTION_VECTORS.unionSelect,
      functional_prefixes: [INJECTION_VECTORS.wildcardAll],
      economic_prefixes: [INJECTION_VECTORS.backslashEscape],
      search: INJECTION_VECTORS.commentInjection,
    };

    // Build all conditions
    const dimensionConditions = buildDimensionConditions(
      {
        account_category: maliciousFilter.account_category,
        report_type: maliciousFilter.report_type,
        main_creditor_cui: maliciousFilter.main_creditor_cui,
      },
      defaultCtx
    );

    const codeConditions = buildCodeConditions(
      {
        functional_prefixes: maliciousFilter.functional_prefixes,
        economic_prefixes: maliciousFilter.economic_prefixes,
      },
      defaultCtx
    );

    const entityConditions = buildEntityConditions(
      {
        search: maliciousFilter.search,
      },
      defaultCtx
    );

    // Compile all conditions
    const allConditions = [...dimensionConditions, ...codeConditions, ...entityConditions];
    const compiled = compileConditions(allConditions);

    // Verify SQL does NOT contain any injection payloads
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.sql).not.toContain('UNION SELECT');
    expect(compiled.sql).not.toContain("OR '1'='1");
    expect(compiled.sql).not.toContain('--');

    // SQL should only have parameter placeholders
    expect(compiled.sql).toMatch(/\$\d+/); // Contains $1, $2, etc.

    // All malicious values should be safely in parameters
    expect(compiled.parameters).toContain(INJECTION_VECTORS.basicInjection);
    expect(compiled.parameters).toContain(INJECTION_VECTORS.orBypass);
    expect(compiled.parameters).toContain(INJECTION_VECTORS.unionSelect);
    // Search and prefix values are modified (wrapped with %)
    const searchParam = compiled.parameters.find(
      (p) => typeof p === 'string' && p.includes("admin'--")
    );
    expect(searchParam).toBeDefined();
  });
});
