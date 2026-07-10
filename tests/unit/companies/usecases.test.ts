/**
 * Companies unit tests — usecases over MOCKED ports (no DB). Covers: CUI
 * normalization at the boundary, the financials trajectory (precision-safe
 * decimal/bigint deltas), the Meili-primary→pg-fallback list path + caveats, the
 * resolve dimensions, and the public-money injection from the kernel FlowsRepo
 * (payee/`in`) — never the companies repo.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  makeCompanyFinancials,
  makeCompanyList,
  makeCompanyProfile,
  makeCompanyResolve,
  type CompanyUsecaseDeps,
} from '@/modules/companies/core/usecases.js';

import type { CompaniesRepository, CompanyProfileData } from '@/modules/companies/core/ports.js';
import type { CompanyFinancialYear } from '@/modules/companies/core/types.js';
import type { ApiError, FlowsRepo } from '@/modules/shared/index.js';

/** Unwrap an ok Result in tests (throws if err — surfaces the failure clearly). */
const unwrap = <T>(r: Result<T, ApiError>): T => {
  if (r.isErr()) throw new Error(`expected ok, got ${r.error.type}: ${r.error.message}`);
  return r.value;
};

const finYear = (
  year: number,
  turnover: string | null,
  employees: string | null,
  netProfit: string | null = null
): CompanyFinancialYear => ({
  year,
  turnover,
  netProfit,
  netLoss: null,
  employees,
  summary: {
    turnover,
    netProfit,
    netLoss: null,
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

const profileData = (cui: string): CompanyProfileData => ({
  cui,
  orgId: '1517396',
  name: 'DEDEMAN SRL',
  legalForm: 'SRL',
  codInmatriculare: 'J1992002621040',
  registrationDate: '1992-11-05',
  registrationDatePresent: true,
  headlineStatus: { code: '1048', label: 'funcțiune' },
  statusFlags: [],
  territory: null,
  address: { display: '', county: 'Bacău', locality: null },
  fiscal: {
    vatPayer: true,
    declaredFiscallyInactive: false,
    mainCaenCode: '4752',
    registeredName: null,
    asOf: '2026-05-18',
  },
  caenActivities: [],
  representatives: [],
  financials: [finYear(2024, '12294042595.00', '12313')],
  euBranches: [],
  asOf: { onrc: '2026-05-18', anaf: '2026-05-18' },
});

const stubRepo = (over: Partial<CompaniesRepository> = {}): CompaniesRepository => ({
  getProfileData: vi.fn(async () => ok(profileData('2816464'))),
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

const stubFlows = (over: Partial<FlowsRepo> = {}): FlowsRepo => ({
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
  ...over,
});

const deps = (
  over: { repo?: Partial<CompaniesRepository>; flows?: Partial<FlowsRepo> } = {}
): CompanyUsecaseDeps => ({
  repo: stubRepo(over.repo),
  flowsRepo: stubFlows(over.flows),
  meili: null,
});

describe('makeCompanyProfile', () => {
  it('normalizes the CUI (RO prefix + non-digits) before the repo seek', async () => {
    const getProfileData = vi.fn(async () => ok(profileData('2816464')));
    const d = deps({ repo: { getProfileData } });
    const res = await makeCompanyProfile(d, 'RO 2816464');
    expect(res.isOk()).toBe(true);
    expect(getProfileData).toHaveBeenCalledWith('2816464');
  });

  it('rejects a non-normalizable CUI with InvalidInput (no repo round-trip)', async () => {
    const getProfileData = vi.fn();
    const d = deps({ repo: { getProfileData: getProfileData as never } });
    const res = await makeCompanyProfile(d, 'not-a-cui!!');
    expect(res.isErr()).toBe(true);
    expect((res as { error: ApiError }).error.type).toBe('InvalidInput');
    expect(getProfileData).not.toHaveBeenCalled();
  });

  it('injects public money from the kernel FlowsRepo direction=in (payee), not the repo', async () => {
    const getFlowSummary = vi.fn(async () =>
      ok({
        direction: 'in' as const,
        count: 3,
        totalAmountRon: '1816445170.99',
        minYear: 2019,
        maxYear: 2024,
        byFlowType: [{ flowType: 'direct_acquisition', count: 3, totalAmountRon: '1816445170.99' }],
        byYear: [
          { year: 2024, flowType: 'direct_acquisition', count: 2, totalAmountRon: '1000000000.00' },
          { year: 2019, flowType: 'direct_acquisition', count: 1, totalAmountRon: '816445170.99' },
        ],
      })
    );
    const d = deps({ flows: { getFlowSummary } });
    const res = await makeCompanyProfile(d, '2816464');
    expect(res.isOk()).toBe(true);
    const pm = (
      res as {
        value: {
          publicMoney: {
            totalRon: string;
            flowCount: number;
            byYear: { year: number | null }[];
            byFlowType: { flowType: string }[];
          } | null;
        };
      }
    ).value.publicMoney;
    expect(pm?.flowCount).toBe(3);
    expect(pm?.totalRon).toBe('1816445170.99');
    // H4: byYear carries a populated year (was always null); byFlowType is the rollup.
    expect(pm?.byYear[0]?.year).toBe(2024);
    expect(pm?.byFlowType[0]?.flowType).toBe('direct_acquisition');
    expect(getFlowSummary).toHaveBeenCalledWith('2816464', 'in', true); // opts into the byYear breakdown
  });

  it('returns null public money when the company is not a flows payee', async () => {
    const res = await makeCompanyProfile(deps(), '2816464');
    expect((res as { value: { publicMoney: unknown } }).value.publicMoney).toBeNull();
  });

  it('returns null when the company does not exist', async () => {
    const d = deps({ repo: { getProfileData: vi.fn(async () => ok(null)) } });
    const res = await makeCompanyProfile(d, '999');
    expect((res as { value: unknown }).value).toBeNull();
  });
});

describe('makeCompanyFinancials trajectory (precision-safe)', () => {
  it('computes decimal turnover + bigint employee deltas without floats', async () => {
    const getFinancials = vi.fn(async () =>
      ok([
        finYear(2024, '12294042595.00', '12313', '1636814708.00'),
        finYear(2023, '11545530630.00', '12113', '1534733147.00'),
      ])
    );
    const d = deps({ repo: { getFinancials } });
    const res = await makeCompanyFinancials(d, '2816464');
    expect(res.isOk()).toBe(true);
    const f = (
      res as {
        value: {
          latest: { year: number } | null;
          trajectory: {
            turnoverDelta: string | null;
            employeesDelta: string | null;
            netResultDelta: string | null;
          } | null;
        };
      }
    ).value;
    expect(f.latest?.year).toBe(2024);
    expect(f.trajectory?.turnoverDelta).toBe('748511965.00'); // 12294042595.00 - 11545530630.00
    expect(f.trajectory?.employeesDelta).toBe('200'); // 12313 - 12113
    expect(f.trajectory?.netResultDelta).toBe('102081561.00');
  });

  it('null trajectory with a single year', async () => {
    const d = deps({ repo: { getFinancials: vi.fn(async () => ok([finYear(2024, '1', '1')])) } });
    const res = await makeCompanyFinancials(d, '2816464');
    expect((res as { value: { trajectory: unknown } }).value.trajectory).toBeNull();
  });
});

describe('makeCompanyList', () => {
  it('normalizes filter.cui (eq + in) at the boundary', async () => {
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
    const d = deps({ repo: { listCompanies } });
    await makeCompanyList(d, {
      filter: { cui: { in: ['RO2816464', '4505500'] } },
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    const calls = listCompanies.mock.calls as unknown as [{ cui: { in: string[] } }][];
    const passed = calls[0]?.[0];
    expect(passed?.cui.in).toEqual(['2816464', '4505500']);
  });

  it('rejects an un-normalizable cui filter value', async () => {
    const res = await makeCompanyList(deps(), {
      filter: { cui: { eq: 'xx' } },
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(res.isErr()).toBe(true);
  });

  it('q ANDs the resolved CUIs into filter.cui.in and runs listCompanies (filters + pagination apply); carries the degraded caveat', async () => {
    const resolveByName = vi.fn(async () =>
      ok({
        hits: [
          {
            dim: 'name' as const,
            value: '2816464',
            label: 'DEDEMAN SRL',
            cui: '2816464',
            confidence: 1,
          },
        ],
        degraded: true,
      })
    );
    const listCompanies = vi.fn(async () =>
      ok({
        rows: [
          {
            cui: '2816464',
            orgId: '1',
            name: 'DEDEMAN SRL',
            legalForm: 'SRL',
            headlineStatus: null,
            county: 'Bacău',
            vatPayer: true,
            declaredFiscallyInactive: false,
            registrationDate: null,
            registrationDatePresent: false,
          },
        ],
        total: 1,
        estimated: false,
      })
    );
    const d = deps({ repo: { resolveByName, listCompanies } });
    const res = await makeCompanyList(d, {
      filter: { status: { in: ['1048'] } },
      q: 'dedeman',
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(res.isOk()).toBe(true);
    expect(resolveByName).toHaveBeenCalled();
    const calls = listCompanies.mock.calls as unknown as [
      { cui: { in: string[] }; status: { in: string[] } },
    ][];
    const passed = calls[0]?.[0];
    expect(passed?.cui.in).toEqual(['2816464']); // name-resolved CUIs ANDed in
    expect(passed?.status.in).toEqual(['1048']); // original filter preserved
    expect(unwrap(res).caveats[0]).toContain('degraded');
  });

  it('q with no name matches returns an empty page (does not list everything)', async () => {
    const resolveByName = vi.fn(async () => ok({ hits: [], degraded: false }));
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
    const d = deps({ repo: { resolveByName, listCompanies } });
    const res = await makeCompanyList(d, {
      filter: {},
      q: 'zzzznomatch',
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(unwrap(res).total).toBe(0);
    expect(listCompanies).not.toHaveBeenCalled();
  });

  it('rejects an empty in: [] (which the kernel composer would silently drop to match-all)', async () => {
    const res = await makeCompanyList(deps(), {
      filter: { status: { in: [] } },
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(res.isErr()).toBe(true);
    expect((res as { error: ApiError }).error.type).toBe('InvalidInput');
  });
});

describe('makeCompanyResolve', () => {
  it('regnum returns the two-hop list and flags ambiguity at >1', async () => {
    const findByRegistrationNumber = vi.fn(async () =>
      ok([
        { dim: 'regnum' as const, value: '1', label: 'A', cui: '1', confidence: null },
        { dim: 'regnum' as const, value: '2', label: 'B', cui: '2', confidence: null },
      ])
    );
    const d = deps({ repo: { findByRegistrationNumber } });
    const res = await makeCompanyResolve(d, 'regnum', 'J40/9216/2018', 10);
    expect(unwrap(res).matches).toHaveLength(2);
    expect(unwrap(res).ambiguous).toBe(true);
  });

  it('name surfaces the degraded flag from the repo', async () => {
    const resolveByName = vi.fn(async () => ok({ hits: [], degraded: true }));
    const d = deps({ repo: { resolveByName } });
    const res = await makeCompanyResolve(d, 'name', 'x', 5);
    expect((res as { value: { degraded: boolean } }).value.degraded).toBe(true);
  });
});

describe('error propagation', () => {
  it('surfaces a repo Database error from the profile usecase', async () => {
    const dbErr: ApiError = { type: 'Database', message: 'boom' };
    const d = deps({
      repo: {
        getProfileData: vi.fn(
          async (): Promise<Result<CompanyProfileData | null, ApiError>> => err(dbErr)
        ),
      },
    });
    const res = await makeCompanyProfile(d, '2816464');
    expect((res as { error: ApiError }).error.type).toBe('Database');
  });
});
