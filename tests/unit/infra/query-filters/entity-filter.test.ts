import { Kysely, PostgresDialect } from 'kysely';
import { describe, it, expect } from 'vitest';

import {
  needsEntityJoin,
  needsUatJoin,
  buildEntityConditions,
  buildUatConditions,
  createFilterContext,
  andConditions,
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

// Create a minimal Kysely instance just for compilation (no actual DB connection needed)
const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: null as unknown as never, // We won't execute, just compile
  }),
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
// needsEntityJoin
// ============================================================================

describe('needsEntityJoin', () => {
  it('returns false for empty filter', () => {
    expect(needsEntityJoin({})).toBe(false);
  });

  it('returns true when entity_types is set', () => {
    expect(needsEntityJoin({ entity_types: ['admin_county_council'] })).toBe(true);
  });

  it('returns true when is_uat is explicitly set', () => {
    expect(needsEntityJoin({ is_uat: true })).toBe(true);
    expect(needsEntityJoin({ is_uat: false })).toBe(true);
  });

  it('returns true when uat_ids is set', () => {
    expect(needsEntityJoin({ uat_ids: ['123'] })).toBe(true);
  });

  it('returns true when county_codes is set', () => {
    expect(needsEntityJoin({ county_codes: ['AB'] })).toBe(true);
  });

  it('returns true when search is set (non-empty)', () => {
    expect(needsEntityJoin({ search: 'bucuresti' })).toBe(true);
    expect(needsEntityJoin({ search: '' })).toBe(false);
    expect(needsEntityJoin({ search: '   ' })).toBe(false);
  });

  it('returns true when population filters are set', () => {
    expect(needsEntityJoin({ min_population: 10000 })).toBe(true);
    expect(needsEntityJoin({ max_population: 100000 })).toBe(true);
    expect(needsEntityJoin({ min_population: null })).toBe(false);
    expect(needsEntityJoin({ max_population: null })).toBe(false);
  });

  it('returns true when exclude.entity_types is set', () => {
    expect(needsEntityJoin({ exclude: { entity_types: ['admin_county_council'] } })).toBe(true);
  });

  it('returns true when exclude.uat_ids is set', () => {
    expect(needsEntityJoin({ exclude: { uat_ids: ['123'] } })).toBe(true);
  });

  it('returns true when exclude.county_codes is set', () => {
    expect(needsEntityJoin({ exclude: { county_codes: ['AB'] } })).toBe(true);
  });

  it('returns false for empty arrays', () => {
    expect(needsEntityJoin({ entity_types: [] })).toBe(false);
    expect(needsEntityJoin({ uat_ids: [] })).toBe(false);
    expect(needsEntityJoin({ exclude: { entity_types: [] } })).toBe(false);
  });
});

// ============================================================================
// needsUatJoin
// ============================================================================

describe('needsUatJoin', () => {
  it('returns false for empty filter', () => {
    expect(needsUatJoin({})).toBe(false);
  });

  it('returns true when county_codes is set', () => {
    expect(needsUatJoin({ county_codes: ['AB'] })).toBe(true);
  });

  it('returns true when regions is set', () => {
    expect(needsUatJoin({ regions: ['CENTRU'] })).toBe(true);
  });

  it('returns true when population filters are set', () => {
    expect(needsUatJoin({ min_population: 10000 })).toBe(true);
    expect(needsUatJoin({ max_population: 100000 })).toBe(true);
  });

  it('returns true when exclude.county_codes is set', () => {
    expect(needsUatJoin({ exclude: { county_codes: ['AB'] } })).toBe(true);
  });

  it('returns true when exclude.regions is set', () => {
    expect(needsUatJoin({ exclude: { regions: ['CENTRU'] } })).toBe(true);
  });

  it('returns false for empty arrays', () => {
    expect(needsUatJoin({ county_codes: [] })).toBe(false);
    expect(needsUatJoin({ regions: [] })).toBe(false);
  });

  it('returns false when population is null', () => {
    expect(needsUatJoin({ min_population: null, max_population: null })).toBe(false);
  });
});

// ============================================================================
// buildEntityConditions
// ============================================================================

describe('buildEntityConditions', () => {
  const ctx = createFilterContext({ hasEntityJoin: true });

  it('builds entity_types IN condition', () => {
    const conditions = buildEntityConditions(
      { entity_types: ['admin_county_council', 'uat'] },
      ctx
    );
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('e.entity_type IN');
    expect(compiled.parameters).toContain('admin_county_council');
    expect(compiled.parameters).toContain('uat');
  });

  it('builds is_uat condition', () => {
    const trueConditions = buildEntityConditions({ is_uat: true }, ctx);
    const falseConditions = buildEntityConditions({ is_uat: false }, ctx);

    const trueCompiled = compileConditions(trueConditions);
    const falseCompiled = compileConditions(falseConditions);

    // Booleans are safe to inline (no user input risk), so may be TRUE/FALSE or parameterized
    expect(trueCompiled.sql).toContain('e.is_uat = ');
    expect(trueCompiled.sql).toMatch(/is_uat = (TRUE|\$)/);
    expect(falseCompiled.sql).toContain('e.is_uat = ');
    expect(falseCompiled.sql).toMatch(/is_uat = (FALSE|\$)/);
  });

  it('builds uat_ids IN condition', () => {
    const conditions = buildEntityConditions({ uat_ids: ['123', '456'] }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('e.uat_id IN');
    expect(compiled.parameters).toContain(123);
    expect(compiled.parameters).toContain(456);
  });

  it('builds search ILIKE condition', () => {
    const conditions = buildEntityConditions({ search: 'bucuresti' }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('e.name ILIKE');
    expect(compiled.parameters).toContain('%bucuresti%');
  });

  it('escapes LIKE wildcards in search', () => {
    const conditions = buildEntityConditions({ search: '100% off' }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('e.name ILIKE');
    // The % in user input should be escaped
    expect(compiled.parameters[0]).toContain('\\%');
  });

  it('trims search string', () => {
    const conditions = buildEntityConditions({ search: '  bucuresti  ' }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.parameters).toContain('%bucuresti%');
  });

  it('skips empty search', () => {
    expect(buildEntityConditions({ search: '' }, ctx)).toEqual([]);
    expect(buildEntityConditions({ search: '   ' }, ctx)).toEqual([]);
  });

  it('uses custom alias from context', () => {
    const customCtx = createFilterContext({ entityAlias: 'ent', hasEntityJoin: true });
    const conditions = buildEntityConditions({ is_uat: true }, customCtx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('ent.is_uat');
  });
});

// ============================================================================
// buildUatConditions
// ============================================================================

describe('buildUatConditions', () => {
  const ctx = createFilterContext({ hasUatJoin: true });

  it('builds county_codes IN condition', () => {
    const conditions = buildUatConditions({ county_codes: ['AB', 'CJ'] }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('u.county_code IN');
    expect(compiled.parameters).toContain('AB');
    expect(compiled.parameters).toContain('CJ');
  });

  it('builds regions IN condition', () => {
    const conditions = buildUatConditions({ regions: ['CENTRU', 'NORD_VEST'] }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('u.region IN');
    expect(compiled.parameters).toContain('CENTRU');
    expect(compiled.parameters).toContain('NORD_VEST');
  });

  it('builds min_population condition', () => {
    const conditions = buildUatConditions({ min_population: 10000 }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('u.population >= $');
    expect(compiled.parameters).toContain(10000);
  });

  it('builds max_population condition', () => {
    const conditions = buildUatConditions({ max_population: 100000 }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('u.population <= $');
    expect(compiled.parameters).toContain(100000);
  });

  it('skips null population values', () => {
    const conditions = buildUatConditions({ min_population: null, max_population: null }, ctx);
    expect(conditions).toEqual([]);
  });

  it('uses custom alias from context', () => {
    const customCtx = createFilterContext({ uatAlias: 'uats', hasUatJoin: true });
    const conditions = buildUatConditions({ min_population: 10000 }, customCtx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('uats.population');
  });
});
