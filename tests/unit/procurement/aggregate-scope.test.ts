/**
 * Scope-aggregate routing + gate enforcement. In-memory fakes only (no mocking
 * library): the fake repos record the arguments the usecase derived from the LIVE
 * gate, which is exactly the contract under test.
 *
 * The load-bearing rule (§14.6): counts may merge across grains, MONEY MAY NOT. A
 * grain whose `spend_rankings_allowed` is false contributes NOTHING to a sum — its
 * `amountRonSum` / `totalValueRon` is null, never a number.
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  isCacheableScope,
  rankByValue,
  resolveGrains,
  routeScope,
  scopeCacheKey,
  spendApprovedGrains,
  assertScopeSupported,
} from '@/modules/procurement/core/scope.js';
import {
  scopeCategoryBreakdown,
  scopeSpendOverTime,
  scopeStats,
  scopeTopSuppliers,
} from '@/modules/procurement/core/usecases.js';

import type {
  ProcurementAggregateRepo,
  ProcurementRepo,
  ScopeFlowStats,
} from '@/modules/procurement/core/ports.js';
import type {
  GrainQuality,
  ProcurementGrain,
  ScopeFilter,
} from '@/modules/procurement/core/types.js';
import type { ApiError } from '@/modules/shared/index.js';

// ── fixtures pinned to the LIVE gate (read 2026-07-09) ────────────────────────

const gateRow = (grain: ProcurementGrain, over: Partial<GrainQuality> = {}): GrainQuality => ({
  grain,
  rowsCount: grain === 'direct_acquisition' ? '15722185' : '970182',
  authorityCuiCoverageRate: 1,
  supplierCuiCoverageRate: 1,
  amountCoverageRate: 1,
  cpvCoverageRate: 1,
  dateCoverageRate: 1,
  authorityTerritoryCoverageRate: 0,
  filterAnswersAllowed: true,
  // Live: direct_acquisition may be summed; procurement_contract may NOT.
  spendRankingsAllowed: grain === 'direct_acquisition',
  supplierRegionFiltersAllowed: false,
  blockers: [],
  refreshedAt: '2026-06-29 07:26:59.000658+00',
  projectionVersion: 'test-v1',
  ...over,
});

const LIVE_GATES = [gateRow('direct_acquisition'), gateRow('procurement_contract')];

interface Recorded {
  grains: readonly ProcurementGrain[];
  spendGrains: readonly ProcurementGrain[];
}

/** An in-memory aggregate repo that records what the usecase decided. */
const fakeAggregate = (
  gates: readonly GrainQuality[] = LIVE_GATES
): { repo: ProcurementAggregateRepo; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const record = <T>(grains: readonly ProcurementGrain[], spendGrains: readonly ProcurementGrain[], value: T): Promise<Result<T, ApiError>> => {
    calls.push({ grains, spendGrains });
    return Promise.resolve(ok(value));
  };
  const stats: ScopeFlowStats = {
    totalValueRon: '391269977855.14',
    contractsCount: '800968',
    directAcquisitionsCount: '14820383',
    buyersCount: '18074',
    suppliersCount: '184398',
    firstFlowDate: '2007-03-12',
    lastFlowDate: '2026-06-21',
  };
  type Grains = readonly ProcurementGrain[];
  const repo = {
    grainQuality: () => Promise.resolve(ok(gates)),
    scopeStats: (_s: ScopeFilter, g: Grains, sg: Grains) => record(g, sg, stats),
    scopeTopParties: (_s: ScopeFilter, g: Grains, sg: Grains) => record(g, sg, []),
    scopeCategoryBreakdown: (_s: ScopeFilter, g: Grains, sg: Grains) => record(g, sg, []),
    scopeSpendOverTime: (_s: ScopeFilter, g: Grains, sg: Grains) => record(g, sg, []),
  } as unknown as ProcurementAggregateRepo;
  return { repo, calls };
};

const fakeRepo = (proceduresCount = '622936'): ProcurementRepo =>
  ({ countProceduresInScope: () => Promise.resolve(ok(proceduresCount)) }) as unknown as ProcurementRepo;

// ── routing ───────────────────────────────────────────────────────────────────

describe('MV routing', () => {
  it('a non-CPV answer on a non-CPV scope reads org_edge', () => {
    expect(routeScope({}, false)).toBe('org_edge');
    expect(routeScope({ supplierCui: '1' }, false)).toBe('org_edge');
  });

  it('a CPV-DIMENSION answer always reads the CPV MV, whatever the scope', () => {
    expect(routeScope({}, true)).toBe('supplier_cpv');
    expect(routeScope({ authorityCui: '1' }, true)).toBe('supplier_cpv');
  });

  it('a cpvDivision SCOPE forces the CPV MV even for a non-CPV answer', () => {
    // The supplier CPV MV is the only CPV rollup carrying BOTH cuis, which
    // buyersCount / suppliersCount / topSuppliers all need.
    expect(routeScope({ cpvDivision: '33' }, false)).toBe('supplier_cpv');
  });
});

describe('scope.cpvCode is rejected in v1', () => {
  it('InvalidInput — no rollup is 8-digit-grained', () => {
    const r = assertScopeSupported({ cpvCode: '33600000' });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) {
      expect(r.error.type).toBe('InvalidInput');
      expect(r.error.message).toContain('cpvDivision');
    }
  });

  it('surfaces through the usecase, not silently ignored', async () => {
    const { repo } = fakeAggregate();
    const r = await scopeStats(repo, fakeRepo(), { cpvCode: '33600000' }, null);
    expect(r.isErr()).toBe(true);
  });

  it('a 2-digit division scope is fine', () => {
    expect(assertScopeSupported({ cpvDivision: '33' }).isOk()).toBe(true);
  });
});

// ── grain resolution ──────────────────────────────────────────────────────────

describe('grain resolution', () => {
  it('null / undefined / empty = both grains', () => {
    expect(resolveGrains(null)._unsafeUnwrap()).toEqual(['direct_acquisition', 'procurement_contract']);
    expect(resolveGrains(undefined)._unsafeUnwrap()).toHaveLength(2);
    expect(resolveGrains('')._unsafeUnwrap()).toHaveLength(2);
  });

  it('a named grain narrows to exactly that grain', () => {
    expect(resolveGrains('procurement_contract')._unsafeUnwrap()).toEqual(['procurement_contract']);
  });

  it('an unknown grain is InvalidInput', () => {
    expect(resolveGrains('procurement_frobnicate').isErr()).toBe(true);
  });
});

// ── the money gate ────────────────────────────────────────────────────────────

describe('spend approval per grain (from the live gate, never a constant)', () => {
  it('only direct_acquisition is spend-approved live', () => {
    expect(spendApprovedGrains(['direct_acquisition', 'procurement_contract'], LIVE_GATES)).toEqual([
      'direct_acquisition',
    ]);
    expect(spendApprovedGrains(['procurement_contract'], LIVE_GATES)).toEqual([]);
  });

  it('ranks by value only when EVERY in-scope grain is spend-approved', () => {
    expect(rankByValue(['direct_acquisition'], ['direct_acquisition'])).toBe(true);
    // Mixed: the suppressed grain's null amount would sink its rows regardless of size.
    expect(rankByValue(['direct_acquisition', 'procurement_contract'], ['direct_acquisition'])).toBe(false);
    expect(rankByValue(['procurement_contract'], [])).toBe(false);
  });

  it('is data-driven: flip the gate and the answer flips', () => {
    const permissive = [gateRow('direct_acquisition'), gateRow('procurement_contract', { spendRankingsAllowed: true })];
    expect(spendApprovedGrains(['direct_acquisition', 'procurement_contract'], permissive)).toHaveLength(2);
    expect(rankByValue(['direct_acquisition', 'procurement_contract'], ['direct_acquisition', 'procurement_contract'])).toBe(true);
  });
});

describe('the usecases hand the repo the gate-derived grain sets', () => {
  it('grain: null → both grains, but only DA money', async () => {
    const { repo, calls } = fakeAggregate();
    await scopeStats(repo, fakeRepo(), {}, null);
    expect(calls[0]?.grains).toEqual(['direct_acquisition', 'procurement_contract']);
    expect(calls[0]?.spendGrains).toEqual(['direct_acquisition']);
  });

  it('grain: procurement_contract → NO grain may be summed', async () => {
    const { repo, calls } = fakeAggregate();
    await scopeTopSuppliers(repo, {}, 'procurement_contract', 10);
    expect(calls[0]?.grains).toEqual(['procurement_contract']);
    expect(calls[0]?.spendGrains).toEqual([]);
  });

  it('grain: direct_acquisition → that grain’s money is summable', async () => {
    const { repo, calls } = fakeAggregate();
    await scopeCategoryBreakdown(repo, {}, 'direct_acquisition');
    expect(calls[0]?.spendGrains).toEqual(['direct_acquisition']);
  });

  it('a grain blocked for FILTERED answers is dropped from the scope entirely', async () => {
    const blocked = [
      gateRow('direct_acquisition'),
      gateRow('procurement_contract', { filterAnswersAllowed: false }),
    ];
    const { repo, calls } = fakeAggregate(blocked);
    await scopeSpendOverTime(repo, {}, null);
    expect(calls[0]?.grains).toEqual(['direct_acquisition']);
  });

  it('when EVERY grain is gate-blocked the usecase abstains — empty rows, zeroed stats, null money', async () => {
    const blocked = [
      gateRow('direct_acquisition', { filterAnswersAllowed: false }),
      gateRow('procurement_contract', { filterAnswersAllowed: false }),
    ];
    const { repo, calls } = fakeAggregate(blocked);
    const rows = await scopeTopSuppliers(repo, {}, null, 10);
    expect(rows._unsafeUnwrap()).toEqual([]);

    const stats = (await scopeStats(repo, fakeRepo(), {}, null))._unsafeUnwrap();
    expect(stats.totalValueRon).toBeNull();
    expect(stats.contractsCount).toBe('0');
    expect(stats.proceduresCount).toBe('0');
    // The repo was never asked — abstain means no query, not a query we discard.
    expect(calls).toHaveLength(0);
  });

  it('proceduresCount comes from the base table, not the rollups', async () => {
    const { repo } = fakeAggregate();
    const stats = (await scopeStats(repo, fakeRepo('101862'), { cpvDivision: '33' }, null))._unsafeUnwrap();
    expect(stats.proceduresCount).toBe('101862');
    expect(stats.directAcquisitionsCount).toBe('14820383');
  });
});

// ── caching ───────────────────────────────────────────────────────────────────

describe('cache key space', () => {
  it('only non-entity scopes are cacheable (bounded key space)', () => {
    expect(isCacheableScope({})).toBe(true);
    expect(isCacheableScope({ cpvDivision: '33', monthFrom: '2024-01' })).toBe(true);
    expect(isCacheableScope({ authorityCui: '4267117' })).toBe(false);
    expect(isCacheableScope({ supplierCui: '11805367' })).toBe(false);
  });

  it('the key ignores entity dims, is order-independent in the grain set, and binds the refresh watermark', () => {
    const scope: ScopeFilter = { cpvDivision: '33' };
    const a = scopeCacheKey('stats', scope, ['direct_acquisition', 'procurement_contract'], 10, 'w1');
    const b = scopeCacheKey('stats', scope, ['procurement_contract', 'direct_acquisition'], 10, 'w1');
    expect(a).toBe(b);
    // A matview refresh invalidates implicitly.
    expect(scopeCacheKey('stats', scope, ['direct_acquisition'], 10, 'w2')).not.toBe(a);
    // Different query / topN never collide.
    expect(scopeCacheKey('timeline', scope, ['direct_acquisition', 'procurement_contract'], 10, 'w1')).not.toBe(a);
    expect(scopeCacheKey('stats', scope, ['direct_acquisition', 'procurement_contract'], 50, 'w1')).not.toBe(a);
  });
});
