/**
 * The analysis API's contract grain from the money build (PROC-KB0Z slice a): the scope
 * compiles to the totals' filters, recordCount is the record population, money and
 * withValueCount follow the totals rule (`exclusionOf`), D6 decides supplier scopes as totals
 * do, and the shapes not served yet abstain rather than fail a request.
 */
import { err, ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  analysisBreakdown,
  analysisConcentration,
  analysisRecords,
  analysisSeries,
  analysisStats,
} from '@/modules/procurement/core/analysis-usecases.js';
import {
  CA_MONEY_JOINT_NOTE,
  CA_MONEY_VALUE_NOTE,
  caMoneyBuildId,
  caMoneySeries,
  caMoneyStats,
  caMoneyVerdict,
  compileCaMoneyScope,
  recordShapesOf,
  type CaMoneyCoverage,
  type CaMoneyPort,
  type CaMoneyQuery,
  type CaMoneyRow,
} from '@/modules/procurement/core/ca-money-analysis.js';
import {
  moneyTotals,
  type AggregateFilters,
  type MoneyTotalsPort,
  type ValueKind,
} from '@/modules/procurement/core/money-totals.js';
import { makeCaMoneyAnalysisSource } from '@/modules/procurement/shell/repo/ca-money-analysis-source.js';
import { makeDaRoutingAnalysisRepo } from '@/modules/procurement/shell/repo/da-routing-analysis-repo.js';
import {
  serviceUnavailable,
  type ApiError,
  type PublicSupplierCodes,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';

import { fakeAnalysisRepo, generation } from './analysis-fakes.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';

const row = (over: Partial<CaMoneyRow> = {}): CaMoneyRow => ({
  valueKind: 'awarded',
  status: 'awarded',
  additive: true,
  dated: true,
  inRange: true,
  hasAmount: true,
  jointWin: false,
  vatBasis: 'unknown',
  currency: 'RON',
  unverifiedHead: false,
  listValue: false,
  withheldSupplier: false,
  count: 10n,
  sumBani: 100_000n,
  nativeSumMinor: 100_000n,
  contractKind: 'ordinary',
  month: '2025-03',
  ...over,
});

const compiled = (scope: AnalysisScope): CaMoneyQuery => compileCaMoneyScope(scope)._unsafeUnwrap();

const PUBLIC_CODE = '14837428';

describe('the contract grain scope', () => {
  it('selects purchases by default, ceilings only when asked, and intersects recordKind', () => {
    const kinds = (scope: AnalysisScope) =>
      recordShapesOf(scope).map((s) => `${s.contractKind}/${s.valueKind}`);
    expect(kinds({})).toEqual(['ordinary/awarded', 'call_off/awarded']);
    expect(kinds({ recordKind: 'contract_award' })).toEqual([
      'ordinary/awarded',
      'call_off/awarded',
    ]);
    expect(
      kinds({ recordKind: 'framework_agreement', frameworkRole: 'framework_ceiling' })
    ).toEqual(['framework_agreement/framework_ceiling']);
    // A framework agreement is never a purchase: the default selects none of them.
    expect(kinds({ recordKind: 'framework_agreement' })).toEqual([]);
    expect(kinds({ frameworkRole: 'standalone' })).toEqual(['ordinary/awarded']);
    expect(kinds({ frameworkRole: 'call_off' })).toEqual(['call_off/awarded']);
    expect(kinds({ frameworkRole: 'all' })).toEqual([
      'ordinary/awarded',
      'call_off/awarded',
      'framework_agreement/framework_ceiling',
    ]);
  });

  it('compiles to the totals filters: whole months, CPV trimmed to its level, parties', () => {
    const query = compiled({
      authorityCui: '4305857',
      supplierCui: '14837428',
      cpvGroup: '45200000',
      from: '2024-02',
      to: '2025-02',
    });
    expect(query.filters).toMatchObject({
      procurementKinds: ['contract_award'],
      contractKinds: ['ordinary', 'call_off'],
      from: '2024-02-01',
      to: '2025-02-28',
      buyerCode: '4305857',
      supplierCode: '14837428',
      cpvPrefix: '452',
    });
    expect(query.valueKinds).toEqual(['awarded']);
    expect(query.bounded).toBe(true);
    expect(compiled({ year: 2024 }).filters).toMatchObject({
      from: '2024-01-01',
      to: '2024-12-31',
    });
    expect(compiled({ cpvCode: '44110000' }).filters.cpvPrefix).toBe('44110000');
  });

  it('refuses the scope fields it cannot apply yet', () => {
    for (const scope of [
      { buyerCounty: 'CJ' },
      { buyerRegion: 'RO11' },
      { status: 'awarded' },
      { procedureType: 'licitatie deschisa' },
      { q: 'drumuri' },
      { valueMin: 10 },
    ] as AnalysisScope[]) {
      const result = compileCaMoneyScope(scope);
      expect(result._unsafeUnwrapErr().type).toBe('InvalidInput');
    }
  });
});

describe('contract grain figures', () => {
  const rows: CaMoneyRow[] = [
    row(), // 10 counted, 1,000 lei
    row({ status: 'identity_review', additive: false, count: 2n, sumBani: 20_000n }),
    row({ additive: false, count: 1n, sumBani: 5_000n, month: '2025-04' }),
    row({ hasAmount: false, count: 3n, sumBani: 0n }),
    row({ dated: false, inRange: false, month: null, count: 4n, sumBani: 40_000n }),
    row({ jointWin: true, count: 5n, sumBani: 50_000n, month: '2025-05' }),
    // Not a shape of the default scope: never counted.
    row({ contractKind: 'framework_agreement', valueKind: 'framework_ceiling', count: 99n }),
  ];

  it('counts the population and sums what totals count (no window, no supplier)', () => {
    const stats = caMoneyStats(rows, compiled({}));
    expect(stats.rows).toBe('25');
    // Counted: 10 + 4 undated (no window applies) + 5 joint (no supplier scope).
    expect(stats.withValue).toBe('19');
    expect(stats.valueAwardedSum).toBe('1900.00');
    expect(stats.undatedCount).toBe('4');
    expect(stats.undatedValueRon).toBe('400.00');
    expect(stats.minMonth).toBe('2025-03');
    expect(stats.maxMonth).toBe('2025-05');
    expect(stats.valueWithheldAssociationSum).toBeNull();
  });

  it('a window counts dated facts only, the undated ones beside it', () => {
    const stats = caMoneyStats(rows, compiled({ from: '2025-01', to: '2025-12' }));
    expect(stats.rows).toBe('21');
    expect(stats.withValue).toBe('15');
    expect(stats.valueAwardedSum).toBe('1500.00');
    expect(stats.undatedCount).toBe('4');
    expect(stats.undatedValueRon).toBe('400.00');
  });

  it('a supplier scope leaves joint wins out of money and counts them in recordCount', () => {
    const stats = caMoneyStats(rows, compiled({ supplierCui: '14837428' }));
    expect(stats.rows).toBe('25');
    expect(stats.withValue).toBe('14');
    expect(stats.valueAwardedSum).toBe('1400.00');
    expect(stats.valueWithheldAssociationSum).toBe('500.00');
  });

  it('a scope with no counted fact has no money, not zero money', () => {
    const stats = caMoneyStats([row({ status: 'identity_review', additive: false })], compiled({}));
    expect(stats.rows).toBe('10');
    expect(stats.withValue).toBe('0');
    expect(stats.valueAwardedSum).toBeNull();
  });

  it('a series buckets by month, the undated bucket last and valueless', () => {
    const series = caMoneySeries(rows, compiled({}), 'recordCount');
    expect(series.map((r) => [r.month, r.value])).toEqual([
      ['2025-03', '15'],
      ['2025-04', '1'],
      ['2025-05', '5'],
      [null, '0'],
    ]);
    const money = caMoneySeries(rows, compiled({}), 'valueAwardedSum');
    expect(money.map((r) => r.value)).toEqual(['1000.00', '0.00', '500.00', null]);
    expect(money.at(-1)?.recordCount).toBe('4');
  });

  it('measures coverage into a verdict and names the build by build and floor', () => {
    const coverage: CaMoneyCoverage = {
      total: '1000',
      dated: '999',
      counted: '980',
      valued: '980',
      withCpv: '1000',
      withGeo: '600',
      moneyBani: '100',
      moneyDatedBani: '100',
      moneyGeoBani: '50',
    };
    const verdict = caMoneyVerdict(coverage);
    expect(verdict.classes).toEqual({ spend: 'allow', time: 'allow', geo: 'degraded' });
    expect(verdict.coverage.date).toBe(0.999);
    expect(caMoneyBuildId('2', '2021-01-01')).toBe('220210101');
    expect(caMoneyBuildId('2', '2018-01-01')).not.toBe(caMoneyBuildId('2', '2021-01-01'));
  });
});

describe('contract grain figures against procurementTotals (one fixture)', () => {
  const rows: CaMoneyRow[] = [
    row(),
    row({ status: 'identity_review', additive: false, count: 2n, sumBani: 20_000n }),
    row({ additive: false, count: 1n, sumBani: 5_000n }),
    row({ hasAmount: false, count: 3n, sumBani: 0n }),
    row({ dated: false, inRange: false, month: null, count: 4n, sumBani: 40_000n }),
    row({ jointWin: true, count: 5n, sumBani: 50_000n, month: '2025-05' }),
  ];
  const totalsPort = (asked: readonly CaMoneyRow[]): MoneyTotalsPort => ({
    activeBuild: () => Promise.resolve(ok('2')),
    caFloor: () => Promise.resolve(ok(null)),
    labels: () => Promise.resolve(ok([])),
    supplierRef: () => Promise.resolve(ok('r1')),
    aggregate: (_build, filters) =>
      Promise.resolve(
        ok(
          // The shell's WHERE drops dated facts outside a range; this fixture is all 2025.
          asked.filter(
            (r) => filters.from === null || !r.dated || r.month?.startsWith('2025') === true
          )
        )
      ),
  });
  const totalsOf = async (supplierCode: string | null, from: string | null, to: string | null) =>
    (
      await moneyTotals(totalsPort(rows), [
        {
          id: 't',
          filters: {
            procurementKinds: ['contract_award'],
            contractKinds: ['ordinary', 'call_off'],
            supplierCode,
            from,
            to,
          },
          valueKinds: ['awarded'],
        },
      ])
    )._unsafeUnwrap()[0];

  for (const supplier of [null, PUBLIC_CODE]) {
    it(`no window${supplier === null ? '' : ', a supplier'}: recordCount is the population, money is totals’`, async () => {
      const t = await totalsOf(supplier, null, null);
      const stats = caMoneyStats(
        rows,
        compiled(supplier === null ? {} : { supplierCui: supplier })
      );
      expect(stats.rows).toBe(t?.population[0]?.count);
      expect(stats.withValue).toBe(t?.totals[0]?.recordCount);
      expect(stats.valueAwardedSum).toBe(t?.totals[0]?.sumLei);
      const joint =
        t?.exclusions.find((e) => e.key === 'association_unattributed')?.valueLei ?? null;
      expect(stats.valueWithheldAssociationSum).toBe(joint);
    });
  }

  it('a window: recordCount plus undatedInScope is the population; money is totals’', async () => {
    const t = await totalsOf(null, '2025-01-01', '2025-12-31');
    const stats = caMoneyStats(rows, compiled({ year: 2025 }));
    expect((BigInt(stats.rows) + BigInt(stats.undatedCount)).toString()).toBe(
      t?.population[0]?.count
    );
    expect(stats.withValue).toBe(t?.totals[0]?.recordCount);
    expect(stats.valueAwardedSum).toBe(t?.totals[0]?.sumLei);
  });
});

// ── the source and the usecases over a fake money build ─────────────────────

const PUBLIC = '14837428';
const AS_OF = '2026-11-28T10:00:00.000000Z';

const codes = (asOf: string, list: readonly string[] = [PUBLIC]): PublicSupplierCodes =>
  Object.assign(new Set(list), { asOf });

const d6Port = (keys: string[] = [AS_OF]): SupplierDisclosurePort & { calls: number } => {
  const port = {
    enforced: true,
    calls: 0,
    publicSupplierCodes: () => {
      const asOf = keys[Math.min(port.calls, keys.length - 1)] ?? AS_OF;
      port.calls += 1;
      return Promise.resolve(ok(codes(asOf)));
    },
    privacyAsOf: () => Promise.resolve(ok(AS_OF)),
  };
  return port;
};

interface FakePort {
  readonly port: CaMoneyPort;
  readonly reads: {
    filters: AggregateFilters;
    ref: string | null;
    kinds: readonly ValueKind[];
    floor: string;
  }[];
}

const fakePort = (
  options: {
    build?: Result<string | null, ApiError>;
    floor?: string | null;
    refs?: Record<string, string>;
    rows?: readonly CaMoneyRow[];
  } = {}
): FakePort => {
  const reads: FakePort['reads'] = [];
  return {
    reads,
    port: {
      activeBuild: () => Promise.resolve(options.build ?? ok('2')),
      caFloor: () => Promise.resolve(ok(options.floor ?? null)),
      supplierRef: (_build, code) => Promise.resolve(ok(options.refs?.[code] ?? null)),
      contractRows: (_build, filters, ref, kinds, floor) => {
        reads.push({ filters, ref, kinds, floor });
        return Promise.resolve(ok(options.rows ?? [row()]));
      },
      contractCoverage: () =>
        Promise.resolve(
          ok({
            total: '100',
            dated: '100',
            counted: '100',
            valued: '100',
            withCpv: '100',
            withGeo: '100',
            moneyBani: '1',
            moneyDatedBani: '1',
            moneyGeoBani: '1',
          })
        ),
    },
  };
};

const deps = (port: CaMoneyPort, d6: SupplierDisclosurePort = d6Port()) => {
  // Legacy procurement retired: no base generation; only the contract grain is routed.
  const base = fakeAnalysisRepo({ generation: null });
  return {
    analysisRepo: makeDaRoutingAnalysisRepo(
      base.repo,
      undefined,
      undefined,
      makeCaMoneyAnalysisSource(port, d6)
    ),
  };
};

describe('the money-build contract source', () => {
  it('answers contract stats from the money build with its own build id, D6 key and basis', async () => {
    const fake = fakePort();
    const result = await analysisStats(deps(fake.port), { scope: { grain: 'contract' } });
    const block = result._unsafeUnwrap().blocks[0];
    expect(block?.grain).toBe('contract');
    expect(block?.recordCount).toBe('10');
    expect(block?.valueAwardedSum).toBe('1000.00');
    expect(block?.meta.buildId).toBe('220210101');
    expect(block?.meta.disclosureKey).toBe(AS_OF);
    expect(block?.meta.dateBasis).toMatch(/^award_day/u);
    expect(block?.meta.caveats).toContain(CA_MONEY_VALUE_NOTE);
    expect(fake.reads[0]?.floor).toBe('2021-01-01');
    // A pin of the contract grain's own build is accepted; any other is refused.
    const pinned = await analysisStats(deps(fake.port), {
      scope: { grain: 'contract' },
      build: '220210101',
    });
    expect(pinned.isOk()).toBe(true);
  });

  it('reads the build’s recorded floor, and a new floor is a new build id', async () => {
    const fake = fakePort({ floor: '2018-01-01' });
    const block = (
      await analysisStats(deps(fake.port), { scope: { grain: 'contract' } })
    )._unsafeUnwrap().blocks[0];
    expect(block?.meta.buildId).toBe('220180101');
    expect(fake.reads[0]?.floor).toBe('2018-01-01');
  });

  it('a supplier not public now, or without an id in the build, reads nothing', async () => {
    const notPublic = fakePort({ refs: { '999999': 'r9' } });
    const a = await analysisStats(deps(notPublic.port), {
      scope: { grain: 'contract', supplierCui: '999999' },
    });
    expect(a._unsafeUnwrap().blocks[0]?.recordCount).toBe('0');
    expect(notPublic.reads).toEqual([]);

    const noRef = fakePort();
    const b = await analysisStats(deps(noRef.port), {
      scope: { grain: 'contract', supplierCui: PUBLIC },
    });
    expect(b._unsafeUnwrap().blocks[0]?.recordCount).toBe('0');
    expect(noRef.reads).toEqual([]);

    const publicRef = fakePort({ refs: { [PUBLIC]: 'r1' } });
    const c = await analysisStats(deps(publicRef.port), {
      scope: { grain: 'contract', supplierCui: PUBLIC },
    });
    const block = c._unsafeUnwrap().blocks[0];
    expect(block?.recordCount).toBe('10');
    expect(block?.meta.caveats).toContain(CA_MONEY_JOINT_NOTE);
    expect(publicRef.reads[0]?.ref).toBe('r1');
  });

  it('refuses an answer whose D6 publication moved during the request', async () => {
    const fake = fakePort({ refs: { [PUBLIC]: 'r1' } });
    // generation, pre-read, then the fresh check sees a newer publication.
    const moved = d6Port([AS_OF, AS_OF, '2026-11-28T11:00:00.000000Z']);
    const result = await analysisStats(deps(fake.port, moved), {
      scope: { grain: 'contract', supplierCui: PUBLIC },
    });
    expect(result._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });

  it('serves the anchor series measures and abstains on distinct counts', async () => {
    const fake = fakePort({ rows: [row(), row({ month: '2025-04', count: 3n })] });
    const series = (
      await analysisSeries(deps(fake.port), {
        scope: { grain: 'contract', recordKind: 'contract_award' },
        bucket: 'month',
        measure: 'recordCount',
      })
    )._unsafeUnwrap()[0];
    expect(series?.points.map((p) => [p.bucket, p.value])).toEqual([
      ['2025-03', '10'],
      ['2025-04', '3'],
    ]);
    const years = (
      await analysisSeries(deps(fake.port), {
        scope: { grain: 'contract' },
        bucket: 'year',
        measure: 'recordCount',
      })
    )._unsafeUnwrap()[0];
    expect(years?.points.map((p) => [p.bucket, p.value])).toEqual([['2025', '13']]);
    const distinct = (
      await analysisSeries(deps(fake.port), {
        scope: { grain: 'contract' },
        bucket: 'year',
        measure: 'distinctSuppliers',
      })
    )._unsafeUnwrap()[0];
    expect(distinct?.meta.answerability).toBe('abstained');
  });

  it('abstains on breakdowns, concentration and records instead of failing the request', async () => {
    const fake = fakePort();
    const d = deps(fake.port);
    const breakdown = (
      await analysisBreakdown(d, { scope: { grain: 'contract' }, dimension: 'supplier' })
    )._unsafeUnwrap()[0];
    expect(breakdown?.meta.answerability).toBe('abstained');
    expect(breakdown?.meta.reason).toBe('GENERATION_LACKS_CAPABILITY');
    const concentration = (
      await analysisConcentration(d, { scope: { grain: 'contract' } })
    )._unsafeUnwrap()[0];
    expect(concentration?.meta.answerability).toBe('abstained');
    const records = (await analysisRecords(d, { scope: { grain: 'contract' } }))._unsafeUnwrap();
    expect(records.meta.answerability).toBe('abstained');
    expect(records.total).toBeNull();
    expect(fake.reads).toEqual([]);
  });

  it('a scope whose record kinds select nothing reads nothing', async () => {
    const fake = fakePort();
    const block = (
      await analysisStats(deps(fake.port), {
        scope: { grain: 'contract', recordKind: 'framework_agreement' },
      })
    )._unsafeUnwrap().blocks[0];
    expect(block?.recordCount).toBe('0');
    expect(fake.reads).toEqual([]);
  });

  it('refuses a scope field it cannot apply, naming it', async () => {
    const result = await analysisStats(deps(fakePort().port), {
      scope: { grain: 'contract', buyerCounty: 'CJ' },
    });
    const error = result._unsafeUnwrapErr();
    expect(error.type).toBe('InvalidInput');
    expect(error.message).toMatch(/buyer county/u);
  });

  it('an unreadable money build abstains the contract grain before any read', async () => {
    const fake = fakePort({ build: err(serviceUnavailable('down')) });
    const base = fakeAnalysisRepo();
    const d = {
      analysisRepo: makeDaRoutingAnalysisRepo(
        base.repo,
        undefined,
        undefined,
        makeCaMoneyAnalysisSource(fake.port, d6Port())
      ),
    };
    const blocks = (await analysisStats(d, { scope: {} }))._unsafeUnwrap().blocks;
    const contract = blocks.find((b) => b.grain === 'contract');
    expect(contract?.meta.answerability).toBe('abstained');
    expect(contract?.recordCount).toBeNull();
    expect(fake.reads).toEqual([]);
    // The other grains still answer from the base.
    expect(blocks.find((b) => b.grain === 'procedure')?.meta.answerability).not.toBe('abstained');
    expect(base.calls.filter((call) => call.grain === 'contract')).toEqual([]);
  });
});

describe('the money-build contract source, review round 1', () => {
  it('echoes a withheld supplier as withheld, and re-checks D6 on an answer it did not read', async () => {
    const fake = fakePort();
    const d6 = d6Port();
    const d = { ...deps(fake.port, d6), supplierDisclosure: d6 };
    const block = (
      await analysisStats(d, { scope: { grain: 'contract', supplierCui: '999999' } })
    )._unsafeUnwrap().blocks[0];
    expect(block?.meta.canonicalScope).toContain('withheld');
    expect(block?.meta.canonicalScope).not.toContain('999999');

    // A public code without an id in the build reads nothing, and is still re-checked.
    const moved = d6Port([AS_OF, AS_OF, '2026-11-28T11:00:00.000000Z']);
    const raced = await analysisStats(deps(fakePort().port, moved), {
      scope: { grain: 'contract', supplierCui: PUBLIC },
    });
    expect(raced._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
  });

  it('serves a public supplier’s joint-win money as totals quote it', async () => {
    const fake = fakePort({
      refs: { [PUBLIC]: 'r1' },
      rows: [row(), row({ jointWin: true, count: 5n, sumBani: 50_000n })],
    });
    const block = (
      await analysisStats(deps(fake.port), { scope: { grain: 'contract', supplierCui: PUBLIC } })
    )._unsafeUnwrap().blocks[0];
    expect(block?.valueAwardedSum).toBe('1000.00');
    expect(block?.valueWithheldAssociationSum).toBe('500.00');
    expect(block?.recordCount).toBe('15');
  });

  it('abstains on unserved shapes even with a scope field stats would refuse', async () => {
    const fake = fakePort();
    const d = deps(fake.port);
    const breakdown = (
      await analysisBreakdown(d, {
        scope: { grain: 'contract', buyerCounty: 'CJ' },
        dimension: 'supplier',
      })
    )._unsafeUnwrap()[0];
    expect(breakdown?.meta.answerability).toBe('abstained');
    const distinct = (
      await analysisSeries(d, {
        scope: { grain: 'contract', buyerCounty: 'CJ' },
        bucket: 'year',
        measure: 'distinctAuthorities',
      })
    )._unsafeUnwrap()[0];
    expect(distinct?.meta.answerability).toBe('abstained');
    const records = (
      await analysisRecords(d, { scope: { grain: 'contract', buyerCounty: 'CJ' } })
    )._unsafeUnwrap();
    expect(records.meta.answerability).toBe('abstained');
    expect(fake.reads).toEqual([]);
  });

  it('decides record kinds and supplier places by its own rules, not the base build’s', async () => {
    // A live base build without framework_role and with supplier geography served.
    const base = fakeAnalysisRepo({
      generation: generation(undefined, { frameworkRole: false, supplierGeography: true }),
    });
    const fake = fakePort({ rows: [row({ contractKind: 'call_off' })] });
    const d = {
      analysisRepo: makeDaRoutingAnalysisRepo(
        base.repo,
        undefined,
        undefined,
        makeCaMoneyAnalysisSource(fake.port, d6Port())
      ),
    };
    const callOffs = await analysisStats(d, {
      scope: { grain: 'contract', frameworkRole: 'call_off' },
    });
    expect(callOffs._unsafeUnwrap().blocks[0]?.recordCount).toBe('10');
    expect(fake.reads[0]?.filters.contractKinds).toEqual(['call_off']);
    const placed = await analysisStats(d, { scope: { grain: 'contract', supplierCounty: 'CJ' } });
    expect(placed._unsafeUnwrapErr().message).toMatch(/supplier geography/u);
  });

  it('a build whose coverage cannot be read, or whose id cannot be pinned, abstains', async () => {
    // A live base build answers the other grains; the contract grain's own source fails.
    const withBase = (port: CaMoneyPort) => ({
      analysisRepo: makeDaRoutingAnalysisRepo(
        fakeAnalysisRepo().repo,
        undefined,
        undefined,
        makeCaMoneyAnalysisSource(port, d6Port())
      ),
    });
    const unreadable = fakePort();
    const noCoverage: CaMoneyPort = {
      ...unreadable.port,
      contractCoverage: () => Promise.resolve(err(serviceUnavailable('denied'))),
    };
    const a = (
      await analysisStats(withBase(noCoverage), { scope: { grain: 'contract' } })
    )._unsafeUnwrap().blocks[0];
    expect(a?.meta.answerability).toBe('abstained');
    expect(unreadable.reads).toEqual([]);

    const huge = fakePort({ build: ok('123456789012') });
    const b = (
      await analysisStats(withBase(huge.port), { scope: { grain: 'contract' } })
    )._unsafeUnwrap().blocks[0];
    expect(b?.meta.answerability).toBe('abstained');
    expect(huge.reads).toEqual([]);
  });
});
