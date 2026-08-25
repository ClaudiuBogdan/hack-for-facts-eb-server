/**
 * Companies unit tests — QA-audit fixes (server doc 03-private-companies-qa-audit).
 * Covers the confirmed-and-fixed findings that are unit-testable without a DB:
 *   H1  netResultDelta must net profit AGAINST loss (loss years store net_profit=0)
 *   M4  territory emits an explicit `unmatched` object (was null → UNMATCHED unreachable)
 *   M6  financials.lines is nullable in v2; non-null JSON preserves Money-as-string
 *   M10 companyResolve(limit:0) returns no hits (was floored to 1)
 *   M14 resolve hits share ONE shape across dims incl. county (was plain strings on MCP)
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  makeCompanyFinancials,
  makeCompanyResolve,
  toCompanyResolveHits,
  type CompanyUsecaseDeps,
} from '@/modules/companies/core/usecases.js';
import {
  mapCountyDisplayName,
  mapFinancialYear,
  mapTerritory,
  type FinancialRow,
} from '@/modules/companies/shell/repo/mappers.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';
import type { CompanyFinancialYear } from '@/modules/companies/core/types.js';
import type { ApiError, FlowsRepo } from '@/modules/shared/index.js';

const unwrap = <T>(r: Result<T, ApiError>): T => {
  if (r.isErr()) throw new Error(`expected ok, got ${r.error.type}: ${r.error.message}`);
  return r.value;
};

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
});

const stubRepo = (over: Partial<CompaniesRepository> = {}): CompaniesRepository => ({
  getProfileData: vi.fn(async () => ok(null)),
  getFinancials: vi.fn(async () => ok([])),
  listCompanies: vi.fn(async () => ok({ rows: [], total: 0, estimated: false })),
  resolveByName: vi.fn(async () => ok({ hits: [], degraded: false })),
  findByRegistrationNumber: vi.fn(async () => ok([])),
  resolveCaen: vi.fn(async () => ok([])),
  resolveCounty: vi.fn(async () => ok([])),
  countBy: vi.fn(async () =>
    ok({
      groups: [],
      denominator: 0,
      coverage: { territoryMatched: null, territoryUnmatched: null, note: '' },
    })
  ),
  profileSlice: vi.fn(async () => ok(null)),
  presenceCounts: vi.fn(async () => ok(null)),
  profileSlicesForCuis: vi.fn(async () => ok(new Map())),
  ...over,
});

const stubFlows = (): FlowsRepo => ({
  getFlowSummary: vi.fn(async () =>
    ok({
      direction: 'in' as const,
      count: 0,
      totalAmountRon: '0',
      minYear: null,
      maxYear: null,
      byFlowType: [],
      byYear: [],
    })
  ),
  getTopCounterparties: vi.fn(async () => ok([])),
  listFlows: vi.fn(async () => ok({ items: [], next: null })),
  getCounterpartyNetwork: vi.fn(async () => ok({ rootCui: '', depth: 0, nodes: [], edges: [] })),
  aggregateFlows: vi.fn(async () => ok([])),
});

const deps = (over: Partial<CompaniesRepository> = {}): CompanyUsecaseDeps => ({
  repo: stubRepo(over),
  flowsRepo: stubFlows(),
  meili: null,
});

describe('H1 — netResultDelta nets profit against loss', () => {
  it('uses (profit - loss), not profit-only, across a loss→profit swing', async () => {
    // 2023: loss year — ANAF stores net_profit=0, net_loss>0 (the bug trigger).
    // 2024: profit year. getFinancials returns DESC (latest first).
    const getFinancials = vi.fn(async () =>
      ok([yearRow(2024, '5931214.00', '0.00'), yearRow(2023, '0.00', '4683875.00')])
    );
    const res = unwrap(await makeCompanyFinancials(deps({ getFinancials }), '10012185'));
    // true delta = (5931214 - 0) - (0 - 4683875) = 10615089.00 (profit-only would be 5931214.00)
    expect(res?.trajectory?.netResultDelta).toBe('10615089.00');
  });

  it('is null only when both profit and loss are absent', async () => {
    const both = (y: number): CompanyFinancialYear => ({
      ...yearRow(y, '0.00', '0.00'),
      netProfit: null,
      netLoss: null,
    });
    const getFinancials = vi.fn(async () => ok([both(2024), both(2023)]));
    const res = unwrap(await makeCompanyFinancials(deps({ getFinancials }), '1'));
    expect(res?.trajectory?.netResultDelta).toBeNull();
  });
});

describe('M4 — territory emits an explicit unmatched object', () => {
  it('returns matchConfidence=unmatched when a registration exists but SIRUTA missed', () => {
    const t = mapTerritory({
      uat_siruta_code: null,
      uat_name: null,
      county_name: null,
      match_confidence: 'unmatched',
    });
    expect(t).not.toBeNull();
    expect(t?.matchConfidence).toBe('unmatched');
    expect(t?.sirutaCode).toBeNull();
  });

  it('returns null only when there is no registration data at all', () => {
    const t = mapTerritory({
      uat_siruta_code: null,
      uat_name: null,
      county_name: null,
      match_confidence: null,
    });
    expect(t).toBeNull();
  });

  it('returns safe with codes when SIRUTA matched', () => {
    const t = mapTerritory({
      uat_siruta_code: 22132,
      uat_name: 'Bacău',
      county_name: 'Bacău',
      match_confidence: 'safe',
    });
    expect(t?.matchConfidence).toBe('safe');
    expect(t?.sirutaCode).toBe('22132');
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
    const mapped = mapFinancialYear(row);
    expect(mapped.lines?.['Creante']).toBe('69341056');
    expect(mapped.lines?.['Zero']).toBe('0');
    expect(mapped.lines?.['Note']).toBe('n/a');
  });

  it('keeps null lines null', () => {
    const row = yearRow(2024, '0.00', '0.00') as unknown as FinancialRow;
    expect(mapFinancialYear(row).lines).toBeNull();
  });
});

describe('M10 — companyResolve honors limit:0', () => {
  it('returns no hits for limit 0 instead of flooring to 1', async () => {
    const resolveByName = vi.fn(async () =>
      ok({
        hits: [{ dim: 'name' as const, value: '1', label: 'X', cui: '1', confidence: 1 }],
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
    });
    expect(hits).toEqual([
      { dim: 'COUNTY', value: 'Bacău', label: 'Bacău', cui: null, confidence: null },
    ]);
  });

  it('maps caen matches by code with the same shape', () => {
    const hits = toCompanyResolveHits({
      dim: 'caen',
      q: '6201',
      matches: [],
      caenMatches: [{ code: '6201', rev: 'rev2', label: 'Software' }],
      countyMatches: [],
      ambiguous: false,
      degraded: false,
    });
    expect(hits[0]).toEqual({
      dim: 'CAEN',
      value: '6201',
      label: 'Software',
      cui: null,
      confidence: null,
    });
  });
});
