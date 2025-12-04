import { describe, it, expect } from 'vitest';

import { Frequency } from '@/common/types/temporal.js';
import {
  buildWhereConditions,
  toWhereClause,
  getAmountColumn,
  type AnalyticsSqlFilter,
  type SqlBuildContext,
} from '@/modules/execution-analytics/shell/repo/sql-condition-builder.js';

// ============================================================================
// Test Helpers
// ============================================================================

function createMinimalFilter(overrides: Partial<AnalyticsSqlFilter> = {}): AnalyticsSqlFilter {
  return {
    account_category: 'ch',
    report_period: {
      frequency: Frequency.YEAR,
      selection: { interval: { start: '2024', end: '2024' } },
    },
    ...overrides,
  };
}

function createContext(overrides: Partial<SqlBuildContext> = {}): SqlBuildContext {
  return {
    hasEntityJoin: false,
    hasUatJoin: false,
    ...overrides,
  };
}

// ============================================================================
// getAmountColumn
// ============================================================================

describe('getAmountColumn', () => {
  it('returns monthly_amount for MONTH frequency', () => {
    expect(getAmountColumn(Frequency.MONTH)).toBe('eli.monthly_amount');
  });

  it('returns quarterly_amount for QUARTER frequency', () => {
    expect(getAmountColumn(Frequency.QUARTER)).toBe('eli.quarterly_amount');
  });

  it('returns ytd_amount for YEAR frequency', () => {
    expect(getAmountColumn(Frequency.YEAR)).toBe('eli.ytd_amount');
  });

  it('uses custom alias', () => {
    expect(getAmountColumn(Frequency.MONTH, 'x')).toBe('x.monthly_amount');
    expect(getAmountColumn(Frequency.QUARTER, 'x')).toBe('x.quarterly_amount');
    expect(getAmountColumn(Frequency.YEAR, 'x')).toBe('x.ytd_amount');
  });
});

// ============================================================================
// toWhereClause
// ============================================================================

describe('toWhereClause', () => {
  it('returns empty string for no conditions', () => {
    expect(toWhereClause([])).toBe('');
  });

  it('joins single condition with WHERE', () => {
    expect(toWhereClause(['eli.year = 2024'])).toBe('WHERE eli.year = 2024');
  });

  it('joins multiple conditions with AND', () => {
    const conditions = ['eli.year >= 2020', 'eli.year <= 2024', "eli.account_category = 'ch'"];
    expect(toWhereClause(conditions)).toBe(
      "WHERE eli.year >= 2020 AND eli.year <= 2024 AND eli.account_category = 'ch'"
    );
  });
});

// ============================================================================
// buildWhereConditions - Frequency
// ============================================================================

describe('buildWhereConditions frequency conditions', () => {
  it('adds is_quarterly for QUARTER frequency', () => {
    const filter = createMinimalFilter({
      report_period: {
        frequency: Frequency.QUARTER,
        selection: { interval: { start: '2024-Q1', end: '2024-Q4' } },
      },
    });

    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.is_quarterly = true');
  });

  it('adds is_yearly for YEAR frequency', () => {
    const filter = createMinimalFilter({
      report_period: {
        frequency: Frequency.YEAR,
        selection: { interval: { start: '2024', end: '2024' } },
      },
    });

    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.is_yearly = true');
  });

  it('adds no frequency flag for MONTH frequency', () => {
    const filter = createMinimalFilter({
      report_period: {
        frequency: Frequency.MONTH,
        selection: { interval: { start: '2024-01', end: '2024-12' } },
      },
    });

    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions.some((c) => c.includes('is_quarterly'))).toBe(false);
    expect(conditions.some((c) => c.includes('is_yearly'))).toBe(false);
  });
});

// ============================================================================
// buildWhereConditions - Dimension Filters
// ============================================================================

describe('buildWhereConditions dimension filters', () => {
  it('always includes account_category', () => {
    const filter = createMinimalFilter({ account_category: 'vn' });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.account_category = 'vn'");
  });

  it('adds report_type when present', () => {
    const filter = createMinimalFilter({ report_type: 'initial' });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.report_type = 'initial'");
  });

  it('adds main_creditor_cui when present', () => {
    const filter = createMinimalFilter({ main_creditor_cui: '12345678' });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.main_creditor_cui = '12345678'");
  });

  it('adds report_ids IN clause', () => {
    const filter = createMinimalFilter({ report_ids: ['r1', 'r2', 'r3'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.report_id IN ('r1', 'r2', 'r3')");
  });

  it('adds entity_cuis IN clause', () => {
    const filter = createMinimalFilter({ entity_cuis: ['cui1', 'cui2'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.entity_cui IN ('cui1', 'cui2')");
  });

  it('adds funding_source_ids as numeric IN clause', () => {
    const filter = createMinimalFilter({ funding_source_ids: ['1', '2', '3'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.funding_source_id IN (1, 2, 3)');
  });

  it('adds budget_sector_ids as numeric IN clause', () => {
    const filter = createMinimalFilter({ budget_sector_ids: ['10', '20'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.budget_sector_id IN (10, 20)');
  });

  it('adds expense_types IN clause', () => {
    const filter = createMinimalFilter({ expense_types: ['personal', 'material'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.expense_type IN ('personal', 'material')");
  });
});

// ============================================================================
// buildWhereConditions - Code Filters
// ============================================================================

describe('buildWhereConditions code filters', () => {
  it('adds functional_codes IN clause', () => {
    const filter = createMinimalFilter({ functional_codes: ['51', '54', '61'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.functional_code IN ('51', '54', '61')");
  });

  it('adds functional_prefixes LIKE clause', () => {
    const filter = createMinimalFilter({ functional_prefixes: ['51', '6'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain(
      "(eli.functional_code LIKE '51%' OR eli.functional_code LIKE '6%')"
    );
  });

  it('adds economic_codes IN clause', () => {
    const filter = createMinimalFilter({ economic_codes: ['10', '20', '30'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.economic_code IN ('10', '20', '30')");
  });

  it('adds economic_prefixes LIKE clause', () => {
    const filter = createMinimalFilter({ economic_prefixes: ['10', '2'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("(eli.economic_code LIKE '10%' OR eli.economic_code LIKE '2%')");
  });

  it('adds program_codes IN clause', () => {
    const filter = createMinimalFilter({ program_codes: ['P1', 'P2'] });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.program_code IN ('P1', 'P2')");
  });
});

// ============================================================================
// buildWhereConditions - Geographic Filters
// ============================================================================

describe('buildWhereConditions geographic filters', () => {
  describe('entity filters (requires entity join)', () => {
    it('adds entity_types when hasEntityJoin is true', () => {
      const filter = createMinimalFilter({ entity_types: ['primarie', 'uat'] });
      const ctx = createContext({ hasEntityJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain("e.entity_type IN ('primarie', 'uat')");
    });

    it('adds is_uat when hasEntityJoin is true', () => {
      const filter = createMinimalFilter({ is_uat: true });
      const ctx = createContext({ hasEntityJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain('e.is_uat = true');
    });

    it('adds is_uat false when hasEntityJoin is true', () => {
      const filter = createMinimalFilter({ is_uat: false });
      const ctx = createContext({ hasEntityJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain('e.is_uat = false');
    });

    it('adds uat_ids as numeric IN clause when hasEntityJoin is true', () => {
      const filter = createMinimalFilter({ uat_ids: ['100', '200'] });
      const ctx = createContext({ hasEntityJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain('e.uat_id IN (100, 200)');
    });

    it('does not add entity filters when hasEntityJoin is false', () => {
      const filter = createMinimalFilter({
        entity_types: ['primarie'],
        is_uat: true,
        uat_ids: ['100'],
      });
      const ctx = createContext({ hasEntityJoin: false });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions.some((c) => c.includes('entity_type'))).toBe(false);
      expect(conditions.some((c) => c.includes('is_uat'))).toBe(false);
      expect(conditions.some((c) => c.includes('uat_id'))).toBe(false);
    });
  });

  describe('uat filters (requires uat join)', () => {
    it('adds county_codes when hasUatJoin is true', () => {
      const filter = createMinimalFilter({ county_codes: ['AB', 'CJ'] });
      const ctx = createContext({ hasUatJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain("u.county_code IN ('AB', 'CJ')");
    });

    it('adds min_population when hasUatJoin is true', () => {
      const filter = createMinimalFilter({ min_population: 10000 });
      const ctx = createContext({ hasUatJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain('u.population >= 10000');
    });

    it('adds max_population when hasUatJoin is true', () => {
      const filter = createMinimalFilter({ max_population: 100000 });
      const ctx = createContext({ hasUatJoin: true });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions).toContain('u.population <= 100000');
    });

    it('does not add uat filters when hasUatJoin is false', () => {
      const filter = createMinimalFilter({
        county_codes: ['AB'],
        min_population: 10000,
        max_population: 100000,
      });
      const ctx = createContext({ hasUatJoin: false });
      const conditions = buildWhereConditions(filter, ctx);

      expect(conditions.some((c) => c.includes('county_code'))).toBe(false);
      expect(conditions.some((c) => c.includes('population'))).toBe(false);
    });
  });
});

// ============================================================================
// buildWhereConditions - Amount Filters
// ============================================================================

describe('buildWhereConditions amount filters', () => {
  it('adds item_min_amount for YEAR frequency using ytd_amount', () => {
    const filter = createMinimalFilter({
      item_min_amount: 1000,
      report_period: {
        frequency: Frequency.YEAR,
        selection: { interval: { start: '2024', end: '2024' } },
      },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.ytd_amount >= 1000');
  });

  it('adds item_max_amount for YEAR frequency using ytd_amount', () => {
    const filter = createMinimalFilter({
      item_max_amount: 10000,
      report_period: {
        frequency: Frequency.YEAR,
        selection: { interval: { start: '2024', end: '2024' } },
      },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.ytd_amount <= 10000');
  });

  it('uses monthly_amount for MONTH frequency', () => {
    const filter = createMinimalFilter({
      item_min_amount: 100,
      report_period: {
        frequency: Frequency.MONTH,
        selection: { interval: { start: '2024-01', end: '2024-12' } },
      },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.monthly_amount >= 100');
  });

  it('uses quarterly_amount for QUARTER frequency', () => {
    const filter = createMinimalFilter({
      item_min_amount: 500,
      report_period: {
        frequency: Frequency.QUARTER,
        selection: { interval: { start: '2024-Q1', end: '2024-Q4' } },
      },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain('eli.quarterly_amount >= 500');
  });
});

// ============================================================================
// buildWhereConditions - Exclusion Filters
// ============================================================================

describe('buildWhereConditions exclusion filters', () => {
  it('excludes report_ids with NOT IN', () => {
    const filter = createMinimalFilter({
      exclude: { report_ids: ['r1', 'r2'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.report_id NOT IN ('r1', 'r2')");
  });

  it('excludes entity_cuis with NOT IN', () => {
    const filter = createMinimalFilter({
      exclude: { entity_cuis: ['cui1', 'cui2'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.entity_cui NOT IN ('cui1', 'cui2')");
  });

  it('excludes functional_codes with NOT IN', () => {
    const filter = createMinimalFilter({
      exclude: { functional_codes: ['51', '54'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.functional_code NOT IN ('51', '54')");
  });

  it('excludes functional_prefixes with NOT LIKE', () => {
    const filter = createMinimalFilter({
      exclude: { functional_prefixes: ['51', '6'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain(
      "(eli.functional_code NOT LIKE '51%' AND eli.functional_code NOT LIKE '6%')"
    );
  });

  it('excludes economic_codes for non-vn accounts', () => {
    const filter = createMinimalFilter({
      account_category: 'ch',
      exclude: { economic_codes: ['10', '20'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain("eli.economic_code NOT IN ('10', '20')");
  });

  it('does NOT exclude economic_codes for vn accounts', () => {
    const filter = createMinimalFilter({
      account_category: 'vn',
      exclude: { economic_codes: ['10', '20'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions.some((c) => c.includes('economic_code NOT IN'))).toBe(false);
  });

  it('excludes economic_prefixes for non-vn accounts', () => {
    const filter = createMinimalFilter({
      account_category: 'ch',
      exclude: { economic_prefixes: ['10', '2'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions).toContain(
      "(eli.economic_code NOT LIKE '10%' AND eli.economic_code NOT LIKE '2%')"
    );
  });

  it('does NOT exclude economic_prefixes for vn accounts', () => {
    const filter = createMinimalFilter({
      account_category: 'vn',
      exclude: { economic_prefixes: ['10', '2'] },
    });
    const conditions = buildWhereConditions(filter, createContext());

    expect(conditions.some((c) => c.includes('economic_code NOT LIKE'))).toBe(false);
  });
});

// ============================================================================
// buildWhereConditions - NULL-safe Exclusions
// ============================================================================

describe('buildWhereConditions NULL-safe exclusions', () => {
  it('uses NULL-safe exclusion for entity_types', () => {
    const filter = createMinimalFilter({
      exclude: { entity_types: ['primarie'] },
    });
    const ctx = createContext({ hasEntityJoin: true });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions).toContain("(e.entity_type IS NULL OR e.entity_type NOT IN ('primarie'))");
  });

  it('uses NULL-safe exclusion for uat_ids', () => {
    const filter = createMinimalFilter({
      exclude: { uat_ids: ['100', '200'] },
    });
    const ctx = createContext({ hasEntityJoin: true });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions).toContain('(e.uat_id IS NULL OR e.uat_id NOT IN (100, 200))');
  });

  it('uses NULL-safe exclusion for county_codes', () => {
    const filter = createMinimalFilter({
      exclude: { county_codes: ['AB', 'CJ'] },
    });
    const ctx = createContext({ hasUatJoin: true });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions).toContain("(u.county_code IS NULL OR u.county_code NOT IN ('AB', 'CJ'))");
  });

  it('does not add entity exclusions when hasEntityJoin is false', () => {
    const filter = createMinimalFilter({
      exclude: { entity_types: ['primarie'], uat_ids: ['100'] },
    });
    const ctx = createContext({ hasEntityJoin: false });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions.some((c) => c.includes('entity_type'))).toBe(false);
    expect(conditions.some((c) => c.includes('uat_id'))).toBe(false);
  });

  it('does not add uat exclusions when hasUatJoin is false', () => {
    const filter = createMinimalFilter({
      exclude: { county_codes: ['AB'] },
    });
    const ctx = createContext({ hasUatJoin: false });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions.some((c) => c.includes('county_code'))).toBe(false);
  });
});

// ============================================================================
// buildWhereConditions - Custom Aliases
// ============================================================================

describe('buildWhereConditions custom aliases', () => {
  it('uses custom line item alias', () => {
    const filter = createMinimalFilter();
    const ctx = createContext({ lineItemAlias: 'items' });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions.some((c) => c.startsWith('items.'))).toBe(true);
    expect(conditions.some((c) => c.startsWith('eli.'))).toBe(false);
  });

  it('uses custom entity alias', () => {
    const filter = createMinimalFilter({ entity_types: ['primarie'] });
    const ctx = createContext({ hasEntityJoin: true, entityAlias: 'ent' });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions).toContain("ent.entity_type IN ('primarie')");
  });

  it('uses custom uat alias', () => {
    const filter = createMinimalFilter({ county_codes: ['AB'] });
    const ctx = createContext({ hasUatJoin: true, uatAlias: 'units' });
    const conditions = buildWhereConditions(filter, ctx);

    expect(conditions).toContain("units.county_code IN ('AB')");
  });
});

// ============================================================================
// buildWhereConditions - Integration
// ============================================================================

describe('buildWhereConditions integration', () => {
  it('builds complete query conditions', () => {
    const filter: AnalyticsSqlFilter = {
      account_category: 'ch',
      report_type: 'final',
      report_period: {
        frequency: Frequency.YEAR,
        selection: { interval: { start: '2020', end: '2024' } },
      },
      functional_codes: ['51', '54'],
      entity_types: ['primarie'],
      item_min_amount: 1000,
      exclude: {
        entity_cuis: ['excluded_cui'],
        functional_prefixes: ['99'],
      },
    };
    const ctx = createContext({ hasEntityJoin: true });
    const conditions = buildWhereConditions(filter, ctx);

    // Frequency
    expect(conditions).toContain('eli.is_yearly = true');

    // Dimensions
    expect(conditions).toContain("eli.account_category = 'ch'");
    expect(conditions).toContain("eli.report_type = 'final'");

    // Period
    expect(conditions).toContain('eli.year >= 2020');
    expect(conditions).toContain('eli.year <= 2024');

    // Codes
    expect(conditions).toContain("eli.functional_code IN ('51', '54')");

    // Geographic
    expect(conditions).toContain("e.entity_type IN ('primarie')");

    // Amount
    expect(conditions).toContain('eli.ytd_amount >= 1000');

    // Exclusions
    expect(conditions).toContain("eli.entity_cui NOT IN ('excluded_cui')");
    expect(conditions).toContain("(eli.functional_code NOT LIKE '99%')");
  });

  it('handles empty exclude object', () => {
    const filter = createMinimalFilter({ exclude: {} });
    const conditions = buildWhereConditions(filter, createContext());

    // Should not throw and should have standard conditions
    expect(conditions.length).toBeGreaterThan(0);
    expect(conditions.some((c) => c.includes('NOT IN'))).toBe(false);
  });
});
