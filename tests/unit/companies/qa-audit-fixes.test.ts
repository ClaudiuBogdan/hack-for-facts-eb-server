/**
 * Companies unit tests — QA-audit fixes (server doc 03-private-companies-qa-audit).
 * Covers the confirmed-and-fixed findings that are unit-testable without a DB:
 *   H1  netResultDelta must net profit AGAINST loss (loss years store net_profit=0)
 *   M4  territory emits an explicit `unmatched` object for a county consensus
 *       without a UAT (now from the pinned edition's derived-geography consensus)
 *   M6  financials.lines is nullable in v2; non-null JSON preserves Money-as-string
 *   M10 companyResolve(limit:0) returns no hits (was floored to 1)
 *   M14 resolve hits share ONE shape across dims incl. county (was plain strings on MCP)
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  exactDecimalDiff,
  makeCompanyFinancials,
  makeCompanyResolve,
  toCompanyResolveHits,
  type CompanyUsecaseDeps,
} from '@/modules/companies/core/usecases.js';
import {
  mapCountyDisplayName,
  mapFinancialYear,
  territoryOf,
  type FinancialRow,
} from '@/modules/companies/shell/repo/mappers.js';

import { assessedQualification, statementSource } from './qualification-fixtures.js';
import { stubFlows, stubRepo } from './repo-fixtures.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type {
  CompanyRegistryBasis,
  CompanyRegistryCuiProfile,
} from '@/modules/companies/core/registry.js';
import type { CompanyFinancialYear } from '@/modules/companies/core/types.js';
import type { ApiError } from '@/modules/shared/index.js';

const unwrap = <T>(r: Result<T, ApiError>): T => {
  if (r.isErr()) throw new Error(`expected ok, got ${r.error.type}: ${r.error.message}`);
  return r.value;
};

/**
 * One statement whose evaluator net is profit − loss, as sql-v1 computes it
 * for an admitted, non-held statement with both sides present.
 */
const yearRow = (year: number, netProfit: string, netLoss: string): CompanyFinancialYear => ({
  year,
  sourceSystem: year >= 2019 ? 'anaf' : 'mfp',
  turnover: '0.00',
  netProfit,
  netLoss,
  employees: null,
  summary: {
    turnover: '0.00',
    netProfit,
    netLoss,
    totalRevenue: null,
    totalExpenses: null,
    grossProfit: null,
    grossLoss: null,
    receivables: null,
    currentAssets: null,
    fixedAssets: null,
    cashAndBank: null,
    prepaidExpenses: null,
    deferredIncome: null,
    subscribedCapital: null,
    inventories: null,
    debts: null,
    provisions: null,
    totalEquity: null,
    patrimonyRegie: null,
  },
  lines: null,
  source: statementSource(year),
  qualification: assessedQualification({}, exactDecimalDiff(netProfit, netLoss)),
});

const deps = (over: Partial<CompaniesRepository> = {}): CompanyUsecaseDeps => ({
  repo: stubRepo(over),
  flowsRepo: stubFlows(),
  meili: null,
});

describe('H1 — netResultDelta nets profit against loss', () => {
  it('uses the evaluator net (profit - loss), not profit-only, across a loss→profit swing', async () => {
    // 2023: loss year — ANAF stores net_profit=0, net_loss>0 (the bug trigger).
    // 2024: profit year. getFinancials returns DESC (latest first).
    const getFinancials = vi.fn(async () =>
      ok([yearRow(2024, '5931214.00', '0.00'), yearRow(2023, '0.00', '4683875.00')])
    );
    const res = unwrap(await makeCompanyFinancials(deps({ getFinancials }), '10012185'));
    // true delta = (5931214 - 0) - (0 - 4683875) = 10615089.00 (profit-only would be 5931214.00)
    expect(res?.trajectory?.netResultDelta).toBe('10615089.00');
  });

  it('is null when both profit and loss are absent: the evaluator says missing, never 0', async () => {
    const both = (y: number): CompanyFinancialYear => ({
      ...yearRow(y, '0.00', '0.00'),
      netProfit: null,
      netLoss: null,
      qualification: assessedQualification({
        net_loss: 'missing',
        net_profit: 'missing',
        net_result: 'missing',
      }),
    });
    const getFinancials = vi.fn(async () => ok([both(2024), both(2023)]));
    const res = unwrap(await makeCompanyFinancials(deps({ getFinancials }), '1'));
    expect(res?.trajectory?.netResultDelta).toBeNull();
    expect(res?.trajectory?.netResultDeltaReason).toBe('latest_not_reported');
  });
});

/** A profile whose geography consensus is set per test. */
const geography = (
  county: string | null,
  countyBasis: CompanyRegistryBasis,
  uat: string | null,
  uatBasis: CompanyRegistryBasis
): CompanyRegistryCuiProfile => ({
  identityObservations: 1,
  identifierCount: 1,
  unresolvedIdentifierCount: 0,
  unidentifiedObservations: 0,
  name: { value: 'X SRL', basis: 'single_observation' },
  legalForm: { value: 'SRL', basis: 'single_observation' },
  recordedDate: { value: null, basis: 'missing' },
  countyCode: { value: county, basis: countyBasis },
  countyName: county === null ? null : 'JUDEŢUL BACĂU',
  uatSirutaCode: { value: uat, basis: uatBasis },
  uatName: uat === null ? null : 'BACĂU',
  statusCode: { value: '1048', basis: 'single_observation' },
  caenCoverage: 'complete',
  statusCoverage: 'complete',
  legalPersonEligibility: 'eligible',
  eligibilityReason: null,
  eligibilityPolicyVersion: 'public-legal-person-v1',
});

describe('M4 — territory emits an explicit unmatched object (edition consensus)', () => {
  it('returns matchConfidence=unmatched for a county consensus without a UAT consensus', () => {
    const t = territoryOf(geography('BC', 'single_observation', null, 'missing'));
    expect(t).not.toBeNull();
    expect(t?.matchConfidence).toBe('unmatched');
    expect(t?.sirutaCode).toBeNull();
    expect(t?.countyName).toBe('Bacău');
  });

  it('returns null without a profile, and never coerces conflicting geography into a territory', () => {
    expect(territoryOf(null)).toBeNull();
    expect(territoryOf(geography(null, 'multiple_values', null, 'multiple_values'))).toBeNull();
    expect(territoryOf(geography(null, 'unresolved', null, 'unresolved'))).toBeNull();
  });

  it('returns safe with codes when a UAT consensus exists', () => {
    const t = territoryOf(
      geography('BC', 'consistent_observations', '22132', 'single_observation')
    );
    expect(t?.matchConfidence).toBe('safe');
    expect(t?.sirutaCode).toBe('22132');
    expect(t?.uatName).toBe('Bacău');
  });
});

describe('v2 county display normalization', () => {
  it('strips ONRC county prefixes and title-cases Romanian labels', () => {
    expect(mapCountyDisplayName('JUDEŢUL BACĂU')).toBe('Bacău');
    expect(mapCountyDisplayName('municipiul bucureşti')).toBe('Bucureşti');
  });
});

describe('M6 — financials.lines nullable/string money contract', () => {
  it('stringifies numeric jsonb values, leaves non-numbers as-is', () => {
    const row = {
      ...(yearRow(2024, '0.00', '0.00') as unknown as FinancialRow),
      lines: { Creante: 69341056, Note: 'n/a', Zero: 0 },
    };
    const mapped = mapFinancialYear(row, false);
    expect(mapped.lines?.['Creante']).toBe('69341056');
    expect(mapped.lines?.['Zero']).toBe('0');
    expect(mapped.lines?.['Note']).toBe('n/a');
  });

  it('keeps null lines null', () => {
    const row = yearRow(2024, '0.00', '0.00') as unknown as FinancialRow;
    expect(mapFinancialYear(row, false).lines).toBeNull();
  });
});

describe('sourceSystem mapping (publisher seam)', () => {
  it('maps the snake_case source_system column onto sourceSystem', () => {
    // yearRow(2018) already carries camelCase sourceSystem:'mfp'; the snake_case
    // column DELIBERATELY differs so a mapper regressed to r.sourceSystem fails.
    const row = {
      ...(yearRow(2018, '0.00', '0.00') as unknown as FinancialRow),
      source_system: 'anaf',
    };
    expect(mapFinancialYear(row, false).sourceSystem).toBe('anaf');
  });
});

describe('M10 — companyResolve honors limit:0', () => {
  it('returns no hits for limit 0 instead of flooring to 1', async () => {
    const resolveByName = vi.fn(async () =>
      ok({
        hits: [
          {
            dim: 'name' as const,
            value: '1',
            label: 'X',
            cui: '1',
            confidence: 1,
            labelSource: 'core_organization' as const,
          },
        ],
        degraded: false,
      })
    );
    const res = unwrap(await makeCompanyResolve(deps({ resolveByName }), 'name', 'x', 0));
    expect(res.matches).toHaveLength(0);
    expect(resolveByName).not.toHaveBeenCalled();
  });
});

describe('M14 — resolve hits share one shape across dims', () => {
  it('maps county matches to the structured hit shape (not plain strings)', () => {
    const hits = toCompanyResolveHits({
      dim: 'county',
      q: 'bac',
      matches: [],
      caenMatches: [],
      countyMatches: ['Bacău'],
      ambiguous: false,
      degraded: false,
      registry: null,
    });
    expect(hits).toEqual([
      {
        dim: 'COUNTY',
        value: 'Bacău',
        label: 'Bacău',
        cui: null,
        confidence: null,
        revision: null,
        key: null,
        labelSource: 'territory_hub',
      },
    ]);
  });

  it('maps caen matches with their revision and the exact onrcCaen key (value stays the bare code)', () => {
    const hits = toCompanyResolveHits({
      dim: 'caen',
      q: '6201',
      matches: [],
      caenMatches: [
        { code: '6201', rev: 'rev2', key: 'rev2:6201', label: 'Software' },
        { code: '6201', rev: 'rev0', key: 'rev0:6201', label: null },
      ],
      countyMatches: [],
      ambiguous: true,
      degraded: false,
      registry: null,
    });
    expect(hits).toEqual([
      {
        dim: 'CAEN',
        value: '6201',
        label: 'Software',
        cui: null,
        confidence: null,
        revision: 'rev2',
        key: 'rev2:6201',
        labelSource: 'current_db_catalog',
      },
      // A catalog row without a label shows its key, never a bare code alone.
      {
        dim: 'CAEN',
        value: '6201',
        label: 'rev0:6201',
        cui: null,
        confidence: null,
        revision: 'rev0',
        key: 'rev0:6201',
        labelSource: null,
      },
    ]);
  });
});
