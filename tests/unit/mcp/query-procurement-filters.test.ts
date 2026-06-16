/**
 * Unit tests for query_procurement_filters MCP use case.
 */

import { err, ok } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import {
  queryProcurementFilters,
  type McpProcurementRepo,
  type ProcurementAggregateQuality,
  type ProcurementCategoryBreakdownRow,
  type ProcurementFilterQuery,
  type ProcurementSameDayCandidateRow,
  type ProcurementSupplierRankingRow,
  type QueryProcurementFiltersDeps,
} from '@/modules/mcp/index.js';

const DIRECT_ACQUISITION_QUALITY: ProcurementAggregateQuality = {
  amountCoverageRate: 0.999,
  authorityCuiCoverageRate: 0.99,
  authorityTerritoryCoverageRate: 0.76,
  blockers: ['direct_acquisition supplier region filters not approved in v1'],
  cpvCoverageRate: 0.99,
  dateCoverageRate: 0.96,
  filterAnswersAllowed: true,
  rowsCount: 15_790_420,
  sourceGrain: 'direct_acquisition',
  spendRankingsAllowed: true,
  supplierCuiCoverageRate: 0.99,
  supplierRegionFiltersAllowed: false,
};

const CONTRACT_QUALITY: ProcurementAggregateQuality = {
  amountCoverageRate: 0.838,
  authorityCuiCoverageRate: 0.98,
  authorityTerritoryCoverageRate: 0.81,
  blockers: [
    'procurement_contract amount coverage below spend-ranking threshold',
    'procurement_contract supplier region filters not approved in v1',
  ],
  cpvCoverageRate: 0.92,
  dateCoverageRate: 0.86,
  filterAnswersAllowed: true,
  rowsCount: 865_567,
  sourceGrain: 'procurement_contract',
  spendRankingsAllowed: false,
  supplierCuiCoverageRate: 0.97,
  supplierRegionFiltersAllowed: false,
};

function makeSupplierRow(
  overrides: Partial<ProcurementSupplierRankingRow> = {}
): ProcurementSupplierRankingRow {
  return {
    amountMissingCount: 0,
    amountPresentCount: 3,
    amountRonSum: 123_000_000,
    authorityCount: 1,
    cpvDivisionCode: '45',
    cpvDivisionLabelEn: 'Construction work',
    evidenceRefsSample: ['contract:CN1075544'],
    firstFlowDate: '2025-01-01',
    flowCount: 3,
    lastFlowDate: '2025-03-01',
    supplierCui: '17042060',
    supplierName: 'UMB SPEDITION SRL',
    ...overrides,
  };
}

function makeFakeProcurementRepo(
  options: {
    categoryRows?: ProcurementCategoryBreakdownRow[];
    error?: boolean;
    quality?: ProcurementAggregateQuality[];
    sameDayRows?: ProcurementSameDayCandidateRow[];
    supplierRows?: ProcurementSupplierRankingRow[];
  } = {}
): McpProcurementRepo {
  return {
    async getAggregateQuality() {
      if (options.error === true) {
        return err({ code: 'DATABASE_ERROR', message: 'Query failed' });
      }
      return ok(options.quality ?? [DIRECT_ACQUISITION_QUALITY, CONTRACT_QUALITY]);
    },
    async listSameDayDirectAcquisitionCandidates(_query: ProcurementFilterQuery) {
      return ok(options.sameDayRows ?? []);
    },
    async rankCpvDivisions(_query: ProcurementFilterQuery) {
      return ok(options.categoryRows ?? []);
    },
    async rankSuppliers(_query: ProcurementFilterQuery) {
      return ok(options.supplierRows ?? [makeSupplierRow()]);
    },
  };
}

function makeDeps(
  repo: McpProcurementRepo = makeFakeProcurementRepo()
): QueryProcurementFiltersDeps {
  return { procurementRepo: repo };
}

describe('queryProcurementFilters', () => {
  it('returns deterministic supplier rankings with quality and caveats', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
      authorityCui: '36727850',
      cpvDivisionCode: '45',
      sourceGrain: 'direct_acquisition',
    });

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('allowed');
    expect(output.answerClass).toBe('spend_ranking');
    expect(output.quality?.sourceGrain).toBe('direct_acquisition');
    expect(output.rows).toEqual([makeSupplierRow()]);
    expect(output.caveats[0]).toContain('flows.money_flows');
  });

  it('abstains from procurement-contract spend rankings when amount coverage is blocked', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
      authorityCui: '36727850',
      sourceGrain: 'procurement_contract',
    });

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('abstained');
    expect(output.rows).toEqual([]);
    expect(output.summary).toContain('spend rankings are not approved');
    expect(output.quality?.blockers).toContain(
      'procurement_contract amount coverage below spend-ranking threshold'
    );
  });

  it('allows procurement-contract count rankings when filter coverage passes', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
      authorityCui: '36727850',
      rankBy: 'flow_count',
      sourceGrain: 'procurement_contract',
    });

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('allowed');
    expect(output.answerClass).toBe('filter');
    expect(output.rows).toHaveLength(1);
  });

  it('rejects unscoped corpus-wide queries', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('INVALID_INPUT');
  });

  it('rejects date-only corpus-wide queries', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
      yearStart: 2025,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('At least one');
  });

  it('rejects same-day candidate queries for procurement contracts', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'same_day_direct_acquisition_candidates',
      authorityCui: '123',
      sourceGrain: 'procurement_contract',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('direct_acquisition');
  });
});
