/**
 * Procurement grain-gate enforcement (mocked aggregate repo, no live DB). The gate
 * is the load-bearing §14.6 invariant: the USECASE reads the live gate first and
 * degrades (abstain / count-basis) data-driven, never code constants.
 */

import { ok, type Result } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  authorityCpvSpend,
  supplierConcentration,
  topSuppliers,
  topSuppliersByRegionCpv,
} from '@/modules/procurement/core/usecases.js';
import { mapCapabilityGate } from '@/modules/procurement/shell/repo/mappers.js';

import type { ProcurementAggregateRepo } from '@/modules/procurement/core/ports.js';
import type { GrainQuality, ProcurementGrain } from '@/modules/procurement/core/types.js';
import type { ApiError } from '@/modules/shared/index.js';

const gateRow = (grain: ProcurementGrain, over: Partial<GrainQuality>): GrainQuality => ({
  grain,
  rowsCount: '1000',
  authorityCuiCoverageRate: 1,
  supplierCuiCoverageRate: 1,
  amountCoverageRate: 1,
  cpvCoverageRate: 1,
  dateCoverageRate: 1,
  authorityTerritoryCoverageRate: 0,
  filterAnswersAllowed: true,
  spendRankingsAllowed: true,
  supplierRegionFiltersAllowed: false,
  blockers: [],
  refreshedAt: '2026-06-16T21:17:44Z',
  projectionVersion: 'test-v1',
  ...over,
});

/** A mock aggregate repo whose gate rows + edge data are injected per test. */
const mockRepo = (
  gates: readonly GrainQuality[],
  over: Partial<ProcurementAggregateRepo> = {}
): ProcurementAggregateRepo => ({
  // The scope-aggregate methods are exercised in aggregate-scope.test.ts; this fake
  // only needs the edge/cpv surface the gate usecases below call.
  scopeStats: () => Promise.reject(new Error('unused')),
  scopeTopParties: () => Promise.reject(new Error('unused')),
  scopeCategoryBreakdown: () => Promise.reject(new Error('unused')),
  scopeSpendOverTime: () => Promise.reject(new Error('unused')),
  grainQuality: () => Promise.resolve(ok(gates) as Result<readonly GrainQuality[], ApiError>),
  topSuppliersForAuthority: vi.fn(() => Promise.resolve(ok([]))),
  topAuthoritiesForSupplier: vi.fn(() => Promise.resolve(ok([]))),
  repeatedPairs: vi.fn(() => Promise.resolve(ok([]))),
  supplierConcentration: vi.fn(() =>
    Promise.resolve(
      ok({
        authorityCui: 'X',
        grain: 'direct_acquisition' as const,
        supplierCount: 3,
        basis: 'value' as const,
        top1Share: 0.5,
        top5Share: 1,
        hhi: 0.4,
        totalRon: '100',
        caveats: [],
      })
    )
  ),
  authorityCpvSpend: vi.fn(() => Promise.resolve(ok([]))),
  topSuppliersByRegionCpv: vi.fn(() => Promise.resolve(ok([]))),
  sameDaySplittingCandidates: vi.fn(() =>
    Promise.resolve(ok({ items: [], total: null, estimated: true }))
  ),
  presenceFor: vi.fn(() => Promise.resolve(ok(null))),
  profileSlice: vi.fn(() => Promise.resolve(ok(null))),
  ...over,
});

describe('gate: filterAnswersAllowed=false → ABSTAIN (never fabricate)', () => {
  it('topSuppliers returns empty data + a blockers caveat, does NOT hit the rollup', async () => {
    const top = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo(
      [
        gateRow('procurement_contract', {
          filterAnswersAllowed: false,
          blockers: ['amount coverage low'],
        }),
      ],
      { topSuppliersForAuthority: top }
    );
    const res = await topSuppliers(repo, '4305857', { grain: 'procurement_contract', topN: 5 });
    expect(res.isOk()).toBe(true);
    const r = res._unsafeUnwrap();
    expect(r.data).toEqual([]);
    expect(r.caveats[0]).toContain('not gate-approved');
    expect(r.caveats[0]).toContain('amount coverage low');
    expect(top).not.toHaveBeenCalled(); // abstained before querying
  });
});

describe('gate: spendRankingsAllowed=false → count-degrade with caveat', () => {
  it('topSuppliers queries with orderByValue=false (rank by count) + flags the caveat', async () => {
    const top = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo([gateRow('procurement_contract', { spendRankingsAllowed: false })], {
      topSuppliersForAuthority: top,
    });
    const res = await topSuppliers(repo, '4305857', { grain: 'procurement_contract', topN: 5 });
    const r = res._unsafeUnwrap();
    // The gate is NOT ignored: the repo is told to order by flow_count, not value.
    expect(top).toHaveBeenCalledWith('4305857', expect.anything(), false);
    expect(r.caveats.some((c) => c.includes('spend rankings not gate-approved'))).toBe(true);
  });

  it('topSuppliers queries with orderByValue=true when spend is gate-approved', async () => {
    const top = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo([gateRow('direct_acquisition', { spendRankingsAllowed: true })], {
      topSuppliersForAuthority: top,
    });
    await topSuppliers(repo, '4305857', { grain: 'direct_acquisition', topN: 5 });
    expect(top).toHaveBeenCalledWith('4305857', expect.anything(), true);
  });

  it('authorityCpvSpend queries with orderByValue=false when spend is suppressed', async () => {
    const authorityCpv = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo([gateRow('procurement_contract', { spendRankingsAllowed: false })], {
      authorityCpvSpend: authorityCpv,
    });
    const res = await authorityCpvSpend(repo, '4305857', {
      grain: 'procurement_contract',
      topN: 5,
    });
    const r = res._unsafeUnwrap();

    expect(authorityCpv).toHaveBeenCalledWith('4305857', expect.anything(), false);
    expect(r.caveats.some((c) => c.includes('spend rankings not gate-approved'))).toBe(true);
  });

  it('topSuppliersByRegionCpv queries with orderByValue=false when spend is suppressed', async () => {
    const regionalTop = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo([gateRow('procurement_contract', { spendRankingsAllowed: false })], {
      topSuppliersByRegionCpv: regionalTop,
    });
    const res = await topSuppliersByRegionCpv(repo, {
      cpvDivision: '45',
      grain: 'procurement_contract',
      region: 'Bucuresti-Ilfov',
      topN: 5,
    });
    const r = res._unsafeUnwrap();

    expect(regionalTop).toHaveBeenCalledWith(expect.anything(), false);
    expect(r.caveats.some((c) => c.includes('spend rankings not gate-approved'))).toBe(true);
  });

  it('authorityCpvSpend queries with orderByValue=true when spend is gate-approved', async () => {
    const authorityCpv = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo([gateRow('direct_acquisition', { spendRankingsAllowed: true })], {
      authorityCpvSpend: authorityCpv,
    });

    await authorityCpvSpend(repo, '4305857', {
      grain: 'direct_acquisition',
      topN: 5,
    });

    expect(authorityCpv).toHaveBeenCalledWith('4305857', expect.anything(), true);
  });

  it('topSuppliersByRegionCpv queries with orderByValue=true when spend is gate-approved', async () => {
    const regionalTop = vi.fn(() => Promise.resolve(ok([])));
    const repo = mockRepo([gateRow('direct_acquisition', { spendRankingsAllowed: true })], {
      topSuppliersByRegionCpv: regionalTop,
    });

    await topSuppliersByRegionCpv(repo, {
      cpvDivision: '45',
      grain: 'direct_acquisition',
      region: 'Bucuresti-Ilfov',
      topN: 5,
    });

    expect(regionalTop).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('supplierConcentration passes basis=count when spend is suppressed', async () => {
    const conc = vi.fn(() =>
      Promise.resolve(
        ok({
          authorityCui: 'X',
          grain: 'procurement_contract' as const,
          supplierCount: 3,
          basis: 'count' as const,
          top1Share: 0.5,
          top5Share: 1,
          hhi: 0.4,
          totalRon: null,
          caveats: [],
        })
      )
    );
    const repo = mockRepo([gateRow('procurement_contract', { spendRankingsAllowed: false })], {
      supplierConcentration: conc,
    });
    await supplierConcentration(repo, '4305857', { grain: 'procurement_contract', topN: 0 });
    // The usecase computes basis from the live gate and passes it to the repo.
    expect(conc).toHaveBeenCalledWith('4305857', expect.anything(), 'count');
  });

  it('supplierConcentration passes basis=value when spend is allowed', async () => {
    const conc = vi.fn(() =>
      Promise.resolve(
        ok({
          authorityCui: 'X',
          grain: 'direct_acquisition' as const,
          supplierCount: 3,
          basis: 'value' as const,
          top1Share: 0.5,
          top5Share: 1,
          hhi: 0.4,
          totalRon: '100',
          caveats: [],
        })
      )
    );
    const repo = mockRepo([gateRow('direct_acquisition', { spendRankingsAllowed: true })], {
      supplierConcentration: conc,
    });
    await supplierConcentration(repo, '4305857', { grain: 'direct_acquisition', topN: 0 });
    expect(conc).toHaveBeenCalledWith('4305857', expect.anything(), 'value');
  });
});

describe('gate: concentration abstains when filterAnswersAllowed=false', () => {
  it('returns a zeroed concentration + caveat without hitting the rollup', async () => {
    const conc = vi.fn();
    const repo = mockRepo([gateRow('procurement_contract', { filterAnswersAllowed: false })], {
      supplierConcentration: conc,
    });
    const res = await supplierConcentration(repo, '4305857', {
      grain: 'procurement_contract',
      topN: 0,
    });
    const c = res._unsafeUnwrap();
    expect(c.supplierCount).toBe(0);
    expect(c.caveats[0]).toContain('not gate-approved');
    expect(conc).not.toHaveBeenCalled();
  });
});

// ── the client-facing gate projection ─────────────────────────────────────────

describe('mapCapabilityGate (the client contract)', () => {
  const row = gateRow('procurement_contract', {
    rowsCount: '970182',
    spendRankingsAllowed: false,
    amountCoverageRate: 0.42,
    blockers: ['procurement_contract amount coverage below spend-ranking threshold'],
    refreshedAt: '2026-06-29 07:26:59.000658+00',
  });

  it('stringifies the coverage rates (no float on the wire)', () => {
    const gate = mapCapabilityGate(row);
    expect(gate.amountCoverageRate).toBe('0.42');
    expect(typeof gate.rowsCount).toBe('string');
    expect(typeof gate.cpvCoverageRate).toBe('string');
  });

  it('derives dataAsOf as YYYY-MM-DD from the matview refresh watermark', () => {
    expect(mapCapabilityGate(row).dataAsOf).toBe('2026-06-29');
  });

  it('null refreshedAt → null dataAsOf, never a fabricated "today"', () => {
    expect(
      mapCapabilityGate(gateRow('direct_acquisition', { refreshedAt: null })).dataAsOf
    ).toBeNull();
  });

  it('cadence is ALWAYS null — nothing declares a schedule and the MVs drift', () => {
    // refreshed_at was 2026-06-29 when read on 2026-07-09: claiming "daily" would lie.
    expect(mapCapabilityGate(row).cadence).toBeNull();
  });

  it('carries the grain, the gate booleans and the blockers verbatim', () => {
    const gate = mapCapabilityGate(row);
    expect(gate.sourceGrain).toBe('procurement_contract');
    expect(gate.spendRankingsAllowed).toBe(false);
    expect(gate.filterAnswersAllowed).toBe(true);
    expect(gate.blockers).toHaveLength(1);
  });

  it('does not surface the internal projectionVersion / territory rate', () => {
    const gate = mapCapabilityGate(row) as unknown as Record<string, unknown>;
    expect('projectionVersion' in gate).toBe(false);
    expect('authorityTerritoryCoverageRate' in gate).toBe(false);
  });
});
