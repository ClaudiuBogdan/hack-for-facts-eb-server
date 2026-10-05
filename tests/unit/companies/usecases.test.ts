/**
 * Companies unit tests — usecases over MOCKED ports (no DB). Covers: CUI
 * normalization at the boundary, the financials trajectory (precision-safe
 * decimal/bigint deltas), the Meili-primary→pg-fallback list path + caveats, the
 * resolve dimensions, and the public-money injection from the kernel FlowsRepo
 * (payee/`in`) — never the companies repo.
 */

import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import { noRegistryEvidence } from '@/modules/companies/core/registry.js';
import {
  exactDecimalDiff,
  isWithheldCompanyIdentifier,
  makeCompanyFinancials,
  makeCompanyList,
  makeCompanyProfile,
  makeCompanyProfileData,
  diffRegistryEditions,
  makeCompanyFinancialQualityAssessment,
  makeCompanyRegistrationDiff,
  makeCompanyPublicMoney,
  makeCompanyResolve,
  type CompanyUsecaseDeps,
} from '@/modules/companies/core/usecases.js';
import { makeCompaniesContributor } from '@/modules/companies/shell/contributor.js';

import {
  POLICY_SHA,
  assessedQualification,
  notAssessedQualification,
  statementSource,
} from './qualification-fixtures.js';
import { PUBLISHED_SCOPE, UNPUBLISHED_SCOPE } from './registry-fixtures.js';
import { stubRepo as sharedStubRepo } from './repo-fixtures.js';

import type { CompaniesRepository, CompanyProfileData } from '@/modules/companies/core/ports.js';
import type {
  CompanyFinancialYear,
  CompanyRegistrationDiffData,
  CompanyRegistrationEditionSide,
  CompanyRegistrationField,
  CompanyStatementQualification,
} from '@/modules/companies/core/types.js';
import type { ApiError, FlowsRepo } from '@/modules/shared/index.js';

/** Unwrap an ok Result in tests (throws if err — surfaces the failure clearly). */
const unwrap = <T>(r: Result<T, ApiError>): T => {
  if (r.isErr()) throw new Error(`expected ok, got ${r.error.type}: ${r.error.message}`);
  return r.value;
};

/**
 * What sql-v1 states for an admitted, non-held statement: a present value is
 * reported, an absent one missing, and the net is profit − loss with an
 * absent side as 0 (missing when both are absent).
 */
const evaluated = (
  turnover: string | null,
  employees: string | null,
  netProfit: string | null,
  netLoss: string | null
): CompanyStatementQualification => {
  const status = (value: string | null) => (value === null ? 'missing' : 'reported');
  const noNet = netProfit === null && netLoss === null;
  return assessedQualification(
    {
      employees: status(employees),
      net_loss: status(netLoss),
      net_profit: status(netProfit),
      net_result: noNet ? 'missing' : 'reported',
      turnover: status(turnover),
    },
    noNet ? null : exactDecimalDiff(netProfit ?? '0', netLoss ?? '0')
  );
};

const finYear = (
  year: number,
  turnover: string | null,
  employees: string | null,
  netProfit: string | null = null,
  netLoss: string | null = null
): CompanyFinancialYear => ({
  year,
  sourceSystem: year >= 2019 ? 'anaf' : 'mfp',
  turnover,
  netProfit,
  netLoss,
  employees,
  source: statementSource(year),
  qualification: evaluated(turnover, employees, netProfit, netLoss),
  summary: {
    turnover,
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

const profileData = (cui: string): CompanyProfileData => ({
  cui,
  orgId: '1517396',
  name: 'DEDEMAN SRL',
  nameSource: 'onrc_edition',
  legalForm: 'SRL',
  codInmatriculare: 'J1992002621040',
  registrationDate: '1992-11-05',
  registrationDatePresent: true,
  headlineStatus: { code: '1048', label: 'funcțiune', labelSource: 'api_nomenclature' },
  statusFlags: [],
  territory: null,
  address: { display: '', county: 'Bacău', locality: null },
  registry: noRegistryEvidence(PUBLISHED_SCOPE),
  fiscal: {
    vatPayer: true,
    declaredFiscallyInactive: false,
    mainCaenCode: '4752',
    mainCaenRev: null,
    registeredName: null,
    asOf: '2026-05-18',
  },
  caenActivities: [],
  representatives: [],
  financials: [finYear(2024, '12294042595.00', '12313')],
  euBranches: [],
  asOf: { onrc: '2026-05-18', anaf: '2026-05-18' },
});

/** The shared port stub, whose profile seek answers DEDEMAN by default. */
const stubRepo = (over: Partial<CompaniesRepository> = {}): CompaniesRepository =>
  sharedStubRepo({ getProfileData: vi.fn(async () => ok(profileData('2816464'))), ...over });

/** A name hit as the repo returns it (spine-validated, label attributed). */
const nameHit = (cui: string, label: string) => ({
  dim: 'name' as const,
  value: cui,
  label,
  cui,
  confidence: 1,
  labelSource: 'core_organization' as const,
});
const regnumHit = (cui: string, label: string) => ({
  dim: 'regnum' as const,
  value: cui,
  label,
  cui,
  confidence: null,
  labelSource: 'onrc_edition' as const,
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
    // One pinned registry scope rides along to the repo.
    expect(getProfileData).toHaveBeenCalledWith('2816464', PUBLISHED_SCOPE);
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

  const trajectoryOf = async (
    latest: CompanyFinancialYear,
    prior: CompanyFinancialYear
  ): Promise<{ turnoverDelta: string | null; netResultDelta: string | null } | null> => {
    const d = deps({ repo: { getFinancials: vi.fn(async () => ok([latest, prior])) } });
    return unwrap(await makeCompanyFinancials(d, '2816464'))?.trajectory ?? null;
  };
  const withNet = (
    year: number,
    netProfit: string | null,
    netLoss: string | null,
    turnover: string | null = null
  ): CompanyFinancialYear => finYear(year, turnover, null, netProfit, netLoss);

  it('keeps reported precision beyond two places: never truncated or rounded (CD-16)', async () => {
    // The old 2dp scaler dropped the third digit: 1.009 − 1.001 came out 0.00.
    const t = await trajectoryOf(
      withNet(2024, '10.005', '0.00', '1.009'),
      withNet(2023, '0', '2.5', '1.001')
    );
    expect(t?.turnoverDelta).toBe('0.008');
    // (10.005 − 0) − (0 − 2.5) at the larger scale.
    expect(t?.netResultDelta).toBe('12.505');
  });

  it('subtracts exactly past 2^53 and keeps 2dp formatting for 2dp inputs', async () => {
    const t = await trajectoryOf(
      withNet(2024, null, null, '9007199254740993.01'),
      withNet(2023, null, null, '1.00')
    );
    expect(t?.turnoverDelta).toBe('9007199254740992.01');
    expect(exactDecimalDiff('5', '3')).toBe('2.00');
    expect(exactDecimalDiff('0.5', '1')).toBe('-0.50');
    expect(exactDecimalDiff('-0.00', '0')).toBe('0.00');
    expect(exactDecimalDiff('300000000000000.123456', '0.1')).toBe('300000000000000.023456');
  });

  it('answers null, never a throw or a guess, for a value that is not a plain decimal', async () => {
    expect(exactDecimalDiff('NaN', '1.00')).toBeNull();
    expect(exactDecimalDiff('1.00', 'Infinity')).toBeNull();
    expect(exactDecimalDiff('1e3', '1')).toBeNull();
    const t = await trajectoryOf(
      withNet(2024, null, null, 'NaN'),
      withNet(2023, null, null, '1.00')
    );
    expect(t?.turnoverDelta).toBeNull();
  });

  it('a reported 0/0 is a zero net result, null/null is no result, 0/loss is the loss', async () => {
    expect(
      (await trajectoryOf(withNet(2024, '0.00', '0.00'), withNet(2023, '0.00', '500.00')))
        ?.netResultDelta
    ).toBe('500.00');
    expect(
      (await trajectoryOf(withNet(2024, '0.00', '0.00'), withNet(2023, null, null)))?.netResultDelta
    ).toBeNull();
    expect(
      (await trajectoryOf(withNet(2024, '0.00', '120.50'), withNet(2023, '0.00', '0.00')))
        ?.netResultDelta
    ).toBe('-120.50');
  });
});

describe('makeCompanyFinancials trajectory under sql-v1 qualification (CD-14)', () => {
  const trajectory = async (
    latest: CompanyFinancialYear,
    prior: CompanyFinancialYear
  ): Promise<Record<string, unknown> | null> => {
    const d = deps({ repo: { getFinancials: vi.fn(async () => ok([latest, prior])) } });
    const t = unwrap(await makeCompanyFinancials(d, '2816464'))?.trajectory ?? null;
    return t === null ? null : { ...t };
  };
  const prior = finYear(2023, '1000.00', '10', '50.00', '0.00');

  it('drops only the held metric: a held turnover keeps the employee and net deltas', async () => {
    const latest = finYear(2024, '300000000000000', '12', '60.00', '0.00');
    const held: CompanyFinancialYear = {
      ...latest,
      qualification: assessedQualification({ turnover: 'held_observation' }, '60.00', {
        holdReason: 'reviewed: source keying error',
      }),
    };
    expect(await trajectory(held, prior)).toMatchObject({
      employeesDelta: '2',
      employeesDeltaReason: null,
      netResultDelta: '10.00',
      netResultDeltaReason: null,
      turnoverDelta: null,
      turnoverDeltaReason: 'latest_not_reported',
    });
    // The original stays on the year, untouched.
    expect(held.turnover).toBe('300000000000000');
  });

  it('uses the evaluator net, never a local profit − loss (464d: profit reported, net held)', async () => {
    const latest: CompanyFinancialYear = {
      ...finYear(2024, '1100.00', '10', '120.00', null),
      qualification: assessedQualification(
        { gross_loss: 'held_profile', net_loss: 'missing', net_result: 'held_profile' },
        null
      ),
    };
    expect(await trajectory(latest, prior)).toMatchObject({
      netResultDelta: null,
      netResultDeltaReason: 'latest_not_reported',
      turnoverDelta: '100.00',
    });
    // And the net value is the evaluator's, whatever the raw components say.
    const odd: CompanyFinancialYear = {
      ...finYear(2024, '1100.00', '10', '999.00', '1.00'),
      qualification: assessedQualification({}, '70.00'),
    };
    expect((await trajectory(odd, prior))?.['netResultDelta']).toBe('20.00');
  });

  it('never uses a statement that is not assessed or whose qualification is unavailable', async () => {
    for (const reason of ['qualification_unavailable', 'no_active_policy', 'policy_unqualified']) {
      const unassessed: CompanyFinancialYear = {
        ...finYear(2024, '1100.00', '11', '60.00', '0.00'),
        qualification: notAssessedQualification(reason),
      };
      expect(await trajectory(unassessed, prior)).toMatchObject({
        employeesDelta: null,
        employeesDeltaReason: 'not_assessed',
        netResultDelta: null,
        turnoverDelta: null,
        turnoverDeltaReason: 'not_assessed',
      });
      expect(await trajectory(prior, unassessed)).toMatchObject({
        turnoverDeltaReason: 'not_assessed',
      });
    }
  });

  it('refuses to compare years evaluated under different policies', async () => {
    const latest: CompanyFinancialYear = {
      ...finYear(2024, '1100.00', '11', '60.00', '0.00'),
      qualification: assessedQualification({}, '60.00', { policySha256: 'c3'.repeat(32) }),
    };
    expect(POLICY_SHA).not.toBe('c3'.repeat(32));
    expect(await trajectory(latest, prior)).toMatchObject({
      employeesDeltaReason: 'policy_incompatible',
      netResultDeltaReason: 'policy_incompatible',
      turnoverDelta: null,
      turnoverDeltaReason: 'policy_incompatible',
    });
  });

  it('a held prior year names itself', async () => {
    const heldPrior: CompanyFinancialYear = {
      ...prior,
      qualification: assessedQualification({ employees: 'held_observation' }, '50.00'),
    };
    expect(
      await trajectory(finYear(2024, '1100.00', '11', '60.00', '0.00'), heldPrior)
    ).toMatchObject({
      employeesDelta: null,
      employeesDeltaReason: 'prior_not_reported',
      turnoverDelta: '100.00',
    });
  });
});

describe('makeCompanyFinancialQualityAssessment', () => {
  it('normalizes the CUI and returns flags with the measured coverage range', async () => {
    const assessment = {
      // a SET with a real interior gap (FY2020 has zero corpus-wide flags)
      assessedYears: [2019, 2021, 2022, 2023, 2024, 2025],
      assessedAt: '2026-06-30',
      flags: [
        {
          year: 2024,
          flagCode: 'negative_where_unexpected',
          metricName: 'turnover',
          severity: 'warning',
          numericValue: '-1200.00',
          thresholdValue: '0.00',
        },
        // values ride in the METRIC'S unit — this one is a headcount, not RON
        {
          year: 2023,
          flagCode: 'employees_outlier',
          metricName: 'employees',
          severity: 'warning',
          numericValue: '5009387154',
          thresholdValue: '1000000',
        },
      ],
    };
    const getFinancialQualityAssessment = vi.fn(async () => ok(assessment));
    const d = deps({
      repo: { getFinancialQualityAssessment: getFinancialQualityAssessment },
    });
    const res = await makeCompanyFinancialQualityAssessment(d, 'RO2816464');
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap()).toEqual(assessment);
    // the repo must receive the NORMALIZED cui, same contract as every per-CUI path
    expect(getFinancialQualityAssessment).toHaveBeenCalledWith('2816464');
  });

  it('rejects an invalid CUI without touching the repo', async () => {
    const getFinancialQualityAssessment = vi.fn();
    const d = deps({
      repo: { getFinancialQualityAssessment: getFinancialQualityAssessment as never },
    });
    const res = await makeCompanyFinancialQualityAssessment(d, 'not-a-cui');
    expect(res.isErr()).toBe(true);
    expect((res as { error: ApiError }).error.type).toBe('InvalidInput');
    expect(getFinancialQualityAssessment).not.toHaveBeenCalled();
  });
});

describe('diffRegistryEditions (pure two-edition observation-set diff)', () => {
  type Values = Partial<Record<CompanyRegistrationField, readonly [string, string][]>>;
  const side = (
    editionId: string,
    date: string,
    inEdition: boolean,
    values: Values = {}
  ): CompanyRegistrationEditionSide => {
    const of = (field: CompanyRegistrationField) =>
      (values[field] ?? []).map(([key, display]) => ({ key, display }));
    return {
      editionId,
      sourcePublishedAt: date,
      inEdition,
      values: {
        legalName: of('legalName'),
        legalForm: of('legalForm'),
        county: of('county'),
        locality: of('locality'),
      },
      valuesComplete: true,
    };
  };
  const ACME: Values = {
    legalName: [['ACME S.R.L.', 'ACME S.R.L.']],
    legalForm: [['SRL', 'SRL']],
    county: [['IS', 'Iași']],
    locality: [['95060', 'Iași']],
  };
  const data = (
    earlier: CompanyRegistrationEditionSide | null,
    later: CompanyRegistrationEditionSide | null
  ): CompanyRegistrationDiffData => ({ registry: PUBLISHED_SCOPE, later, earlier });

  it('UNCHANGED when both editions show identical public value sets; carries both editions', () => {
    const d = diffRegistryEditions(
      data(side('6', '2026-05-06', true, ACME), side('7', '2026-07-08', true, ACME))
    );
    expect(d).toMatchObject({
      status: 'unchanged',
      reason: null,
      changes: [],
      fromEditionId: '6',
      toEditionId: '7',
      fromCaptureDate: '2026-05-06',
      toCaptureDate: '2026-07-08',
    });
  });

  it('CHANGED lists exactly the moved fields, reporting the editions’ display values', () => {
    const d = diffRegistryEditions(
      data(
        side('6', '2026-05-06', true, ACME),
        side('7', '2026-07-08', true, {
          ...ACME,
          legalName: [['ACME TRADING S.R.L.', 'ACME TRADING S.R.L.']],
          county: [['CJ', 'Cluj']],
        })
      )
    );
    expect(d.status).toBe('changed');
    expect(d.changes).toEqual([
      { field: 'legalName', from: 'ACME S.R.L.', to: 'ACME TRADING S.R.L.' },
      { field: 'county', from: 'Iași', to: 'Cluj' },
    ]);
  });

  it('compares exact public display text (no normalization damper invents sameness)', () => {
    const d = diffRegistryEditions(
      data(
        side('6', '2026-05-06', true, ACME),
        side('7', '2026-07-08', true, { ...ACME, legalName: [['Acme S.R.L.', 'Acme S.R.L.']] })
      )
    );
    expect(d.status).toBe('changed');
  });

  it('absent -> value transitions are changes (from: null)', () => {
    const noForm: Values = { ...ACME, legalForm: [] };
    const d = diffRegistryEditions(
      data(side('6', '2026-05-06', true, noForm), side('7', '2026-07-08', true, ACME))
    );
    expect(d.changes).toEqual([{ field: 'legalForm', from: null, to: 'SRL' }]);
  });

  it('APPEARED / DISAPPEARED only between two editions, as profile presence (no legal inference)', () => {
    expect(
      diffRegistryEditions(
        data(side('6', '2026-05-06', false), side('7', '2026-07-08', true, ACME))
      ).status
    ).toBe('appeared');
    expect(
      diffRegistryEditions(
        data(side('6', '2026-05-06', true, ACME), side('7', '2026-07-08', false))
      ).status
    ).toBe('disappeared');
  });

  it('the FIRST edition is not comparable — never an appearance or a disappearance', () => {
    const present = diffRegistryEditions(data(null, side('7', '2026-07-08', true, ACME)));
    expect(present).toMatchObject({ status: 'not_comparable', reason: 'first_edition' });
    const absent = diffRegistryEditions(data(null, side('7', '2026-07-08', false)));
    expect(absent).toMatchObject({ status: 'not_comparable', reason: 'not_in_edition' });
  });

  it('NOT_COMPARABLE when the CUI has no profile in either edition, or no edition is published', () => {
    expect(
      diffRegistryEditions(data(side('6', '2026-05-06', false), side('7', '2026-07-08', false)))
    ).toMatchObject({ status: 'not_comparable', reason: 'not_in_either_edition' });
    expect(
      diffRegistryEditions({ registry: UNPUBLISHED_SCOPE, later: null, earlier: null })
    ).toMatchObject({ status: 'not_comparable', reason: 'registry_unpublished' });
  });

  it('AMBIGUOUS when a field holds several public values on a side and the sets differ', () => {
    const d = diffRegistryEditions(
      data(
        side('6', '2026-05-06', true, ACME),
        side('7', '2026-07-08', true, {
          ...ACME,
          legalName: [
            ['ACME S.R.L.', 'ACME S.R.L.'],
            ['CANIFORT PREST SRL', 'CANIFORT PREST SRL'],
          ],
        })
      )
    );
    expect(d.status).toBe('ambiguous');
    expect(d.changes).toEqual([]);
    // Identical multi-value sets on both sides are simply unchanged.
    const both = {
      ...ACME,
      legalName: [
        ['A', 'A'],
        ['B', 'B'],
      ] as [string, string][],
    };
    expect(
      diffRegistryEditions(
        data(side('6', '2026-05-06', true, both), side('7', '2026-07-08', true, both))
      ).status
    ).toBe('unchanged');
  });
});

describe('makeCompanyRegistrationDiff', () => {
  it('normalizes the CUI and returns the computed diff under the pinned scope', async () => {
    const getRegistrationDiffData = vi.fn(async () =>
      ok({
        registry: PUBLISHED_SCOPE,
        earlier: {
          editionId: '6',
          sourcePublishedAt: '2026-05-06',
          inEdition: false,
          values: { legalName: [], legalForm: [], county: [], locality: [] },
          valuesComplete: true,
        },
        later: {
          editionId: '7',
          sourcePublishedAt: '2026-07-08',
          inEdition: true,
          values: {
            legalName: [{ key: 'NOVA S.R.L.', display: 'NOVA S.R.L.' }],
            legalForm: [],
            county: [],
            locality: [],
          },
          valuesComplete: true,
        },
      })
    );
    const d = deps({ repo: { getRegistrationDiffData: getRegistrationDiffData } });
    const res = await makeCompanyRegistrationDiff(d, 'RO2816464');
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().status).toBe('appeared');
    expect(getRegistrationDiffData).toHaveBeenCalledWith('2816464', PUBLISHED_SCOPE);
  });

  it('rejects an invalid CUI without touching the repo', async () => {
    const getRegistrationDiffData = vi.fn();
    const d = deps({ repo: { getRegistrationDiffData: getRegistrationDiffData } });
    const res = await makeCompanyRegistrationDiff(d, 'not-a-cui');
    expect(res.isErr()).toBe(true);
    expect(getRegistrationDiffData).not.toHaveBeenCalled();
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
      ok({ hits: [nameHit('2816464', 'DEDEMAN SRL')], degraded: true })
    );
    const listCompanies = vi.fn(async () =>
      ok({
        rows: [
          {
            cui: '2816464',
            orgId: '1',
            name: 'DEDEMAN SRL',
            nameSource: 'onrc_edition' as const,
            legalForm: 'SRL',
            headlineStatus: null,
            county: 'Bacău',
            vatPayer: true,
            declaredFiscallyInactive: false,
            registrationDate: null,
            registrationDatePresent: false,
            registryCuiState: 'in_edition' as const,
            hasActiveObservation: true,
            statusBasis: 'multiple_values' as const,
            countyBasis: 'single_observation' as const,
            recordedDateBasis: 'missing' as const,
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
    // Name resolution and the page read share ONE pinned scope, echoed back.
    expect((resolveByName.mock.calls[0] as unknown[])[3]).toBe(PUBLISHED_SCOPE);
    expect((listCompanies.mock.calls[0] as unknown[])[3]).toBe(PUBLISHED_SCOPE);
    expect(unwrap(res).registry).toBe(PUBLISHED_SCOPE);
    expect(unwrap(res).scopeKey).toBe('onrc:published:7:3:11');
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

  it('discloses name-candidate truncation: a full-cap resolve marks the total estimated + caveat (D6)', async () => {
    const cappedHits = Array.from({ length: 50 }, (_, i) =>
      nameHit(String(1000 + i), `CO ${String(i)}`)
    );
    const resolveByName = vi.fn(async () => ok({ hits: cappedHits, degraded: false }));
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 50, estimated: false }));
    const d = deps({ repo: { resolveByName, listCompanies } });
    const res = await makeCompanyList(d, {
      filter: {},
      q: 'popular name',
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(resolveByName).toHaveBeenCalledWith('popular name', 50, null, PUBLISHED_SCOPE); // repo clamps at 50 — never ask for more
    expect(unwrap(res).totalEstimated).toBe(true);
    expect(unwrap(res).caveats.some((c) => c.includes('cap'))).toBe(true);
  });

  it('below-cap name resolution stays exact (no spurious estimate)', async () => {
    const resolveByName = vi.fn(async () =>
      ok({ hits: [nameHit('2816464', 'A')], degraded: false })
    );
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 1, estimated: false }));
    const d = deps({ repo: { resolveByName, listCompanies } });
    const res = await makeCompanyList(d, {
      filter: {},
      q: 'dedeman',
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(unwrap(res).totalEstimated).toBe(false);
    expect(unwrap(res).caveats).toHaveLength(0);
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
      ok([regnumHit('11', 'A'), regnumHit('22', 'B')])
    );
    const d = deps({ repo: { findByRegistrationNumber } });
    const res = await makeCompanyResolve(d, 'regnum', 'J40/9216/2018', 10);
    expect(unwrap(res).matches).toHaveLength(2);
    expect(unwrap(res).ambiguous).toBe(true);
    // Resolved under one pinned scope, reported with the answer.
    expect(findByRegistrationNumber).toHaveBeenCalledWith('J40/9216/2018', PUBLISHED_SCOPE);
    expect(unwrap(res).registry).toBe(PUBLISHED_SCOPE);
  });

  it('name surfaces the degraded flag from the repo', async () => {
    const resolveByName = vi.fn(async () => ok({ hits: [], degraded: true }));
    const d = deps({ repo: { resolveByName } });
    const res = await makeCompanyResolve(d, 'name', 'x', 5);
    expect((res as { value: { degraded: boolean } }).value.degraded).toBe(true);
  });
});

describe('withheld identifiers (>10 digits, CNP-shaped — P0 containment 2026-07-22)', () => {
  // Synthetic test constants — no real identifier values.
  const WITHHELD_13 = '9999999999999';
  const WITHHELD_11 = '99999999999';

  it('classifies by length: >10 digits withheld, ≤10 served', () => {
    expect(isWithheldCompanyIdentifier(WITHHELD_11)).toBe(true);
    expect(isWithheldCompanyIdentifier(WITHHELD_13)).toBe(true);
    expect(isWithheldCompanyIdentifier('9999999999')).toBe(false); // 10 digits
    expect(isWithheldCompanyIdentifier('2816464')).toBe(false);
  });

  it('every by-CUI usecase rejects with the SAME typed InvalidInput and no repo/flows round-trip', async () => {
    const getProfileData = vi.fn();
    const getFinancials = vi.fn();
    const getFlowSummary = vi.fn();
    const d = deps({
      repo: { getProfileData: getProfileData as never, getFinancials: getFinancials as never },
      flows: { getFlowSummary: getFlowSummary as never },
    });
    const results = [
      await makeCompanyProfile(d, WITHHELD_13),
      await makeCompanyProfileData(d, WITHHELD_13),
      await makeCompanyFinancials(d, WITHHELD_11),
      await makeCompanyPublicMoney(d, WITHHELD_13),
      await makeCompanyFinancialQualityAssessment(d, WITHHELD_13),
      await makeCompanyRegistrationDiff(d, WITHHELD_13),
    ];
    for (const res of results) {
      expect(res.isErr()).toBe(true);
      const error = (res as { error: ApiError }).error;
      expect(error.type).toBe('InvalidInput');
      expect(error.message).toContain('not served');
    }
    expect(getProfileData).not.toHaveBeenCalled();
    expect(getFinancials).not.toHaveBeenCalled();
    expect(getFlowSummary).not.toHaveBeenCalled();
  });

  it('rejects withheld values in filter.cui eq AND exclude.cui (a probe would confirm existence)', async () => {
    const page = { page: 1, pageSize: 20 };
    // Inclusion `cui.in` is deliberately NOT here — it is a batch resolution,
    // not a probe, and is covered by the two tests below.
    const cases = [
      { cui: { eq: WITHHELD_13 } },
      { exclude: { cui: { eq: WITHHELD_13 } } },
      { exclude: { cui: { in: [WITHHELD_11] } } },
    ];
    for (const filter of cases) {
      const res = await makeCompanyList(deps(), { filter, sort: 'name', page });
      expect(res.isErr()).toBe(true);
      expect((res as { error: ApiError }).error.type).toBe('InvalidInput');
    }
  });

  it('drops withheld ids from an inclusion cui.in and serves the rest (one bad id must not blank a batch)', async () => {
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
    const res = await makeCompanyList(deps({ repo: { listCompanies } }), {
      filter: { cui: { in: ['2816464', WITHHELD_11, WITHHELD_13] } },
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });

    expect(res.isOk()).toBe(true);
    expect(
      (res as unknown as { value: { caveats: readonly string[] } }).value.caveats.join(' ')
    ).toContain('not served');
    // The withheld ids must never reach SQL — dropped at the usecase boundary.
    const calls = listCompanies.mock.calls as unknown as [{ cui: { in: string[] } }][];
    expect(calls[0]?.[0].cui.in).toEqual(['2816464']);
  });

  it('answers an EMPTY page when every requested id is withheld (an empty `in` compiles to no predicate)', async () => {
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
    const res = await makeCompanyList(deps({ repo: { listCompanies } }), {
      filter: { cui: { in: [WITHHELD_11, WITHHELD_13] } },
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });

    expect(res.isOk()).toBe(true);
    expect((res as unknown as { value: { total: number } }).value.total).toBe(0);
    // The load-bearing assertion: an all-withheld batch must NOT reach the repo,
    // where an emptied `in` would drop the predicate and scan the whole table.
    expect(listCompanies).not.toHaveBeenCalled();
  });

  it('drops withheld CUIs from name-resolved hits on the list path (empty page, not a leak)', async () => {
    const resolveByName = vi.fn(async () =>
      ok({ hits: [nameHit(WITHHELD_13, 'X PFA')], degraded: false })
    );
    const listCompanies = vi.fn(async () => ok({ rows: [], total: 0, estimated: false }));
    const d = deps({ repo: { resolveByName, listCompanies } });
    const res = await makeCompanyList(d, {
      filter: {},
      q: 'x',
      sort: 'name',
      page: { page: 1, pageSize: 20 },
    });
    expect(unwrap(res).total).toBe(0);
    expect(listCompanies).not.toHaveBeenCalled(); // never queries with the withheld CUI
  });

  it('drops withheld hits from resolve (name + regnum) and recomputes ambiguity', async () => {
    const resolveByName = vi.fn(async () =>
      ok({ hits: [nameHit('2816464', 'A'), nameHit(WITHHELD_13, 'W PFA')], degraded: false })
    );
    const findByRegistrationNumber = vi.fn(async () => ok([regnumHit(WITHHELD_11, 'R PFA')]));
    const d = deps({ repo: { resolveByName, findByRegistrationNumber } });
    const nameRes = unwrap(await makeCompanyResolve(d, 'name', 'x', 10));
    expect(nameRes.matches).toHaveLength(1);
    expect(nameRes.matches[0]?.cui).toBe('2816464');
    expect(nameRes.ambiguous).toBe(false); // 1 surviving hit, not 2
    const regnumRes = unwrap(await makeCompanyResolve(d, 'regnum', 'F0/0/0', 10));
    expect(regnumRes.matches).toHaveLength(0);
  });

  it('contributor answers absence (null, not error) for withheld CUIs — no badge, nothing confirmed', async () => {
    const presenceCounts = vi.fn();
    const profileSlicesForCuis = vi.fn();
    const captureRegistryScope = vi.fn();
    const contributor = makeCompaniesContributor(
      stubRepo({
        presenceCounts: presenceCounts as never,
        profileSlicesForCuis: profileSlicesForCuis as never,
        captureRegistryScope: captureRegistryScope as never,
      })
    );
    expect(unwrap(await contributor.presenceFor(WITHHELD_13))).toBeNull();
    const slice = contributor.profileSlice;
    expect(slice).toBeDefined();
    if (slice !== undefined) expect(unwrap(await slice(WITHHELD_13))).toBeNull();
    expect(presenceCounts).not.toHaveBeenCalled();
    expect(profileSlicesForCuis).not.toHaveBeenCalled();
    // Not even a registry scope is captured for a withheld identifier.
    expect(captureRegistryScope).not.toHaveBeenCalled();
  });
});

describe('error propagation', () => {
  it('surfaces a repo Database error from the profile usecase', async () => {
    const dbErr: ApiError = { type: 'Database', message: 'boom' };
    const d = deps({
      repo: {
        getProfileData: vi.fn(async (): Promise<Result<CompanyProfileData | null, ApiError>> =>
          err(dbErr)
        ),
      },
    });
    const res = await makeCompanyProfile(d, '2816464');
    expect((res as { error: ApiError }).error.type).toBe('Database');
  });
});
