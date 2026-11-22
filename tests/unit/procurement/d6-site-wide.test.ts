/**
 * Site-wide D6 on the switch of its own (root, 2026-11-18), from the phase-2
 * review: the ClickHouse DA grain decorator, the publish-crossing re-checks on
 * the legacy decorator and the kernel flows, the echoed scope, the supplier
 * bucket kinds, and the presence leg. A code is public until a nightly publish
 * withholds it MID-request; the answer must then withhold it too.
 */
import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { analysisBreakdown, analysisStats } from '@/modules/procurement/core/analysis-usecases.js';
import { routeAnalysis } from '@/modules/procurement/core/combinations.js';
import { makeProcurementMcpTools } from '@/modules/procurement/shell/mcp/tools.js';
import { withDaAnalysisDisclosure } from '@/modules/procurement/shell/repo/da-analysis-disclosure.js';
import { withDaDisclosure } from '@/modules/procurement/shell/repo/da-disclosure-repo.js';
import {
  FiscalCodeSet,
  serviceUnavailable,
  type FlowReadOptions,
  type FlowsRepo,
  type SupplierDisclosurePort,
} from '@/modules/shared/index.js';
import { withSupplierDisclosure } from '@/modules/shared/shell/repo/supplier-disclosure-repo.js';

import { BASIS_COVERAGE_ROWS, fakeAnalysisRepo, generation, statsRead } from './analysis-fakes.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';
import type {
  AnalysisRecordRow,
  AnalysisRepo,
  ProcurementRepo,
} from '@/modules/procurement/core/ports.js';
import type { ProcurementDirectAcquisition } from '@/modules/procurement/core/types.js';

const COMPANY = '14399840';
const SOLE_TRADER = '30254716';

/** The publication every fake port here reads (sets change within it, as the tests need). */
const PUBLISHED = '2026-11-18T03:10:00.000000Z';
/** A generation keyed by that publication, as the D6 decorator's activeGeneration would key it. */
const GEN = { disclosureKey: PUBLISHED } as never;

/** A port whose public set changes after `flipAfter` reads (a nightly publish mid-request). */
const port = (sets: readonly (readonly string[])[]): SupplierDisclosurePort => {
  let reads = 0;
  return {
    enforced: true,
    privacyAsOf: () => Promise.resolve(ok(PUBLISHED)),
    publicSupplierCodes: () => {
      const set = sets[Math.min(reads, sets.length - 1)] ?? [];
      reads += 1;
      return Promise.resolve(ok(new FiscalCodeSet(set, PUBLISHED)));
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
      GEN
    );
    expect(withheld.scopes).toEqual(['~withheld']);

    const crossing = innerAnalysis();
    await withDaAnalysisDisclosure(crossing.repo, port([[SOLE_TRADER], []])).statsFor(
      DA_ROUTE,
      { supplierCui: SOLE_TRADER },
      GEN
    );
    expect(crossing.scopes).toEqual([SOLE_TRADER, '~withheld']);
  });

  it('merges withheld top buckets into one natural_person bucket, re-ranked', async () => {
    const { repo } = innerAnalysis();
    const read = await withDaAnalysisDisclosure(repo, port([[COMPANY]])).breakdownFor(
      DA_ROUTE,
      {},
      GEN,
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
      GEN,
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
      GEN,
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
    expect(search._unsafeUnwrap()).toEqual({
      items: [],
      total: 0,
      estimated: false,
      disclosureKey: PUBLISHED, // both checks read the one publication
    });
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

  describe('PROC-B51G: DA supplier bucket names come only from the D6 name gate', () => {
    const NAME_WITHHELD = '2000002';
    const supplierRepo = () =>
      fakeAnalysisRepo({
        breakdown: {
          totals: statsRead({ rows: '6', withValue: '6', valueAwardedSum: '21' }),
          buckets: [
            {
              kind: 'top',
              key: 'natural_person',
              recordCount: '2',
              withValue: '2',
              valueAwardedSum: '8',
            },
            { kind: 'top', key: COMPANY, recordCount: '1', withValue: '1', valueAwardedSum: '5' },
            {
              kind: 'top',
              key: NAME_WITHHELD,
              recordCount: '3',
              withValue: '3',
              valueAwardedSum: '8',
            },
            { kind: 'other', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
            { kind: 'unknown', key: null, recordCount: '0', withValue: '0', valueAwardedSum: '0' },
          ],
        },
      }).repo;
    const namesPort = (asked: (readonly string[])[], fail = false) => ({
      namesOf: (codes: readonly string[]) => {
        asked.push(codes);
        return Promise.resolve(
          fail
            ? err(serviceUnavailable('names not readable'))
            : ok(new Map([[COMPANY, 'EXEMPLU REGISTRU SA']]) as ReadonlyMap<string, string>)
        );
      },
    });

    it('names a company only when its name is public, asks only for company codes', async () => {
      const asked: (readonly string[])[] = [];
      const blocks = await analysisBreakdown(
        {
          analysisRepo: supplierRepo(),
          supplierDisclosure: port([[COMPANY, NAME_WITHHELD]]),
          daSupplierNames: namesPort(asked),
        },
        { scope: { grain: 'direct_acquisition' }, dimension: 'supplier' }
      );
      const buckets = blocks._unsafeUnwrap()[0]?.buckets ?? [];
      const top = buckets.filter((b) => b.kind === 'top');
      expect(Object.fromEntries(top.map((b) => [b.key, [b.displayKind, b.displayName]]))).toEqual({
        [NAME_WITHHELD]: ['company', null],
        natural_person: ['natural_person', null],
        [COMPANY]: ['company', 'EXEMPLU REGISTRU SA'],
      });
      // other and unknown carry neither.
      const rest = buckets.filter((b) => b.kind !== 'top');
      expect(rest.map((b) => b.kind)).toEqual(['other', 'unknown']);
      for (const bucket of rest) expect(bucket).not.toHaveProperty('displayName');
      expect(asked.map((codes) => [...codes].sort())).toEqual([[NAME_WITHHELD, COMPANY].sort()]);
    });

    it('names nothing without the port, and fails the answer when the gate cannot be read', async () => {
      const unnamed = await analysisBreakdown(
        { analysisRepo: supplierRepo(), supplierDisclosure: port([[COMPANY, NAME_WITHHELD]]) },
        { scope: { grain: 'direct_acquisition' }, dimension: 'supplier' }
      );
      const buckets = unnamed._unsafeUnwrap()[0]?.buckets ?? [];
      expect(buckets.filter((b) => b.kind === 'top').map((b) => b.displayName)).toEqual([
        null,
        null,
        null,
      ]);
      const failed = await analysisBreakdown(
        {
          analysisRepo: supplierRepo(),
          supplierDisclosure: port([[COMPANY, NAME_WITHHELD]]),
          daSupplierNames: namesPort([], true),
        },
        { scope: { grain: 'direct_acquisition' }, dimension: 'supplier' }
      );
      expect(failed._unsafeUnwrapErr()).toMatchObject({ type: 'ServiceUnavailable' });
    });

    it('asks nothing and adds no name outside DA supplier buckets, or while D6 is off', async () => {
      const asked: (readonly string[])[] = [];
      const off = await analysisBreakdown(
        { analysisRepo: supplierRepo(), daSupplierNames: namesPort(asked) },
        { scope: { grain: 'direct_acquisition' }, dimension: 'supplier' }
      );
      for (const bucket of off._unsafeUnwrap()[0]?.buckets ?? [])
        expect(bucket).not.toHaveProperty('displayName');
      const authority = await analysisBreakdown(
        {
          analysisRepo: supplierRepo(),
          supplierDisclosure: port([[COMPANY]]),
          daSupplierNames: namesPort(asked),
        },
        { scope: { grain: 'direct_acquisition' }, dimension: 'authority' }
      );
      for (const bucket of authority._unsafeUnwrap()[0]?.buckets ?? [])
        expect(bucket).not.toHaveProperty('displayName');
      expect(asked).toEqual([]);
    });
  });
});

describe('MCP analysis: the final check re-reads a supplier it withholds', () => {
  /** The supplier's own figures: only a read scoped to its code returns them. */
  const NAMED = statsRead({
    rows: '7',
    withValue: '7',
    withEstimated: '7',
    valueAwardedSum: '777.00',
    valueEstimatedSum: '777.00',
    undatedCount: '7',
    undatedValueRon: '777.00',
  });
  /** Nothing at all: the read matched no row. */
  const HIDDEN = statsRead({
    rows: '0',
    withValue: '0',
    withEstimated: '0',
    valueAwardedSum: null,
    valueEstimatedSum: null,
    minMonth: null,
    maxMonth: null,
    undatedCount: '0',
    undatedValueRon: null,
  });
  /**
   * The legacy DA decorator over facts that answer a supplier scope with that
   * supplier's figures, under a port public until `withheldFrom` fresh checks ran.
   */
  const aggregate = async (withheldFrom: number) => {
    const scopes: (string | undefined)[] = [];
    const base = fakeAnalysisRepo().repo;
    const facts: AnalysisRepo = {
      ...base,
      statsFor: (route, scope, gen) => {
        scopes.push(scope.supplierCui);
        return route.grain === 'direct_acquisition'
          ? Promise.resolve(ok(scope.supplierCui === COMPANY ? NAMED : HIDDEN))
          : base.statsFor(route, scope, gen);
      },
    };
    let freshChecks = 0;
    const disclosure: SupplierDisclosurePort = {
      enforced: true,
      privacyAsOf: () => Promise.resolve(ok(PUBLISHED)),
      publicSupplierCodes: (options) => {
        if (options?.fresh === true) freshChecks += 1;
        return Promise.resolve(
          ok(new FiscalCodeSet(freshChecks >= withheldFrom ? [] : [COMPANY], PUBLISHED))
        );
      },
    };
    const tool = makeProcurementMcpTools({
      repo: {} as unknown as ProcurementRepo,
      analysis: withDaAnalysisDisclosure(facts, disclosure),
      clientBaseUrl: 'https://transparenta.eu',
      supplierDisclosure: disclosure,
    }).find((t) => t.name === 'aggregate_procurement');
    if (tool === undefined) throw new Error('aggregate_procurement not registered');
    const out = await tool.handler({
      shape: 'stats',
      scope: { grain: 'direct_acquisition', supplierCui: COMPANY },
    });
    return { out, scopes, text: JSON.stringify(out) };
  };
  const echo = (out: { query?: unknown }) => (out.query as { scope: AnalysisScope }).scope;

  it('re-reads the whole answer when a publish withholds the supplier after its read', async () => {
    // Fresh check 1 is the decorator's after-read check (public); 2 is the final one.
    const { out, scopes, text } = await aggregate(2);
    expect(scopes).toEqual([COMPANY, '~withheld']);
    expect(out.ok).toBe(true);
    expect(echo(out).supplierCui).toBe('withheld');
    expect(text).not.toContain(COMPANY);
    expect(text).not.toContain('777');
    expect((out.items as readonly { recordCount: string }[])[0]?.recordCount).toBe('0');
  });

  it('answers an already withheld supplier with nothing of it, echoed withheld', async () => {
    const { out, scopes, text } = await aggregate(0);
    expect(scopes).toEqual(['~withheld', '~withheld']); // the answer, then its re-read
    expect(out.ok).toBe(true);
    expect((out.items as readonly { recordCount: string }[])[0]?.recordCount).toBe('0');
    expect(echo(out).supplierCui).toBe('withheld');
    expect(text).not.toContain(COMPANY);
    expect(text).not.toContain('777');
  });

  it('serves and echoes a supplier public throughout, read once', async () => {
    const { out, scopes } = await aggregate(Number.POSITIVE_INFINITY);
    expect(scopes).toEqual([COMPANY]);
    expect(echo(out).supplierCui).toBe(COMPANY);
    expect((out.items as readonly { recordCount: string }[])[0]?.recordCount).toBe('7');
  });
});

describe('ClickHouse DA grain: an answer is served only under the key it was decided by', () => {
  const NEXT = '2026-11-19T03:10:00.000000Z';
  /** Up-front checks read PUBLISHED; the final fresh check reads `fresh`. */
  const across = (fresh: string | null): SupplierDisclosurePort => ({
    enforced: true,
    privacyAsOf: () => Promise.resolve(ok(PUBLISHED)),
    publicSupplierCodes: (options) =>
      Promise.resolve(
        ok(
          options?.fresh === true
            ? // Unreadable lists no one, as production's empty set.
              new FiscalCodeSet(fresh === null ? [] : [COMPANY], fresh)
            : new FiscalCodeSet([COMPANY], PUBLISHED)
        )
      ),
  });
  const scoped = { supplierCui: COMPANY };

  it('serves a decision made under the generation key', async () => {
    const read = await withDaAnalysisDisclosure(innerAnalysis().repo, across(PUBLISHED)).statsFor(
      DA_ROUTE,
      scoped,
      GEN
    );
    expect(read.isOk()).toBe(true);
  });

  it.each([
    ['a publish between the generation and the final check', NEXT],
    ['supplier_privacy unreadable at the final check', null],
  ] as const)('refuses (retryable) %s', async (_label, fresh) => {
    const gated = withDaAnalysisDisclosure(innerAnalysis().repo, across(fresh));
    for (const read of [
      gated.statsFor(DA_ROUTE, scoped, GEN),
      gated.breakdownFor(DA_ROUTE, {}, GEN, 'supplier', 5, 'value'),
      gated.recordsFor(DA_ROUTE, {}, GEN, { sort: 'date_desc', offset: 0, limit: 10 } as never),
    ]) {
      const result = await read;
      expect(result.isErr() && result.error.type).toBe('ServiceUnavailable');
      expect(result.isErr() && result.error.message).toContain('repeat the request');
    }
  });

  it('leaves reads that make no D6 decision alone (no supplier scope, no supplier rows)', async () => {
    const read = await withDaAnalysisDisclosure(innerAnalysis().repo, across(NEXT)).statsFor(
      DA_ROUTE,
      {},
      GEN
    );
    expect(read.isOk()).toBe(true);
  });
});

describe('MCP DA list carries its key', () => {
  it('serves meta.disclosureKey, or off while D6 is not enforced', async () => {
    const repo = {
      listCpvCodeLabels: () => Promise.resolve(ok([])),
      listDirectAcquisitions: () => Promise.resolve(ok({ items: [], next: null })),
    } as unknown as ProcurementRepo;
    const keyOf = async (disclosure: SupplierDisclosurePort) => {
      const tool = makeProcurementMcpTools({
        repo: withDaDisclosure(repo, disclosure),
        analysis: fakeAnalysisRepo().repo,
        clientBaseUrl: 'https://transparenta.eu',
        supplierDisclosure: disclosure,
      }).find((t) => t.name === 'search_procurement_direct_acquisitions');
      if (tool === undefined)
        throw new Error('search_procurement_direct_acquisitions not registered');
      const out = await tool.handler({ authorityCui: '4305857' });
      expect(out.ok).toBe(true);
      return (out.meta as { disclosureKey: string }).disclosureKey;
    };
    expect(await keyOf(port([[COMPANY]]))).toBe(PUBLISHED);
    expect(await keyOf({ ...port([[COMPANY]]), enforced: false })).toBe('off');
    // Authorised under one publication, settled under the next: forwarded as unavailable.
    const crossing: SupplierDisclosurePort = {
      ...port([[COMPANY]]),
      publicSupplierCodes: (options) =>
        Promise.resolve(
          ok(
            new FiscalCodeSet(
              [COMPANY],
              options?.fresh === true ? '2026-11-19T03:10:00.000000Z' : PUBLISHED
            )
          )
        ),
    };
    expect(await keyOf(crossing)).toBe('unavailable');
  });
});

describe('the scope echo matches the key the answer is served under', () => {
  const NEXT = '2026-11-19T03:10:00.000000Z';
  /** The generation is keyed by `genKey`; every D6 set is read from `setKey` and lists COMPANY. */
  const keyed = (genKey: string, setKey: string): SupplierDisclosurePort => ({
    enforced: true,
    privacyAsOf: () => Promise.resolve(ok(genKey)),
    publicSupplierCodes: () => Promise.resolve(ok(new FiscalCodeSet([COMPANY], setKey))),
  });
  const echoed = async (disclosure: SupplierDisclosurePort) => {
    const result = await analysisStats(
      {
        analysisRepo: withDaAnalysisDisclosure(fakeAnalysisRepo().repo, disclosure),
        supplierDisclosure: disclosure,
      },
      { scope: { grain: 'contract', supplierCui: COMPANY } }
    );
    return result._unsafeUnwrap().blocks.map((block) => block.meta.canonicalScope);
  };

  it('echoes a public supplier when its set comes from the publication the answer is keyed by', async () => {
    const scopes = await echoed(keyed(PUBLISHED, PUBLISHED));
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope).toContain(`supplierCui=${COMPANY}`);
  });

  it('echoes withheld when the set comes from another publication than the key', async () => {
    const scopes = await echoed(keyed(PUBLISHED, NEXT));
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope).toContain('supplierCui=withheld');
      expect(scope).not.toContain(COMPANY);
    }
  });

  it('echoes withheld when a grain source (the v3 DA grain) is keyed by another state', async () => {
    const disclosure = keyed(PUBLISHED, PUBLISHED);
    const echoes = async (sourceKey: string) => {
      const gen = {
        ...generation(),
        disclosureKey: PUBLISHED,
        grainSources: {
          direct_acquisition: {
            generation: { ...generation(), disclosureKey: sourceKey },
            coverage: BASIS_COVERAGE_ROWS,
          },
        },
      };
      const result = await analysisStats(
        {
          analysisRepo: fakeAnalysisRepo({ generation: gen }).repo,
          supplierDisclosure: disclosure,
        },
        { scope: { grain: 'contract', supplierCui: COMPANY } }
      );
      return result._unsafeUnwrap().blocks.map((block) => block.meta.canonicalScope);
    };
    for (const scope of await echoes(PUBLISHED)) expect(scope).toContain(`supplierCui=${COMPANY}`);
    for (const key of [NEXT, 'unavailable'])
      for (const scope of await echoes(key)) expect(scope).toContain('supplierCui=withheld');
  });

  it('MCP: a final check from a newer publication re-reads and echoes withheld', async () => {
    // Everything reads PUBLISHED until the final fresh check, which (and after it) reads NEXT.
    let moved = false;
    let freshChecks = 0;
    const disclosure: SupplierDisclosurePort = {
      enforced: true,
      privacyAsOf: () => Promise.resolve(ok(moved ? NEXT : PUBLISHED)),
      publicSupplierCodes: (options) => {
        if (options?.fresh === true) {
          freshChecks += 1;
          // 1: the decorator's after-read check; 2: the MCP final check.
          if (freshChecks === 2) moved = true;
        }
        return Promise.resolve(ok(new FiscalCodeSet([COMPANY], moved ? NEXT : PUBLISHED)));
      },
    };
    let reads = 0;
    const base = fakeAnalysisRepo().repo;
    const facts: AnalysisRepo = {
      ...base,
      statsFor: (route, scope, gen) => {
        if (route.grain === 'direct_acquisition') reads += 1;
        return base.statsFor(route, scope, gen);
      },
    };
    const tool = makeProcurementMcpTools({
      repo: {} as unknown as ProcurementRepo,
      analysis: withDaAnalysisDisclosure(facts, disclosure),
      clientBaseUrl: 'https://transparenta.eu',
      supplierDisclosure: disclosure,
    }).find((t) => t.name === 'aggregate_procurement');
    if (tool === undefined) throw new Error('aggregate_procurement not registered');
    const out = await tool.handler({
      shape: 'stats',
      scope: { grain: 'direct_acquisition', supplierCui: COMPANY },
    });
    expect(out.ok).toBe(true);
    expect(reads).toBe(2); // the answer, then its re-read under the newer publication
    expect((out.query as { scope: AnalysisScope }).scope.supplierCui).toBe('withheld');
    const keys = (out.meta as { envelopes: readonly { disclosureKey: string | null }[] }).envelopes
      .map((envelope) => envelope.disclosureKey)
      .filter((key) => key !== null);
    expect(keys).toEqual([NEXT]);
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
