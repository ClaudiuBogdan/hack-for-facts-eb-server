import { Kysely, PostgresDialect, sql } from 'kysely';
import { describe, it, expect } from 'vitest';

// Create a minimal Kysely instance just for compilation
const db = new Kysely<any>({
  dialect: new PostgresDialect({
    pool: null as any, // We won't execute, just compile
  }),
});

describe('Kysely RawBuilder Parameterization', () => {
  it('parameterizes values in sql template', () => {
    const malicious = "'; DROP TABLE users; --";
    const condition = sql`account_category = ${malicious}`;

    const compiled = condition.compile(db);

    // The SQL should have a parameter placeholder, not the value
    expect(compiled.sql).toContain('$1');
    expect(compiled.sql).not.toContain('DROP TABLE');
    expect(compiled.parameters).toContain(malicious);
  });

  it('composes RawBuilders without sql.raw()', () => {
    const cond1 = sql`a = ${1}`;
    const cond2 = sql`b = ${'test'}`;
    const combined = sql.join([cond1, cond2], sql` AND `);

    // Embed in larger query - NO sql.raw() needed!
    const query = sql`SELECT * FROM t WHERE ${combined}`;
    const compiled = query.compile(db);

    expect(compiled.sql).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(compiled.parameters).toEqual([1, 'test']);
  });

  it('handles arrays with sql.join()', () => {
    const values = ['a', 'b', 'c'];
    const condition = sql`col IN (${sql.join(values)})`;
    const compiled = condition.compile(db);

    expect(compiled.sql).toBe('col IN ($1, $2, $3)');
    expect(compiled.parameters).toEqual(['a', 'b', 'c']);
  });

  it('sql.raw() for identifiers is safe when trusted', () => {
    const alias = 'eli'; // Trusted internal value
    const userValue = "'; DROP TABLE; --"; // Untrusted user value

    // Identifier via sql.raw (trusted), value parameterized
    const condition = sql`${sql.raw(`${alias}.account_category`)} = ${userValue}`;
    const compiled = condition.compile(db);

    expect(compiled.sql).toBe('eli.account_category = $1');
    expect(compiled.parameters).toEqual([userValue]);
  });

  it('LIKE patterns are parameterized', () => {
    const prefix = '65.'; // User input for prefix search
    const condition = sql`functional_code LIKE ${prefix + '%'}`;
    const compiled = condition.compile(db);

    expect(compiled.sql).toBe('functional_code LIKE $1');
    expect(compiled.parameters).toEqual(['65.%']);
  });

  it('demonstrates the architecture change', () => {
    // OLD: Returns strings (requires manual escaping)
    function oldBuildCondition(value: string): string {
      return `account_category = '${value.replace(/'/g, "''")}'`; // Manual escape
    }

    // NEW: Returns RawBuilder (automatic parameterization)
    function newBuildCondition(value: string) {
      return sql`account_category = ${value}`; // Auto-parameterized
    }

    const malicious = "'; DROP TABLE; --";

    // Old way: SQL string with escaped value inline
    const oldResult = oldBuildCondition(malicious);
    expect(oldResult).toContain("''"); // Escaped quotes in SQL string

    // New way: Parameterized query
    const newResult = newBuildCondition(malicious);
    const compiled = newResult.compile(db);
    expect(compiled.sql).toBe('account_category = $1');
    expect(compiled.parameters).toEqual([malicious]);
    // Value is NEVER in the SQL string - it's in parameters
  });
});
