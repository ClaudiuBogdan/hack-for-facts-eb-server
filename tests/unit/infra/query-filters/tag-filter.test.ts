/**
 * Faceted tag filter — compiled-SQL assertions.
 *
 * These pin the OPERATOR SHAPE, not row counts: `entities.tags` is a jsonb
 * array of `{tag, ruleId, confidence}` OBJECTS, and the known silent failure is
 * a type-correct predicate that matches nothing (`@> to_jsonb(ARRAY[...])`
 * returned 0 rows for every tag against live data while the object form
 * returned 364 for kind::hospital). A row-count test against a tagless fixture
 * would pass just as happily.
 */
import { Kysely, PostgresDialect } from 'kysely';
import { describe, it, expect } from 'vitest';

import {
  needsEntityJoin,
  buildEntityConditions,
  buildTagConditions,
  buildTagExclusionCondition,
  assertValidTagFilter,
  buildExclusionConditions,
  createFilterContext,
  andConditions,
  type SqlCondition,
} from '@/infra/database/query-filters/index.js';

const db = new Kysely<unknown>({
  dialect: new PostgresDialect({
    pool: null as unknown as never, // compile only, never executes
  }),
});

function compileConditions(conditions: SqlCondition[]): {
  sql: string;
  parameters: readonly unknown[];
} {
  const combined = andConditions(conditions);
  return combined.compile(db);
}

// ============================================================================
// Predicate shape
// ============================================================================

describe('buildTagConditions — predicate shape', () => {
  it('binds the containment document as a jsonb-cast parameter, never inline', () => {
    const compiled = compileConditions(buildTagConditions(['kind::hospital']));
    expect(compiled.sql).toContain('@>');
    expect(compiled.sql).toContain('::jsonb');
    // The tag value must ride in the parameter list, not the SQL text.
    expect(compiled.sql).not.toContain('kind::hospital');
    expect(compiled.parameters).toEqual(['[{"tag":"kind::hospital"}]']);
  });

  it('builds an ARRAY-OF-OBJECTS document, not a scalar array', () => {
    // `tags @> '["kind::hospital"]'` is type-correct jsonb that silently
    // matches nothing against an array of objects.
    const compiled = compileConditions(buildTagConditions(['kind::hospital']));
    expect(compiled.parameters[0]).toBe(JSON.stringify([{ tag: 'kind::hospital' }]));
  });

  it('ORs tags within one facet', () => {
    const compiled = compileConditions(buildTagConditions(['kind::hospital', 'kind::clinic']));
    expect(compiled.sql).toMatch(/@> \$1::jsonb OR .*@> \$2::jsonb/);
    expect(compiled.parameters).toEqual(['[{"tag":"kind::hospital"}]', '[{"tag":"kind::clinic"}]']);
  });

  it('ANDs across facets: one condition per facet', () => {
    const conditions = buildTagConditions([
      'kind::hospital',
      'kind::clinic',
      'level::local',
      'sector::health',
    ]);
    expect(conditions).toHaveLength(3); // kind (OR-group), level, sector
    const compiled = compileConditions(conditions);
    // andConditions joins with AND; the kind group is parenthesized.
    expect(compiled.sql).toContain(' AND ');
    expect(compiled.sql).toMatch(/\(.*OR.*\)/);
  });

  it('never emits EXISTS/jsonb_array_elements (not servable by the jsonb_path_ops GIN index)', () => {
    const compiled = compileConditions(
      buildTagConditions(['kind::hospital', 'kind::clinic', 'level::local'])
    );
    expect(compiled.sql.toLowerCase()).not.toContain('exists');
    expect(compiled.sql.toLowerCase()).not.toContain('jsonb_array_elements');
    expect(compiled.sql.toLowerCase()).not.toContain('like');
  });

  it('deduplicates repeated tags', () => {
    const compiled = compileConditions(buildTagConditions(['kind::hospital', 'kind::hospital']));
    expect(compiled.parameters).toEqual(['[{"tag":"kind::hospital"}]']);
  });

  it('returns no conditions for undefined or empty input', () => {
    expect(buildTagConditions(undefined)).toEqual([]);
    expect(buildTagConditions([])).toEqual([]);
  });

  it('accepts a three-segment hierarchical tag', () => {
    const compiled = compileConditions(buildTagConditions(['kind::school::gymnasium']));
    expect(compiled.parameters).toEqual(['[{"tag":"kind::school::gymnasium"}]']);
  });
});

// ============================================================================
// Malformed tags are rejected, not dropped
// ============================================================================

describe('malformed tag rejection', () => {
  it.each([
    'kind', // no namespace separator
    'Kind::Hospital', // uppercase
    'kind::', // empty value
    '::hospital', // empty namespace
    'kind::hospital::a::b', // too deep
    "kind::x' OR 1=1 --", // injection shape
    'kind::hôpital', // non-ascii
    'kind:: hospital', // whitespace
  ])('throws on %j instead of silently widening the result set', (bad) => {
    expect(() => buildTagConditions([bad])).toThrow(/Invalid tags filter value/);
    expect(() => buildTagExclusionCondition([bad])).toThrow(/Invalid tags filter value/);
    expect(() => {
      assertValidTagFilter([bad]);
    }).toThrow(/Invalid tags filter value/);
  });

  it('rejects the whole call even when only one tag of several is malformed', () => {
    expect(() => buildTagConditions(['kind::hospital', 'BAD TAG'])).toThrow(
      /Invalid tags filter value 'BAD TAG'/
    );
  });
});

// ============================================================================
// Exclusion twin
// ============================================================================

describe('buildTagExclusionCondition', () => {
  it('is NULL-safe: preserves LEFT-joined rows with no entity row', () => {
    const condition = buildTagExclusionCondition(['role::control']);
    expect(condition).toBeDefined();
    const compiled = compileConditions([condition!]);
    expect(compiled.sql).toContain('IS NULL OR NOT');
    expect(compiled.parameters).toEqual(['[{"tag":"role::control"}]']);
  });

  it('excludes on ANY match — flat OR, no facet grouping', () => {
    const condition = buildTagExclusionCondition(['kind::hospital', 'level::central']);
    const compiled = compileConditions([condition!]);
    expect(compiled.sql).toMatch(/NOT \(.*OR.*\)/);
  });

  it('returns undefined for undefined or empty input', () => {
    expect(buildTagExclusionCondition(undefined)).toBeUndefined();
    expect(buildTagExclusionCondition([])).toBeUndefined();
  });
});

// ============================================================================
// Integration with the shared builders
// ============================================================================

describe('shared builder integration', () => {
  it('needsEntityJoin turns on for tags and exclude.tags, off for empty arrays', () => {
    expect(needsEntityJoin({ tags: ['kind::hospital'] })).toBe(true);
    expect(needsEntityJoin({ exclude: { tags: ['kind::hospital'] } })).toBe(true);
    expect(needsEntityJoin({ tags: [] })).toBe(false);
    expect(needsEntityJoin({ exclude: { tags: [] } })).toBe(false);
  });

  it('buildEntityConditions includes the tag predicate', () => {
    const ctx = createFilterContext({ hasEntityJoin: true });
    const conditions = buildEntityConditions({ tags: ['kind::hospital'] }, ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('@>');
    expect(compiled.parameters).toContain('[{"tag":"kind::hospital"}]');
  });

  it('is_uat stays an independent predicate next to tags — the map depends on it', () => {
    // is_uat is its own column, written by the classifier; the tag engine only
    // READS it. A tags filter must never replace, imply, or suppress the
    // is_uat condition.
    const ctx = createFilterContext({ hasEntityJoin: true });
    const conditions = buildEntityConditions(
      { is_uat: true, tags: ['uat::commune', 'kind::uat'] },
      ctx
    );
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('is_uat = TRUE');
    expect(compiled.sql).toContain('@>');
    // Three independent AND-ed conditions: is_uat + one per facet (uat, kind).
    expect(conditions).toHaveLength(3);
  });

  it('buildExclusionConditions includes the tag exclusion when the entity join is on', () => {
    const ctx = createFilterContext({ hasEntityJoin: true });
    const conditions = buildExclusionConditions({ tags: ['kind::hospital'] }, 'ch', ctx);
    const compiled = compileConditions(conditions);
    expect(compiled.sql).toContain('IS NULL OR NOT');
  });

  it('buildExclusionConditions omits the tag exclusion without the entity join', () => {
    // Callers gate the join on needsEntityJoin, which covers exclude.tags —
    // this asserts the builder itself never references a missing alias.
    const ctx = createFilterContext({ hasEntityJoin: false });
    const conditions = buildExclusionConditions({ tags: ['kind::hospital'] }, 'ch', ctx);
    expect(conditions).toEqual([]);
  });
});
