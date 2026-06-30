/**
 * Companies unit tests — filter spec → SQL/SDL/TypeBox compilation + canonical
 * hash, the virtual-field split, the §13-R1 is_active drop, and the no-value-sort
 * contract (§13-R3).
 */

import { describe, expect, it } from 'vitest';

import {
  COMPANY_AGGREGATE_DRIVING_FIELDS,
  COMPANY_VIRTUAL_FIELDS,
  companiesFilterSpec,
} from '@/modules/companies/core/filters.js';
import {
  normalizeCountyNeedle,
  splitVirtual,
} from '@/modules/companies/shell/repo/filter-helpers.js';
import {
  canonicalizeFilters,
  fhashFor,
  toConditionBuilders,
  toGraphQLInput,
  toTypeBox,
} from '@/modules/shared/index.js';

describe('companies filter spec', () => {
  it('sort excludes value sorts (turnover/employees) — §13-R3', () => {
    expect(companiesFilterSpec.sort.allowed).toEqual(['name', 'registrationDate', 'cui']);
    expect(companiesFilterSpec.sort.allowed).not.toContain('turnover');
    expect(companiesFilterSpec.sort.allowed).not.toContain('employees');
  });

  it('exposes declaredFiscallyInactive (is_inactive); never an is_active field', () => {
    const names = companiesFilterSpec.fields.map((f) => f.name);
    expect(names).toContain('declaredFiscallyInactive');
    expect(names).not.toContain('isActive');
    const inactive = companiesFilterSpec.fields.find((f) => f.name === 'declaredFiscallyInactive');
    expect(inactive?.column.column).toBe('is_inactive');
    // No field drives off the is_active column.
    expect(companiesFilterSpec.fields.some((f) => f.column.column === 'is_active')).toBe(false);
  });

  it('county drives off v2 selected_county_name; mandatory isNull on registrationDatePresent', () => {
    const county = companiesFilterSpec.fields.find((f) => f.name === 'county');
    expect(county?.column.column).toBe('selected_county_name');
    const present = companiesFilterSpec.fields.find((f) => f.name === 'registrationDatePresent');
    expect(present?.ops).toContain('isNull');
  });

  it('caenCode supports a sargable prefix op (CAEN division)', () => {
    const caen = companiesFilterSpec.fields.find((f) => f.name === 'caenCode');
    expect(caen?.ops).toContain('prefix');
  });

  it('virtual fields are exactly caenCode/county/hasFinancials', () => {
    expect([...COMPANY_VIRTUAL_FIELDS].sort()).toEqual(['caenCode', 'county', 'hasFinancials']);
  });

  it('aggregate driving fields gate the county group', () => {
    expect([...COMPANY_AGGREGATE_DRIVING_FIELDS]).toContain('county');
    expect([...COMPANY_AGGREGATE_DRIVING_FIELDS]).toContain('status');
    expect([...COMPANY_AGGREGATE_DRIVING_FIELDS]).toContain('caenCode');
  });
});

describe('surface derivation (REST/GraphQL never drift)', () => {
  it('toGraphQLInput generates a CompaniesFilter input with the prefixed field inputs', () => {
    const sdl = toGraphQLInput(companiesFilterSpec);
    expect(sdl).toContain('input CompaniesFilter');
    expect(sdl).toContain('input CompaniesFilterExclude');
    expect(sdl).toContain('cui: CompaniesCuiFilter');
    expect(sdl).toContain('declaredFiscallyInactive: CompaniesDeclaredFiscallyInactiveFilter');
  });

  it('toTypeBox produces a $id-stamped object schema', () => {
    const tb = toTypeBox(companiesFilterSpec);
    expect((tb as { $id?: string }).$id).toBe('companiesFilter');
  });
});

describe('splitVirtual', () => {
  it('separates the repo-intercepted virtuals from the kernel-composable physicals', () => {
    const { physical, virtual } = splitVirtual({
      cui: { eq: '2816464' },
      county: { in: ['Bacău'] },
      caenCode: { prefix: '47' },
      hasFinancials: { isNull: false },
    });
    expect(Object.keys(physical)).toEqual(['cui']);
    expect(Object.keys(virtual).sort()).toEqual(['caenCode', 'county', 'hasFinancials']);
  });

  it('strips virtual fields from the exclude sub-object too', () => {
    const { physical } = splitVirtual({
      exclude: { county: { in: ['Cluj'] }, status: { in: ['1084'] } },
    });
    const ex = physical.exclude as Record<string, unknown> | undefined;
    expect(ex).toBeDefined();
    expect(Object.keys(ex ?? {})).toEqual(['status']);
  });
});

describe('v2 county filter normalization', () => {
  it('accepts both display labels and ONRC-prefixed labels as the same county', () => {
    expect(normalizeCountyNeedle('Bacău')).toBe('bacau');
    expect(normalizeCountyNeedle('JUDEŢUL BACĂU')).toBe('bacau');
    expect(normalizeCountyNeedle('MUNICIPIUL BUCUREŞTI')).toBe('bucuresti');
  });
});

describe('canonicalization / fhash (tri-surface equivalence)', () => {
  it('REST "1048" and GraphQL "1048" status fold to the same canonical hash', () => {
    const a = canonicalizeFilters(companiesFilterSpec, { status: { in: ['1048', '1084'] } });
    const b = canonicalizeFilters(companiesFilterSpec, { status: { in: ['1084', '1048'] } }); // order-independent
    expect(a).toBe(b);
    expect(fhashFor(companiesFilterSpec, { status: { in: ['1048'] } })).toBe(
      fhashFor(companiesFilterSpec, { status: { in: ['1048'] } })
    );
  });

  it('different filters produce different fhashes', () => {
    expect(fhashFor(companiesFilterSpec, { status: { in: ['1048'] } })).not.toBe(
      fhashFor(companiesFilterSpec, { status: { in: ['1084'] } })
    );
  });
});

describe('kernel composer over the physical fields', () => {
  it('compiles a status IN predicate without throwing', () => {
    const built = toConditionBuilders(companiesFilterSpec, { status: { in: ['1048', '1084'] } });
    expect(built.isOk()).toBe(true);
    expect((built as { value: unknown[] }).value.length).toBeGreaterThan(0);
  });

  it('rejects an operator the field does not allow', () => {
    const built = toConditionBuilders(companiesFilterSpec, { vatPayer: { contains: 'x' } });
    expect(built.isErr()).toBe(true);
  });
});
