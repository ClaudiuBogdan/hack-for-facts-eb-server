/**
 * Site-wide D6 on the switch of its own (root, 2026-11-18), from the phase-2
 * review: the ClickHouse DA grain decorator, the publish-crossing re-checks on
 * the legacy decorator and the kernel flows, the echoed scope, the supplier
 * bucket kinds, and the presence leg. A code is public until a nightly publish
 * withholds it MID-request; the answer must then withhold it too.
 */
import { ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { analysisBreakdown, analysisStats } from '@/modules/procurement/core/analysis-usecases.js';
import { routeAnalysis } from '@/modules/procurement/core/combinations.js';
import { withDaAnalysisDisclosure } from '@/modules/procurement/shell/repo/da-analysis-disclosure.js';
import { withDaDisclosure } from '@/modules/procurement/shell/repo/da-disclosure-repo.js';
import { withSupplierDisclosure } from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { fakeAnalysisRepo, statsRead } from './analysis-fakes.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import type {
  AnalysisRecordRow,
  AnalysisRepo,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';
import type { ProcurementDirectAcquisition } from '@/modules/procurement/core/types.js';
import type { FlowReadOptions, FlowsRepo, SupplierDisclosurePort } from '@/modules/shared/index.js';

const COMPANY = '14399840';
const SOLE_TRADER = '30254716';

/** A port whose public set changes after `flipAfter` reads (a nightly publish mid-request). */
const port = (sets: readonly (readonly string[])[]): SupplierDisclosurePort => {
  let reads = 0;
  return {
    enforced: true,
    privacyAsOf: () => Promise.resolve(ok('2026-11-18T03:10:00.000000Z')),
    publicSupplierCodes: () => {
      const set = sets[Math.min(reads, sets.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(ok(new Set(set)));
    },
  };
};

const DA_ROUTE = { grain: 'direct_acquisition' } as never;

const record = (over: Partial<AnalysisRecordRow>): AnalysisRecordRow => ({
  id: '1',
  date: '2025-06-02',
  title: 'SECRET title',
  authorityCui: '4305857',
  authorityName: 'COMUNA',
  supplierCui: COMPANY,
  supplierName: 'FIRMA SRL',
  valueRon: '10.00',
  status: null,
  recordKind: null,
  cpvCode: '44110000-4',
  ...over,
});

const innerAnalysis = () => {
  const scopes: (string | undefined)[] = [];
  const repo = {
    statsFor: (_r: unknown, scope: AnalysisScope) => {
      scopes.push(scope.supplierCui);
      return Promise.resolve(ok(statsRead()));
    },
    breakdownFor: () =>
      Promise.resolve(
        ok({
          rankedBy: 'value',
          totals: statsRead(),
          buckets: [
            { kind: 'top', key: COMPANY, recordCount: '1', withValue: '1', valueAwardedSum: '5' },
            {
              kind: 'top',
              key: SOLE_TRADER,
              recordCount: '2',
              withValue: '2',
              valueAwardedSum: '7',
            },
            { kind: 'top', key: '1111', recordCount: '1', withValue: '1', valueAwardedSum: '1' },
            { kind: 'other', key: null, recordCount: '3', withValue: '3', valueAwardedSum: '3' },
          ],
        })
      ),
    recordsFor: () =>
      Promise.resolve(
        ok({
          total: '2',
          rows: [
            record({}),
            record({ id: '2', supplierCui: SOLE_TRADER, supplierName: 'SECRET PFA' }),
          ],
        })
      ),
  } as unknown as AnalysisRepo;
  return { repo, scopes };
};

describe('ClickHouse DA grain under D6', () => {
  it('matches nothing for a withheld scope, and re-runs when a publish withholds it mid-request', async () => {
    const withheld = innerAnalysis();
    await withDaAnalysisDisclosure(withheld.repo, port([[COMPANY]])).statsFor(
      DA_ROUTE,
      { supplierCui: SOLE_TRADER },
      {} as never
    );
    expect(withheld.scopes).toEqual(['~withheld']);

    const crossing = innerAnalysis();
    await withDaAnalysisDisclosure(crossing.repo, port([[SOLE_TRADER], []])).statsFor(
      DA_ROUTE,
      { supplierCui: SOLE_TRADER },
      {} as never
    );
    expect(crossing.scopes).toEqual([SOLE_TRADER, '~withheld']);
  });

  it('merges withheld top buckets into one natural_person bucket, re-ranked', async () => {
    const { repo } = innerAnalysis();
    const read = await withDaAnalysisDisclosure(repo, port([[COMPANY]])).breakdownFor(
      DA_ROUTE,
      {},
      {} as never,
      'supplier',
      10,
      'value'
    );
    expect(read._unsafeUnwrap().buckets.map((b) => [b.kind, b.key, b.valueAwardedSum])).toEqual([
      ['top', 'natural_person', '8'],
      ['top', COMPANY, '5'],
      ['other', null, '3'],
    ]);
  });

  it('a supplier-scoped records page withheld by the final check carries nothing of that supplier', async () => {
    const scopes: (string | undefined)[] = [];
    const repo = {
      recordsFor: (_r: unknown, scope: AnalysisScope) => {
        scopes.push(scope.supplierCui);
        return Promise.resolve(
          scope.supplierCui === '~withheld'
            ? ok({ total: '0', rows: [] })
            : ok({
                total: '9',
                rows: [record({ supplierCui: SOLE_TRADER, supplierName: 'SECRET PFA' })],
              })
        );
      },
    } as unknown as AnalysisRepo;
    const read = await withDaAnalysisDisclosure(repo, port([[SOLE_TRADER], []])).recordsFor(
      DA_ROUTE,
      { supplierCui: SOLE_TRADER },
      {} as never,
      { sort: 'date_desc', offset: 0, limit: 10 }
    );
    expect(scopes).toEqual([SOLE_TRADER, '~withheld']);
    expect(read._unsafeUnwrap()).toEqual({ total: '0', rows: [] });
  });

  it('serves records with no withheld code, name or title', async () => {
    const { repo } = innerAnalysis();
    const read = await withDaAnalysisDisclosure(repo, port([[COMPANY]])).recordsFor(
      DA_ROUTE,
      {},
      {} as never,
      { sort: 'date_desc', offset: 0, limit: 10 }
    );
    const raw = JSON.stringify(read);
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain(SOLE_TRADER);
    expect(read._unsafeUnwrap().rows.map((r) => r.supplierDisplayKind)).toEqual([
      'company',
      'natural_person',
    ]);
  });

  it('is the repository itself when D6 is off', () => {
    const { repo } = innerAnalysis();
    expect(withDaAnalysisDisclosure(repo, undefined)).toBe(repo);
  });
});

describe('legacy DA reads across a publish', () => {
  const da = (cui: string) =>
    ({
      daId: '1',
      title: 'SECRET',
      supplierCui: cui,
      supplierName: 'SECRET PFA',
      cpvCode: null,
    }) as unknown as ProcurementDirectAcquisition;

  it('withholds a supplier that a publish withheld between authorisation and the read', async () => {
    const calls: unknown[] = [];
    const repo = {
      listCpvCodeLabels: () => Promise.resolve(ok([])),
      searchDirectAcquisitionsOffset: () =>
        Promise.resolve(
          ok({ items: [da(SOLE_TRADER)], total: 7, estimated: false, facets: { status: [] } })
        ),
      listDirectAcquisitions: (filter: unknown) => {
        calls.push(filter);
        return Promise.resolve(ok({ items: [da(SOLE_TRADER)], next: null }));
      },
      supplierRecords: (_c: string, _f: number, _a: unknown, _i: boolean, includeDas?: boolean) => {
        calls.push(includeDas);
        return Promise.resolve(
          ok({
            total: null,
            hasNextPage: includeDas !== false,
            endCursor: includeDas === false ? null : 'DA-CURSOR',
            edges:
              includeDas === false
                ? []
                : [
                    {
                      cursor: 'c',
                      node: { grain: 'direct_acquisition', directAcquisition: da(SOLE_TRADER) },
                    },
                  ],
          })
        );
      },
    } as unknown as ProcurementRepo;
    const page = await withDaDisclosure(repo, port([[SOLE_TRADER], []])).listDirectAcquisitions(
      { supplierCui: { in: [SOLE_TRADER] } },
      { first: 10 }
    );
    expect(page._unsafeUnwrap().items).toEqual([]);
    expect(JSON.stringify(page)).not.toContain('SECRET');

    const records = await withDaDisclosure(repo, port([[SOLE_TRADER], []])).supplierRecords(
      SOLE_TRADER,
      10,
      undefined,
      false
    );
    // The whole page is rebuilt from the contract leg: no DA edge, and no DA cursor.
    expect(records._unsafeUnwrap()).toMatchObject({
      edges: [],
      endCursor: null,
      hasNextPage: false,
    });
    expect(calls.slice(-2)).toEqual([true, false]);

    const search = await withDaDisclosure(
      repo,
      port([[SOLE_TRADER], []])
    ).searchDirectAcquisitionsOffset({ supplierCui: SOLE_TRADER }, {
      page: 1,
      pageSize: 10,
      sort: 'relevance',
    } as never);
    // Withheld by the final check: no ids, total or facets tied to the supplier.
    expect(search._unsafeUnwrap()).toEqual({ items: [], total: 0, estimated: false });
  });
});

describe('kernel flows across a publish, and outgoing counterparties', () => {
  const recording = () => {
    const seen: (readonly string[] | undefined)[] = [];
    const flows = {
      getFlowSummary: (_c: string, d: 'in' | 'out', _y?: boolean, o?: FlowReadOptions) => {
        seen.push(o?.excludeFlowTypes);
        return Promise.resolve(
          ok({
            direction: d,
            count: 0,
            totalAmountRon: '0',
            minYear: null,
            maxYear: null,
            byFlowType: [],
            byYear: [],
          })
        );
      },
      getTopCounterparties: (_c: string, _d: 'in' | 'out', _l: number, o?: FlowReadOptions) => {
        seen.push(o?.excludeFlowTypes);
        return Promise.resolve(ok([]));
      },
    } as unknown as FlowsRepo;
    return { flows, seen };
  };

  it('re-reads without DA money when the code was withheld mid-request', async () => {
    const { flows, seen } = recording();
    await withSupplierDisclosure(flows, port([[SOLE_TRADER], []])).getFlowSummary(
      SOLE_TRADER,
      'in'
    );
    expect(seen).toEqual([undefined, ['direct_acquisition']]);
  });

  it('leaves DA money out of outgoing counterparties while D6 is enforced', async () => {
    const { flows, seen } = recording();
    await withSupplierDisclosure(flows, port([[COMPANY]])).getTopCounterparties(
      '4305857',
      'out',
      10
    );
    expect(seen).toEqual([['direct_acquisition']]);
  });
});

describe('analysis echo and bucket kinds', () => {
  it('never echoes a withheld supplier code in canonicalScope', async () => {
    const { repo } = fakeAnalysisRepo();
    const result = await analysisStats(
      { analysisRepo: repo, supplierDisclosure: port([[COMPANY]]) },
      { scope: { grain: 'direct_acquisition', supplierCui: SOLE_TRADER } }
    );
    expect(JSON.stringify(result)).not.toContain(SOLE_TRADER);
  });

  it('marks DA supplier buckets company or natural_person while D6 is enforced', async () => {
    const { repo } = fakeAnalysisRepo({
      breakdown: {
        totals: statsRead({ rows: '3', withValue: '3', valueAwardedSum: '13' }),
        buckets: [
          {
            kind: 'top',
            key: 'natural_person',
            recordCount: '2',
            withValue: '2',
            valueAwardedSum: '8',
          },
          { kind: 'top', key: COMPANY, recordCount: '1', withValue: '1', valueAwardedSum: '5' },
        ],
      },
    });
    const blocks = await analysisBreakdown(
      { analysisRepo: repo, supplierDisclosure: port([[COMPANY]]) },
      { scope: { grain: 'direct_acquisition' }, dimension: 'supplier' }
    );
    const buckets = blocks._unsafeUnwrap()[0]?.buckets ?? [];
    expect(buckets.map((b) => [b.key, b.displayKind])).toEqual([
      ['natural_person', 'natural_person'],
      [COMPANY, 'company'],
    ]);
  });
});

describe('ClickHouse DA routing under D6 (v3 off or rolled back)', () => {
  const caps = { frameworkRole: true, supplierGeography: true, daSupplierPrivacy: true };
  const DA_SCOPE = { grain: 'direct_acquisition' } as const;

  it('refuses title search, supplier geography and supplier-keyed analytics at an explicit DA grain', () => {
    expect(
      routeAnalysis({ ...DA_SCOPE, q: 'popescu' }, 'stats', undefined, undefined, caps).isErr()
    ).toBe(true);
    expect(routeAnalysis(DA_SCOPE, 'breakdown', 'supplier', undefined, caps).isErr()).toBe(true);
    expect(routeAnalysis(DA_SCOPE, 'breakdown', 'supplierCounty', undefined, caps).isErr()).toBe(
      true
    );
    expect(
      routeAnalysis(
        { ...DA_SCOPE, supplierSiruta: '179132' },
        'stats',
        undefined,
        undefined,
        caps
      ).isErr()
    ).toBe(true);
    expect(routeAnalysis(DA_SCOPE, 'concentration', undefined, undefined, caps).isErr()).toBe(true);
    expect(routeAnalysis(DA_SCOPE, 'series', undefined, 'distinctSuppliers', caps).isErr()).toBe(
      true
    );
    expect(routeAnalysis(DA_SCOPE, 'breakdown', 'authority', undefined, caps).isOk()).toBe(true);
  });

  it('leaves DA out of an unscoped fan-out with q, and keeps it when D6 is off', () => {
    const routes = routeAnalysis(
      { q: 'popescu' },
      'stats',
      undefined,
      undefined,
      caps
    )._unsafeUnwrap();
    expect(routes.map((r) => r.grain)).not.toContain('direct_acquisition');
    const off = routeAnalysis({ ...DA_SCOPE, q: 'popescu' }, 'stats', undefined, undefined, {
      frameworkRole: true,
      supplierGeography: true,
    });
    expect(off.isOk()).toBe(true);
  });

  it('the decorator marks the generation so routing knows', async () => {
    const inner = {
      activeGeneration: () =>
        Promise.resolve(
          ok({ buildId: '42', capabilities: { frameworkRole: true, supplierGeography: true } })
        ),
    } as unknown as AnalysisRepo;
    const gen = await withDaAnalysisDisclosure(inner, port([[COMPANY]])).activeGeneration();
    expect(gen._unsafeUnwrap()?.capabilities.daSupplierPrivacy).toBe(true);
    // The D6 state rides on the generation into every DA envelope (client cache key).
    expect(gen._unsafeUnwrap()?.disclosureKey).toBe('2026-11-18T03:10:00.000000Z');
  });
});

describe('legacy detail reads the public set last', () => {
  it('reads the set after the CPV label lookup', async () => {
    const order: string[] = [];
    const disclosure: SupplierDisclosurePort = {
      enforced: true,
      privacyAsOf: () => Promise.resolve(ok(null)),
      publicSupplierCodes: () => {
        order.push('codes');
        return Promise.resolve(ok(new Set<string>()));
      },
    };
    const repo = {
      getDirectAcquisition: () =>
        Promise.resolve(
          ok({
            daId: '1',
            title: 'SECRET',
            supplierCui: SOLE_TRADER,
            supplierName: 'SECRET',
            cpvCode: '44110000-4',
          })
        ),
      listCpvCodeLabels: () => {
        order.push('labels');
        return Promise.resolve(ok([]));
      },
    } as unknown as ProcurementRepo;
    const da = await withDaDisclosure(repo, disclosure).getDirectAcquisition('1');
    expect(order).toEqual(['labels', 'codes']);
    expect(JSON.stringify(da)).not.toContain('SECRET');
  });
});

describe('legacy detail body', () => {
  it('withholds the catalogue-item code (source-typed, outside the loader scan)', async () => {
    const { discloseDaDetailBody } = await import('@/modules/procurement/core/da-disclosure.js');
    const body = discloseDaDetailBody({
      items: [
        { daItemId: '1', itemIndex: 0, catalogItemCode: 'PFA 0722000000', cpvCode: '44110000-4' },
      ],
    } as never);
    expect(JSON.stringify(body)).not.toContain('0722000000');
    expect(body.items[0]?.cpvCode).toBe('44110000-4');
  });
});
