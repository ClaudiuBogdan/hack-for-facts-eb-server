/**
 * Analysis request validation (`routeAnalysis`) after the ClickHouse migration:
 * the rollup-capability matrix is gone, so geography / 8-digit-cpvCode / buyer
 * conjunctions that the wave-1 rollups could not serve now fan out to every
 * applicable grain. Only the BACKEND-INDEPENDENT semantic rules still reject —
 * single-supplier concentration, distinct-key pinning, single-bucket
 * breakdowns, and the per-grain structural exclusions (DA has no procedureType;
 * procedures have no supplier).
 */

import { describe, expect, it } from 'vitest';

import { routeAnalysis } from '@/modules/procurement/core/combinations.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';

const grainsOf = (
  scope: AnalysisScope,
  shape: 'stats' | 'series' | 'breakdown' | 'concentration',
  dimension?: Parameters<typeof routeAnalysis>[2],
  measure?: Parameters<typeof routeAnalysis>[3]
): readonly string[] =>
  routeAnalysis(scope, shape, dimension, measure)
    ._unsafeUnwrap()
    .map((r) => r.grain);

const errorOf = (
  scope: AnalysisScope,
  shape: 'stats' | 'series' | 'breakdown' | 'concentration',
  dimension?: Parameters<typeof routeAnalysis>[2],
  measure?: Parameters<typeof routeAnalysis>[3]
): string => routeAnalysis(scope, shape, dimension, measure)._unsafeUnwrapErr().message;

describe('grain fan-out (route carries only the grain)', () => {
  it('platform-wide stats fan out to every grain', () => {
    expect(grainsOf({}, 'stats')).toEqual(['procedure', 'contract', 'direct_acquisition']);
  });

  it('an explicit grain yields exactly that grain', () => {
    expect(grainsOf({ grain: 'contract' }, 'stats')).toEqual(['contract']);
  });

  it('authority-anchored stats fan out to every grain', () => {
    expect(grainsOf({ authorityCui: '4267117' }, 'stats')).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
  });

  it('supplier-anchored answers drop the (supplier-less) procedure grain', () => {
    expect(grainsOf({ supplierCui: '11805367' }, 'stats')).toEqual([
      'contract',
      'direct_acquisition',
    ]);
    expect(grainsOf({ supplierCui: '11805367', cpvDivision: '33' }, 'stats')).toEqual([
      'contract',
      'direct_acquisition',
    ]);
  });

  it('procedureType answers skip the DA grain (its rows never carry procedure_type)', () => {
    expect(grainsOf({ procedureType: 'licitatie-deschisa' }, 'stats')).toEqual([
      'procedure',
      'contract',
    ]);
    expect(grainsOf({ authorityCui: 'x' }, 'breakdown', 'procedureType')).toEqual([
      'procedure',
      'contract',
    ]);
  });

  it('breakdown(supplier) under an authority scope routes to contract + DA only', () => {
    expect(grainsOf({ authorityCui: '4267117' }, 'breakdown', 'supplier')).toEqual([
      'contract',
      'direct_acquisition',
    ]);
  });

  it('distinct measures fan out to the supplier-carrying grains only', () => {
    // No more "requires an explicit contract grain" / "unbounded DA" rejections.
    expect(grainsOf({}, 'series', undefined, 'distinctSuppliers')).toEqual([
      'contract',
      'direct_acquisition',
    ]);
    expect(
      grainsOf({ grain: 'direct_acquisition' }, 'series', undefined, 'distinctSuppliers')
    ).toEqual(['direct_acquisition']);
    expect(grainsOf({ authorityCui: 'x' }, 'series', undefined, 'distinctSuppliers')).toEqual([
      'contract',
      'direct_acquisition',
    ]);
  });
});

describe('combinations the wave-1 rollups rejected now route (ClickHouse serves them)', () => {
  it('supplier geography routes instead of the old milestone-M3 rejection', () => {
    for (const scope of [
      { supplierRegion: 'Nord-Vest' },
      { supplierCounty: 'CJ' },
      { supplierSiruta: '57706' },
    ] as const) {
      expect(grainsOf(scope, 'stats')).toEqual(['contract', 'direct_acquisition']);
    }
  });

  it('buyer county / SIRUTA scopes route on every grain', () => {
    expect(grainsOf({ buyerCounty: 'CJ' }, 'stats')).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
    expect(grainsOf({ buyerSiruta: '57706' }, 'stats')).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
  });

  it('buyer county / SIRUTA breakdowns route on every grain', () => {
    expect(grainsOf({}, 'breakdown', 'buyerCounty')).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
    expect(grainsOf({}, 'breakdown', 'buyerSiruta')).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
  });

  it('supplier geography breakdowns route on contract + DA only', () => {
    expect(grainsOf({}, 'breakdown', 'supplierRegion')).toEqual(['contract', 'direct_acquisition']);
    expect(grainsOf({}, 'breakdown', 'supplierCounty')).toEqual(['contract', 'direct_acquisition']);
    expect(grainsOf({}, 'breakdown', 'supplierSiruta')).toEqual(['contract', 'direct_acquisition']);
  });

  it('an 8-digit cpvCode combined with another dimension routes (bounded-fact rejection gone)', () => {
    expect(grainsOf({ authorityCui: '4267117', cpvCode: '33600000' }, 'stats')).toEqual([
      'procedure',
      'contract',
      'direct_acquisition',
    ]);
    expect(grainsOf({ supplierCui: '11805367', cpvCode: '33600000' }, 'stats')).toEqual([
      'contract',
      'direct_acquisition',
    ]);
  });
});

describe('backend-independent semantic rejections still fire, with the field named', () => {
  it('a supplier-fixed concentration is a single-supplier tautology', () => {
    const message = errorOf({ supplierCui: '11805367' }, 'concentration');
    expect(message).toContain('supplierCui');
    expect(message).toContain('tautology');
  });

  it('a distinct measure requires its measured key to remain free', () => {
    expect(
      errorOf(
        { supplierCui: '11805367', grain: 'contract' },
        'series',
        undefined,
        'distinctSuppliers'
      )
    ).toContain('measured');
    expect(
      errorOf(
        { authorityCui: '4267117', grain: 'contract' },
        'series',
        undefined,
        'distinctAuthorities'
      )
    ).toContain('measured');
  });

  it('a breakdown over a dimension the scope already fixes is a single bucket', () => {
    expect(errorOf({ authorityCui: 'x' }, 'breakdown', 'authority')).toContain('single-bucket');
    // cpvDivision is fixed transitively by an 8-digit cpvCode.
    expect(errorOf({ cpvCode: '33600000' }, 'breakdown', 'cpvDivision')).toContain('cpvCode');
  });

  it('an explicit DA grain with procedureType is rejected with the structural reason', () => {
    const message = errorOf(
      { authorityCui: 'x', procedureType: 'licitatie-deschisa', grain: 'direct_acquisition' },
      'stats'
    );
    expect(message).toContain('direct_acquisition grain has no procedure_type dimension');
  });

  it('an explicit procedure grain under a supplier scope is rejected, not silently dropped', () => {
    const message = errorOf({ supplierCui: '11805367', grain: 'procedure' }, 'stats');
    expect(message).toContain('procedure grain has no supplier dimension');
  });

  it('an explicit procedure grain concentration is rejected (no supplier to concentrate)', () => {
    expect(errorOf({ grain: 'procedure' }, 'concentration')).toContain(
      'procedure grain has no supplier dimension'
    );
  });
});

describe('recordKind is contract-grain only', () => {
  it('implicit grains under a recordKind scope route to contract alone', () => {
    expect(grainsOf({ recordKind: 'framework_agreement' }, 'stats')).toEqual(['contract']);
  });

  it('an explicit non-contract grain with recordKind is rejected with the structural reason', () => {
    for (const grain of ['direct_acquisition', 'procedure'] as const) {
      expect(errorOf({ recordKind: 'contract_award', grain }, 'stats')).toContain(
        'record_kind exists only on the contract grain'
      );
    }
  });

  it('a recordKind breakdown routes to contract alone and rejects explicit other grains', () => {
    expect(grainsOf({}, 'breakdown', 'recordKind')).toEqual(['contract']);
    expect(errorOf({ grain: 'procedure' }, 'breakdown', 'recordKind')).toContain(
      'record_kind exists only on the contract grain'
    );
  });

  it('a recordKind-fixed recordKind breakdown is a single bucket', () => {
    expect(errorOf({ recordKind: 'contract_award' }, 'breakdown', 'recordKind')).toContain(
      'single-bucket'
    );
  });
});

describe('CPV hierarchy: a finer scope fixes every coarser breakdown', () => {
  it('a cpvCode scope fixes category, class, group and division breakdowns', () => {
    for (const dimension of ['cpvCategory', 'cpvClass', 'cpvGroup', 'cpvDivision'] as const) {
      expect(errorOf({ cpvCode: '45233140' }, 'breakdown', dimension)).toContain('cpvCode');
    }
  });

  it('a cpvGroup scope fixes the division breakdown but leaves finer levels free', () => {
    expect(errorOf({ cpvGroup: '45200000' }, 'breakdown', 'cpvDivision')).toContain('cpvGroup');
    for (const dimension of ['cpvClass', 'cpvCategory', 'cpvCode'] as const) {
      expect(grainsOf({ cpvGroup: '45200000' }, 'breakdown', dimension).length).toBeGreaterThan(0);
    }
  });
});
