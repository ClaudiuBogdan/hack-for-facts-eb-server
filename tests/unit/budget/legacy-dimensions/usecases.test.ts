/**
 * Legacy dimension usecases: the legacy clamps, the per-root pageInfo formulas,
 * `[ID!]` validation and the documented deltas (design 13 §1 manifest).
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it, vi } from 'vitest';

import {
  listLegacyBudgetSectors,
  listLegacyClassifications,
  listLegacyFundingSources,
} from '@/modules/budget/core/legacy-dimensions/usecases.js';
import { databaseError } from '@/modules/shared/index.js';

import type { LegacyDimensionRepo } from '@/modules/budget/core/legacy-dimensions/ports.js';

const repo = (over: Partial<LegacyDimensionRepo> = {}): LegacyDimensionRepo => ({
  listSectors: vi.fn(async () => ok({ rows: [], totalCount: 0 })),
  listFundingSources: vi.fn(async () => ok({ rows: [], totalCount: 0 })),
  listClassifications: vi.fn(async () => ok({ rows: [], totalCount: 0 })),
  ...over,
});

describe('legacy budgetSectors', () => {
  it('clamps limit to [1, 200], offset to ≥ 0, trims the search, and passes integer ids', async () => {
    const r = repo();
    await listLegacyBudgetSectors(r, {
      search: '  local ',
      ids: ['1', '3'],
      limit: 9999,
      offset: -5,
    });
    expect(r.listSectors).toHaveBeenCalledWith({
      search: 'local',
      ids: [1, 3],
      limit: 200,
      offset: 0,
    });
    await listLegacyBudgetSectors(r, { limit: 0 });
    expect(r.listSectors).toHaveBeenLastCalledWith({ limit: 1, offset: 0 });
    await listLegacyBudgetSectors(r, { search: '   ', ids: [] });
    expect(r.listSectors).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
  });

  it('treats explicit nulls as "no filter" (legacy answered Internal server error)', async () => {
    const r = repo();
    await listLegacyBudgetSectors(r, { search: null, ids: null, limit: null, offset: null });
    expect(r.listSectors).toHaveBeenLastCalledWith({ limit: 20, offset: 0 });
    await listLegacyClassifications(r, 'economic', { search: null, codes: null });
    expect(r.listClassifications).toHaveBeenLastCalledWith('economic', { limit: 100, offset: 0 });
  });

  it('rejects a non-integer id as InvalidInput (delta 11: legacy silently dropped it)', async () => {
    const r = repo();
    const result = await listLegacyBudgetSectors(r, { ids: ['1', 'abc'] });
    expect(result.isErr() && result.error.type).toBe('InvalidInput');
    expect(r.listSectors).not.toHaveBeenCalled();
  });

  it('maps ids to strings and computes hasNextPage = offset + limit < totalCount', async () => {
    const r = repo({
      listSectors: async () =>
        ok({ rows: [{ sectorId: 3, sectorDescription: 'Bugetul local' }], totalCount: 5 }),
    });
    const page = await listLegacyBudgetSectors(r, { limit: 2, offset: 2 });
    expect(page.isOk() && page.value).toEqual({
      nodes: [{ sector_id: '3', sector_description: 'Bugetul local' }],
      pageInfo: { totalCount: 5, hasNextPage: true, hasPreviousPage: true },
    });
    const last = await listLegacyBudgetSectors(r, { limit: 2, offset: 4 });
    expect(last.isOk() && last.value.pageInfo).toEqual({
      totalCount: 5,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it('propagates a repo error', async () => {
    const r = repo({ listSectors: async () => err(databaseError('boom')) });
    const result = await listLegacyBudgetSectors(r, {});
    expect(result.isErr() && result.error.type).toBe('Database');
  });
});

describe('legacy fundingSources', () => {
  it('uses the legacy defaults (limit 10, max 200) and the same pageInfo formula', async () => {
    const r = repo({
      listFundingSources: vi.fn(async () =>
        ok({ rows: [{ sourceId: 1, sourceDescription: 'Integral de la buget' }], totalCount: 10 })
      ),
    });
    await listLegacyFundingSources(r, {});
    expect(r.listFundingSources).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    await listLegacyFundingSources(r, { limit: 500, ids: ['4'] });
    expect(r.listFundingSources).toHaveBeenLastCalledWith({ ids: [4], limit: 200, offset: 0 });
    const page = await listLegacyFundingSources(r, { limit: 10, offset: 0 });
    expect(page.isOk() && page.value).toEqual({
      nodes: [{ source_id: '1', source_description: 'Integral de la buget' }],
      pageInfo: { totalCount: 10, hasNextPage: false, hasPreviousPage: false },
    });
  });
});

describe('legacy classifications', () => {
  it('clamps to [1, 2000] (S1-10: legacy 1000 truncated the catalog) and passes codes', async () => {
    const r = repo();
    await listLegacyClassifications(r, 'functional', { limit: 10000, codes: ['65.02', '51.02'] });
    expect(r.listClassifications).toHaveBeenCalledWith('functional', {
      codes: ['65.02', '51.02'],
      limit: 2000,
      offset: 0,
    });
    await listLegacyClassifications(r, 'economic', { search: '10.01', limit: 100, offset: 100 });
    expect(r.listClassifications).toHaveBeenLastCalledWith('economic', {
      search: '10.01',
      limit: 100,
      offset: 100,
    });
  });

  it('reports a clamp that leaves rows behind, and stays silent otherwise', async () => {
    const r = repo({
      listClassifications: async () => ok({ rows: [{ code: '01', name: 'x' }], totalCount: 2500 }),
    });
    const clamped: unknown[] = [];
    await listLegacyClassifications(
      r,
      'functional',
      { limit: 10000 },
      { onClamped: (i) => clamped.push(i) }
    );
    expect(clamped).toEqual([
      { kind: 'functional', requested: 10000, clamp: 2000, totalCount: 2500 },
    ]);
    // Within the clamp, or clamped but nothing left behind: no event.
    await listLegacyClassifications(
      r,
      'functional',
      { limit: 100 },
      { onClamped: (i) => clamped.push(i) }
    );
    const small = repo({
      listClassifications: async () => ok({ rows: [], totalCount: 1117 }),
    });
    await listLegacyClassifications(
      small,
      'functional',
      { limit: 10000 },
      { onClamped: (i) => clamped.push(i) }
    );
    expect(clamped).toHaveLength(1);
  });

  it('computes hasNextPage = offset + rows.length < totalCount (the classification formula)', async () => {
    const r = repo({
      listClassifications: async () =>
        ok({
          rows: [
            { code: '10.01', name: 'Salarii' },
            { code: '10.02', name: null },
          ],
          totalCount: 3,
        }),
    });
    const page = await listLegacyClassifications(r, 'economic', { limit: 2, offset: 0 });
    expect(page.isOk() && page.value).toEqual({
      nodes: [
        { code: '10.01', name: 'Salarii' },
        { code: '10.02', name: '' },
      ],
      pageInfo: { totalCount: 3, hasNextPage: true, hasPreviousPage: false },
    });
    // limit 100 but 2 rows returned of 3 total at offset 1 → 1 + 2 < 3 is false.
    const tail = await listLegacyClassifications(r, 'economic', { limit: 100, offset: 1 });
    expect(tail.isOk() && tail.value.pageInfo).toEqual({
      totalCount: 3,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });
});
