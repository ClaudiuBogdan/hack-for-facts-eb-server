/**
 * Direct acquisitions release 1 — usecases over the in-memory repository:
 * one snapshot per request with every read inside it (dataAsOf first), input
 * validation, the disabled path, and the per-dataAsOf totals cache.
 */
import { describe, expect, it } from 'vitest';

import {
  daPurchaseTotals,
  daReleaseStatus,
  getDaPurchase,
  listDaPurchases,
  makeDaTotalsCache,
} from '@/modules/procurement/core/da-release-usecases.js';

import {
  COMPANY,
  DATA_AS_OF,
  PURCHASES,
  SOLE_TRADER,
  makeFakeDaRepo,
  type SnapshotLog,
} from '../../fixtures/procurement/da-release.js';

const PAGE = { page: 1, pageSize: 20 };
const firstId = PURCHASES[1]?.purchaseId ?? '';

const logged = () => {
  const log: SnapshotLog = { opened: 0, reads: [] };
  return { log, deps: { repo: makeFakeDaRepo({ log }) } };
};

describe('one snapshot per request', () => {
  const requests: [string, (deps: ReturnType<typeof logged>['deps']) => Promise<unknown>][] = [
    ['list', (deps) => listDaPurchases(deps, PAGE)],
    ['detail', (deps) => getDaPurchase(deps, firstId)],
    ['totals', (deps) => daPurchaseTotals(deps, { groupBy: 'supplier', ...PAGE })],
    ['status', (deps) => daReleaseStatus(deps)],
  ];

  it.each(requests)(
    '%s reads dataAsOf first and everything inside one open snapshot',
    async (_name, run) => {
      const { log, deps } = logged();
      await run(deps);
      expect(log.opened).toBe(1);
      expect(log.reads.length).toBeGreaterThan(0);
      expect(log.reads[0]?.method).toBe('dataAsOf');
      expect(log.reads.every((read) => read.snapshot === 1 && read.open)).toBe(true);
    }
  );

  it('detail reads the purchase and its items in the same snapshot as dataAsOf', async () => {
    const { log, deps } = logged();
    const detail = (await getDaPurchase(deps, firstId))._unsafeUnwrap();
    expect(log.reads.map((read) => read.method)).toEqual(['dataAsOf', 'purchaseById', 'itemsOf']);
    expect(detail.dataAsOf).toBe(DATA_AS_OF);
    expect(detail.items).toHaveLength(2);
  });

  it('every answer carries the dataAsOf of its snapshot', async () => {
    const deps = { repo: makeFakeDaRepo({ dataAsOf: '2026-11-19T03:00:00Z' }) };
    expect((await listDaPurchases(deps, PAGE))._unsafeUnwrap().dataAsOf).toBe(
      '2026-11-19T03:00:00Z'
    );
    expect((await daPurchaseTotals(deps, PAGE))._unsafeUnwrap().dataAsOf).toBe(
      '2026-11-19T03:00:00Z'
    );
  });

  it('refuses when the release holds no data yet', async () => {
    const deps = { repo: makeFakeDaRepo({ dataAsOf: null }) };
    expect((await listDaPurchases(deps, PAGE))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(await daReleaseStatus(deps)).toEqual({ enabled: false, dataAsOf: null });
  });
});

describe('disabled', () => {
  it('refuses every read without opening a snapshot and reports enabled=false', async () => {
    const log: SnapshotLog = { opened: 0, reads: [] };
    const deps = { repo: makeFakeDaRepo({ enabled: false, log }) };
    expect((await listDaPurchases(deps, PAGE))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect((await getDaPurchase(deps, firstId))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect((await daPurchaseTotals(deps, PAGE))._unsafeUnwrapErr().type).toBe('ServiceUnavailable');
    expect(await daReleaseStatus(deps)).toEqual({ enabled: false, dataAsOf: null });
    expect(log.opened).toBe(0);
  });
});

describe('input', () => {
  const deps = { repo: makeFakeDaRepo() };
  const invalid: [string, Record<string, unknown>][] = [
    ['unknown field', { supplierName: 'x' }],
    ['fiscal code with RO prefix', { supplierFiscalCode: 'RO14399840' }],
    ['three-digit division', { cpvDivision: '441' }],
    ['impossible day', { finalizationFrom: '2025-02-30' }],
    ['reversed range', { finalizationFrom: '2025-12-01', finalizationTo: '2025-01-01' }],
    ['unknown outcome', { outcomes: ['cancelled'] }],
    ['counted as text', { counted: 'true' }],
  ];
  it.each(invalid)('refuses %s', async (_label, filter) => {
    expect((await listDaPurchases(deps, { filter, ...PAGE }))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
  });

  it('refuses pages beyond row 10000, bad page sizes, bad ids and unknown groupings', async () => {
    expect(
      (await listDaPurchases(deps, { page: 101, pageSize: 100 }))._unsafeUnwrapErr().type
    ).toBe('InvalidInput');
    expect((await listDaPurchases(deps, { page: 1, pageSize: 101 }))._unsafeUnwrapErr().type).toBe(
      'InvalidInput'
    );
    expect((await getDaPurchase(deps, 'ABC'))._unsafeUnwrapErr().type).toBe('InvalidInput');
    expect((await getDaPurchase(deps, 'f'.repeat(64)))._unsafeUnwrapErr().type).toBe('NotFound');
    expect(
      (await daPurchaseTotals(deps, { groupBy: 'authority', ...PAGE }))._unsafeUnwrapErr().type
    ).toBe('InvalidInput');
  });

  it('resolves a legacy code to its purchaseId', async () => {
    const target = PURCHASES[4];
    const page = (
      await listDaPurchases(deps, { filter: { code: target?.code }, ...PAGE })
    )._unsafeUnwrap();
    expect(page.items.map((item) => item.purchaseId)).toEqual([target?.purchaseId]);
  });

  it('a supplier filter cannot list a withheld supplier by its code', async () => {
    const pfa = await listDaPurchases(deps, {
      filter: { supplierFiscalCode: SOLE_TRADER.fiscalCode },
      ...PAGE,
    });
    expect(pfa._unsafeUnwrap().total).toBe(0);
    const company = await listDaPurchases(deps, {
      filter: { supplierFiscalCode: COMPANY.fiscalCode },
      ...PAGE,
    });
    expect(company._unsafeUnwrap().total).toBeGreaterThan(0);
  });
});

describe('totals', () => {
  it('sums only counted values and counts symbolic prices among them', async () => {
    const deps = { repo: makeFakeDaRepo() };
    const answer = (await daPurchaseTotals(deps, PAGE))._unsafeUnwrap();
    // 12500 + 3150 (corrected) + 188800000 + 5200 + 0.01 + 900 + 450 + 300 + 100
    expect(answer.overall).toEqual({
      countedValue: '188822600.01',
      countedCount: '9',
      symbolicPriceCount: '1',
      purchaseCount: String(PURCHASES.length),
    });
    expect(answer.groups).toEqual([]);
  });

  it('puts every withheld supplier in one unnamed bucket', async () => {
    const deps = { repo: makeFakeDaRepo() };
    const answer = (await daPurchaseTotals(deps, { groupBy: 'supplier', ...PAGE }))._unsafeUnwrap();
    const named = answer.groups.filter((group) => group.party?.displayKind === 'company');
    expect(named.map((group) => group.party?.name)).toEqual([COMPANY.name]);
    for (const group of answer.groups.filter((g) => g.party?.displayKind === 'natural_person')) {
      expect(group.party).toEqual({
        displayKind: 'natural_person',
        partyId: null,
        name: null,
        fiscalCode: null,
      });
      expect(group.key).toBeNull();
    }
    expect(answer.groups.filter((group) => group.noSupplier)).toHaveLength(1);
  });

  it('caches unfiltered totals per dataAsOf and never filtered ones', async () => {
    const log: SnapshotLog = { opened: 0, reads: [] };
    const deps = { repo: makeFakeDaRepo({ log }), totalsCache: makeDaTotalsCache() };
    await daPurchaseTotals(deps, { groupBy: 'month', ...PAGE });
    await daPurchaseTotals(deps, { groupBy: 'month', ...PAGE });
    expect(log.reads.filter((read) => read.method === 'totals')).toHaveLength(1);
    await daPurchaseTotals(deps, { filter: { counted: true }, groupBy: 'month', ...PAGE });
    await daPurchaseTotals(deps, { filter: { counted: true }, groupBy: 'month', ...PAGE });
    expect(log.reads.filter((read) => read.method === 'totals')).toHaveLength(3);
    // Each request still opened its own snapshot and read dataAsOf.
    expect(log.opened).toBe(4);
  });

  it('drops cached answers when dataAsOf moves', async () => {
    const cache = makeDaTotalsCache();
    const log: SnapshotLog = { opened: 0, reads: [] };
    await daPurchaseTotals({ repo: makeFakeDaRepo({ log }), totalsCache: cache }, PAGE);
    const next = {
      repo: makeFakeDaRepo({ log, dataAsOf: '2026-11-19T03:00:00Z' }),
      totalsCache: cache,
    };
    const answer = (await daPurchaseTotals(next, PAGE))._unsafeUnwrap();
    expect(answer.dataAsOf).toBe('2026-11-19T03:00:00Z');
    expect(log.reads.filter((read) => read.method === 'totals')).toHaveLength(2);
  });
});
