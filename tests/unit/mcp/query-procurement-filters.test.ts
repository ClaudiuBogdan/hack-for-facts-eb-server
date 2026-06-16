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

function makeCategoryRow(
  overrides: Partial<ProcurementCategoryBreakdownRow> = {}
): ProcurementCategoryBreakdownRow {
  return {
    amountMissingCount: 1,
    amountPresentCount: 4,
    amountRonSum: 98_000_000,
    cpvDivisionCode: '45',
    cpvDivisionLabelEn: 'Construction work',
    distinctSupplierCount: null,
    evidenceRefsSample: ['contract:CN1075544'],
    firstFlowDate: '2025-01-01',
    flowCount: 5,
    lastFlowDate: '2025-05-01',
    ...overrides,
  };
}

function makeSameDayRow(
  overrides: Partial<ProcurementSameDayCandidateRow> = {}
): ProcurementSameDayCandidateRow {
  return {
    amountMissingCount: 0,
    amountPresentCount: 3,
    authorityCountyName: 'Bucuresti',
    authorityCui: '4316422',
    authorityName: 'SECTORUL 4 AL MUNICIPIULUI BUCURESTI',
    authorityRegion: 'Bucuresti-Ilfov',
    candidateDate: '2025-02-03',
    cpvCode: '45000000-7',
    cpvDivisionCode: '45',
    cpvDivisionLabelEn: 'Construction work',
    evidenceRefsSample: ['direct_acquisition:DA123'],
    maxSingleAmountRon: 10_000,
    sameDayCount: 3,
    sameDayTotalRon: 24_000,
    supplierCui: '12345678',
    supplierName: 'EXEMPLU SRL',
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
    expect(output.rows).toMatchObject([{ amountRonSum: null }]);
    expect(output.caveats).toContain(
      'Spend totals are withheld because spend coverage for procurement_contract is below the approved threshold.'
    );
  });

  it('returns category breakdown rows and clamps the limit', async () => {
    const repo = makeFakeProcurementRepo({
      categoryRows: [makeCategoryRow()],
    });
    const result = await queryProcurementFilters(makeDeps(repo), {
      analysis: 'category_breakdown',
      authorityCountyCode: 'B',
      limit: 500,
    });

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.answerClass).toBe('spend_ranking');
    expect(output.query.limit).toBe(50);
    expect(output.rows).toEqual([makeCategoryRow()]);
    expect(output.summary).toContain('CPV division');
  });

  it('returns same-day direct acquisition review signals', async () => {
    const repo = makeFakeProcurementRepo({
      sameDayRows: [makeSameDayRow()],
    });
    const result = await queryProcurementFilters(makeDeps(repo), {
      analysis: 'same_day_direct_acquisition_candidates',
      authorityCui: '4316422',
      rankBy: 'flow_count',
    });

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('allowed');
    expect(output.answerClass).toBe('review_signal');
    expect(output.rows).toEqual([makeSameDayRow()]);
    expect(output.caveats).toContain(
      'Same-day direct-acquisition candidates are review signals, not findings of illegality.'
    );
  });

  it('redacts same-day spend fields when spend coverage is not approved', async () => {
    const repo = makeFakeProcurementRepo({
      quality: [{ ...DIRECT_ACQUISITION_QUALITY, spendRankingsAllowed: false }],
      sameDayRows: [makeSameDayRow()],
    });
    const result = await queryProcurementFilters(makeDeps(repo), {
      analysis: 'same_day_direct_acquisition_candidates',
      authorityCui: '4316422',
      rankBy: 'flow_count',
    });

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('allowed');
    expect(output.rows).toMatchObject([
      {
        maxSingleAmountRon: null,
        sameDayTotalRon: null,
      },
    ]);
  });

  it('abstains when deterministic filter coverage is not approved', async () => {
    const result = await queryProcurementFilters(
      makeDeps(
        makeFakeProcurementRepo({
          quality: [
            {
              ...DIRECT_ACQUISITION_QUALITY,
              blockers: ['direct_acquisition deterministic filter coverage not approved'],
              filterAnswersAllowed: false,
            },
          ],
        })
      ),
      {
        analysis: 'top_suppliers',
        authorityCui: '4316422',
        rankBy: 'flow_count',
      }
    );

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('abstained');
    expect(output.summary).toContain('deterministic filter coverage is not approved');
    expect(output.rows).toEqual([]);
  });

  it('returns a database error when the quality gate row is missing', async () => {
    const result = await queryProcurementFilters(
      makeDeps(makeFakeProcurementRepo({ quality: [] })),
      {
        analysis: 'top_suppliers',
        authorityCui: '4316422',
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
    expect(result._unsafeUnwrapErr().message).toContain('Missing procurement quality gate');
  });

  it('propagates repository errors from the quality gate lookup', async () => {
    const result = await queryProcurementFilters(
      makeDeps(makeFakeProcurementRepo({ error: true })),
      {
        analysis: 'top_suppliers',
        authorityCui: '4316422',
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
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

  it('rejects invalid CPV divisions', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
      authorityCountyCode: 'B',
      cpvDivisionCode: '450',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('two-digit CPV');
  });

  it('rejects inverted year ranges', async () => {
    const result = await queryProcurementFilters(makeDeps(), {
      analysis: 'top_suppliers',
      authorityCountyCode: 'B',
      yearEnd: 2024,
      yearStart: 2025,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('yearStart');
  });
});
