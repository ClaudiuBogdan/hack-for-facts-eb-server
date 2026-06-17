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
  type ProcurementFilterCapability,
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

const DEFAULT_CAPABILITY_COVERAGE = {
  amountCoverageRate: 0.999,
  authorityCuiCoverageRate: 0.99,
  authorityTerritoryCoverageRate: 0.76,
  cpvCoverageRate: 0.99,
  cpvDivisionCoverageRate: 0.98,
  dateCoverageRate: 0.96,
  rowsCount: 15_790_420,
  supplierCuiCoverageRate: 0.99,
};

const RANKING_CAPABILITY_DIMENSIONS = [
  'source_grain',
  'authority_cui',
  'supplier_cui',
  'cpv_division_code',
  'month_start',
  'authority_county_code',
  'authority_region',
];

const SAME_DAY_CAPABILITY_DIMENSIONS = [
  'authority_cui',
  'supplier_cui',
  'candidate_date',
  'cpv_code',
  'cpv_division_code',
  'authority_county_code',
  'authority_region',
];

function makeCapability(
  overrides: Partial<ProcurementFilterCapability> &
    Pick<ProcurementFilterCapability, 'answerClass' | 'sourceGrain'>
): ProcurementFilterCapability {
  return {
    allowed: true,
    allowedDimensions: ['source_grain', 'authority_cui'],
    blockers: [],
    capabilityVersion: 'public-contracts-filter-capabilities-v1',
    caveats: [],
    coverage: DEFAULT_CAPABILITY_COVERAGE,
    projectionVersion: 'procurement-aggregate-filters-v1',
    rankingMode: null,
    refreshedAt: '2026-06-17T00:00:00.000Z',
    requiredProjection: 'procurement.org_edge_monthly_rollups',
    ...overrides,
  };
}

function defaultCapabilities(): ProcurementFilterCapability[] {
  return [
    makeCapability({
      allowedDimensions: RANKING_CAPABILITY_DIMENSIONS,
      answerClass: 'spend_ranked_top_n',
      caveats: ['Allowed only when amount coverage passes the stricter spend gate.'],
      rankingMode: 'value',
      sourceGrain: 'direct_acquisition',
    }),
    makeCapability({
      allowedDimensions: RANKING_CAPABILITY_DIMENSIONS,
      answerClass: 'count_ranked_top_n',
      rankingMode: 'count',
      sourceGrain: 'direct_acquisition',
    }),
    makeCapability({
      allowedDimensions: ['authority_county_code', 'authority_region'],
      answerClass: 'buyer_region_filter',
      sourceGrain: 'direct_acquisition',
    }),
    makeCapability({
      allowedDimensions: ['cpv_division_code'],
      answerClass: 'cpv_category_filter',
      sourceGrain: 'direct_acquisition',
    }),
    makeCapability({
      allowedDimensions: SAME_DAY_CAPABILITY_DIMENSIONS,
      answerClass: 'same_day_direct_acquisition_signal',
      rankingMode: 'count',
      sourceGrain: 'direct_acquisition',
    }),
    makeCapability({
      allowed: false,
      allowedDimensions: [],
      answerClass: 'spend_ranked_top_n',
      blockers: ['procurement_contract amount coverage below spend-ranking threshold'],
      rankingMode: 'value',
      sourceGrain: 'procurement_contract',
    }),
    makeCapability({
      allowedDimensions: RANKING_CAPABILITY_DIMENSIONS,
      answerClass: 'count_ranked_top_n',
      rankingMode: 'count',
      sourceGrain: 'procurement_contract',
    }),
    makeCapability({
      allowedDimensions: ['authority_county_code', 'authority_region'],
      answerClass: 'buyer_region_filter',
      sourceGrain: 'procurement_contract',
    }),
    makeCapability({
      allowedDimensions: ['cpv_division_code'],
      answerClass: 'cpv_category_filter',
      sourceGrain: 'procurement_contract',
    }),
    makeCapability({
      allowed: false,
      allowedDimensions: [],
      answerClass: 'same_day_direct_acquisition_signal',
      blockers: ['procurement_contract same-day direct-acquisition signal does not apply'],
      rankingMode: 'count',
      sourceGrain: 'procurement_contract',
    }),
    makeCapability({
      allowed: false,
      allowedDimensions: [],
      answerClass: 'llm_generated_filter',
      blockers: ['LLM-generated filters are not authoritative in v1'],
      sourceGrain: 'direct_acquisition',
    }),
  ];
}

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
    capabilities?: ProcurementFilterCapability[];
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
    async getFilterCapabilities(sourceGrains) {
      return ok(
        (options.capabilities ?? defaultCapabilities()).filter((capability) =>
          sourceGrains.includes(capability.sourceGrain)
        )
      );
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
    expect(output.capabilities?.map((capability) => capability.answerClass)).toEqual([
      'spend_ranked_top_n',
      'cpv_category_filter',
    ]);
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

  it('abstains when the capability view blocks a requested buyer-region filter', async () => {
    const result = await queryProcurementFilters(
      makeDeps(
        makeFakeProcurementRepo({
          capabilities: defaultCapabilities().map((capability) =>
            capability.sourceGrain === 'direct_acquisition' &&
            capability.answerClass === 'buyer_region_filter'
              ? {
                  ...capability,
                  allowed: false,
                  allowedDimensions: [],
                  blockers: ['direct_acquisition buyer territory coverage below threshold'],
                }
              : capability
          ),
        })
      ),
      {
        analysis: 'top_suppliers',
        authorityRegion: 'București-Ilfov',
        sourceGrain: 'direct_acquisition',
      }
    );

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('abstained');
    expect(output.rows).toEqual([]);
    expect(output.summary).toContain(
      'procurement capability direct_acquisition/buyer_region_filter'
    );
  });

  it('abstains when an allowed capability omits a requested dimension', async () => {
    const result = await queryProcurementFilters(
      makeDeps(
        makeFakeProcurementRepo({
          capabilities: defaultCapabilities().map((capability) =>
            capability.sourceGrain === 'direct_acquisition' &&
            capability.answerClass === 'buyer_region_filter'
              ? {
                  ...capability,
                  allowedDimensions: ['authority_county_code'],
                }
              : capability
          ),
        })
      ),
      {
        analysis: 'top_suppliers',
        authorityRegion: 'București-Ilfov',
        rankBy: 'flow_count',
        sourceGrain: 'direct_acquisition',
      }
    );

    expect(result.isOk()).toBe(true);
    const output = result._unsafeUnwrap();
    expect(output.status).toBe('abstained');
    expect(output.summary).toContain('does not approve dimension authority_region');
  });

  it('requires CPV capability only when a CPV division filter is requested', async () => {
    const capabilities = defaultCapabilities().map((capability) =>
      capability.sourceGrain === 'direct_acquisition' &&
      capability.answerClass === 'cpv_category_filter'
        ? {
            ...capability,
            allowed: false,
            allowedDimensions: [],
            blockers: ['direct_acquisition CPV division coverage below 0.85'],
          }
        : capability
    );

    const unfilteredResult = await queryProcurementFilters(
      makeDeps(makeFakeProcurementRepo({ capabilities })),
      {
        analysis: 'category_breakdown',
        authorityCui: '36727850',
        rankBy: 'flow_count',
        sourceGrain: 'direct_acquisition',
      }
    );
    expect(unfilteredResult.isOk()).toBe(true);
    expect(unfilteredResult._unsafeUnwrap().status).toBe('allowed');

    const filteredResult = await queryProcurementFilters(
      makeDeps(makeFakeProcurementRepo({ capabilities })),
      {
        analysis: 'top_suppliers',
        authorityCui: '36727850',
        cpvDivisionCode: '45',
        rankBy: 'flow_count',
        sourceGrain: 'direct_acquisition',
      }
    );
    expect(filteredResult.isOk()).toBe(true);
    const output = filteredResult._unsafeUnwrap();
    expect(output.status).toBe('abstained');
    expect(output.summary).toContain(
      'procurement capability direct_acquisition/cpv_category_filter'
    );
  });

  it('returns a database error when a required capability row is missing', async () => {
    const result = await queryProcurementFilters(
      makeDeps(
        makeFakeProcurementRepo({
          capabilities: defaultCapabilities().filter(
            (capability) =>
              !(
                capability.sourceGrain === 'direct_acquisition' &&
                capability.answerClass === 'spend_ranked_top_n'
              )
          ),
        })
      ),
      {
        analysis: 'top_suppliers',
        authorityCui: '36727850',
        sourceGrain: 'direct_acquisition',
      }
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('DATABASE_ERROR');
    expect(result._unsafeUnwrapErr().message).toContain(
      'Missing procurement capability direct_acquisition/spend_ranked_top_n'
    );
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
    expect(result._unsafeUnwrapErr().message).toContain(
      'authorityCui, authorityCountyCode, authorityRegion, or cpvDivisionCode'
    );
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
