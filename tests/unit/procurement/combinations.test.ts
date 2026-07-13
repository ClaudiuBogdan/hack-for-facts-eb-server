/**
 * The supported-combinations matrix (design §6.2, F5): every wave-1 combination
 * routes to the right rollup per grain; everything else is rejected with the
 * SPECIFIC missing capability named — never a generic "unsupported".
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_MATRIX_SHA256,
  routeAnalysis,
  WAVE1_CAPABILITIES,
} from '@/modules/procurement/core/combinations.js';

import type { AnalysisScope } from '@/modules/procurement/core/analysis-scope.js';

const routesOf = (
  scope: AnalysisScope,
  shape: 'stats' | 'series' | 'breakdown' | 'concentration',
  dimension?: Parameters<typeof routeAnalysis>[2],
  measure?: Parameters<typeof routeAnalysis>[3]
): readonly { rollup: string; grain: string }[] =>
  routeAnalysis(scope, shape, dimension, measure)
    ._unsafeUnwrap()
    .map((r) => ({ rollup: r.rollup.rollup, grain: r.grain }));

const errorOf = (
  scope: AnalysisScope,
  shape: 'stats' | 'series' | 'breakdown' | 'concentration',
  dimension?: Parameters<typeof routeAnalysis>[2],
  measure?: Parameters<typeof routeAnalysis>[3]
): string => routeAnalysis(scope, shape, dimension, measure)._unsafeUnwrapErr().message;

describe('vendored matrix artifact', () => {
  it('ANALYSIS_MATRIX_SHA256 matches the vendored JSON byte-for-byte', () => {
    const artifactPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../src/modules/procurement/core/procurement-analysis-combinations-v2.json'
    );
    const digest = createHash('sha256').update(readFileSync(artifactPath)).digest('hex');
    expect(digest).toBe(ANALYSIS_MATRIX_SHA256);
  });
});

describe('wave-1 combinations route', () => {
  it('declares exactly the five rollups', () => {
    expect(WAVE1_CAPABILITIES.map((c) => c.rollup).sort()).toEqual([
      'authorityDims',
      'cpvCode',
      'edge',
      'regionCpv',
      'supplierCpv',
    ]);
  });

  it('platform-wide stats → the smallest (region_cpv) rollup on all three grains', () => {
    expect(routesOf({}, 'stats')).toEqual([
      { rollup: 'regionCpv', grain: 'procedure' },
      { rollup: 'regionCpv', grain: 'contract' },
      { rollup: 'regionCpv', grain: 'direct_acquisition' },
    ]);
  });

  it('authority scope stats → authority_dims (procedures included)', () => {
    const routes = routesOf({ authorityCui: '4267117' }, 'stats');
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((r) => r.rollup))).toEqual(new Set(['authorityDims']));
  });

  it('supplier scope stats → supplier_cpv (the matrix designation), contract + DA only', () => {
    expect(routesOf({ supplierCui: '11805367' }, 'stats')).toEqual([
      { rollup: 'supplierCpv', grain: 'contract' },
      { rollup: 'supplierCpv', grain: 'direct_acquisition' },
    ]);
  });

  it('authority × supplier pairs → the edge rollup', () => {
    expect(routesOf({ authorityCui: '4267117', supplierCui: '11805367' }, 'stats')).toEqual([
      { rollup: 'edge', grain: 'contract' },
      { rollup: 'edge', grain: 'direct_acquisition' },
    ]);
  });

  it('supplier × cpvDivision → the supplier_cpv rollup', () => {
    const routes = routesOf({ supplierCui: '11805367', cpvDivision: '33' }, 'stats');
    expect(new Set(routes.map((r) => r.rollup))).toEqual(new Set(['supplierCpv']));
  });

  it('status / procedureType scopes and breakdowns → authority_dims', () => {
    expect(routesOf({ status: 'cancelled' }, 'stats')[0]?.rollup).toBe('authorityDims');
    expect(routesOf({ authorityCui: 'x' }, 'breakdown', 'procedureType')[0]?.rollup).toBe(
      'authorityDims'
    );
  });

  it('procedureType answers skip the DA grain (its rows never carry procedure_type)', () => {
    expect(routesOf({ procedureType: 'licitatie-deschisa' }, 'stats').map((r) => r.grain)).toEqual([
      'procedure',
      'contract',
    ]);
    expect(
      routesOf({ authorityCui: 'x' }, 'breakdown', 'procedureType').map((r) => r.grain)
    ).toEqual(['procedure', 'contract']);
  });

  it('breakdown(supplier) under an authority scope → the edge rollup', () => {
    const routes = routesOf({ authorityCui: '4267117' }, 'breakdown', 'supplier');
    expect(new Set(routes.map((r) => r.rollup))).toEqual(new Set(['edge']));
  });

  it('buyerRegion scope → the region_cpv rollup on all grains', () => {
    const routes = routesOf({ buyerRegion: 'Bucuresti-Ilfov' }, 'stats');
    expect(routes).toHaveLength(3);
    expect(new Set(routes.map((r) => r.rollup))).toEqual(new Set(['regionCpv']));
  });

  it('cpvCode scope and breakdown(cpvCode) → the cpv_code rollup', () => {
    expect(new Set(routesOf({ cpvCode: '33600000' }, 'stats').map((r) => r.rollup))).toEqual(
      new Set(['cpvCode'])
    );
    expect(
      new Set(routesOf({ cpvDivision: '33' }, 'breakdown', 'cpvCode').map((r) => r.rollup))
    ).toEqual(new Set(['cpvCode']));
  });

  it('distinct measures route ONLY to the key-retaining edge rollup', () => {
    expect(routesOf({ authorityCui: 'x' }, 'series', undefined, 'distinctSuppliers')).toEqual([
      { rollup: 'edge', grain: 'contract' },
      { rollup: 'edge', grain: 'direct_acquisition' },
    ]);
  });

  it('requires the measured key to remain free', () => {
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
    expect(errorOf({ supplierCui: '11805367', grain: 'contract' }, 'concentration')).toContain(
      'supplier'
    );
  });

  it('rejects unbounded DA and implicit platform distinct series', () => {
    expect(
      errorOf({ grain: 'direct_acquisition' }, 'series', undefined, 'distinctSuppliers')
    ).toContain('unbounded');
    expect(errorOf({}, 'series', undefined, 'distinctSuppliers')).toContain(
      'explicit contract grain'
    );
    expect(routesOf({ grain: 'contract' }, 'series', undefined, 'distinctSuppliers')).toEqual([
      { rollup: 'edge', grain: 'contract' },
    ]);
    expect(
      routesOf(
        { authorityCui: '4267117', grain: 'direct_acquisition' },
        'series',
        undefined,
        'distinctSuppliers'
      )
    ).toEqual([{ rollup: 'edge', grain: 'direct_acquisition' }]);
  });

  it('concentration: authority scope → edge; cpvDivision scope → supplier_cpv', () => {
    expect(new Set(routesOf({ authorityCui: 'x' }, 'concentration').map((r) => r.rollup))).toEqual(
      new Set(['edge'])
    );
    expect(new Set(routesOf({ cpvDivision: '45' }, 'concentration').map((r) => r.rollup))).toEqual(
      new Set(['supplierCpv'])
    );
  });
});

describe('rejections name the missing capability', () => {
  it('breakdown(procedureType) under a supplier scope names the unbuilt rollup', () => {
    const message = errorOf({ supplierCui: '11805367' }, 'breakdown', 'procedureType');
    expect(message).toContain('breakdown(procedureType)');
    expect(message).toContain('supplierCui');
    expect(message).toContain('not built');
  });

  it('supplier geography is named as milestone M3', () => {
    expect(errorOf({ supplierRegion: 'Nord-Vest' }, 'stats')).toContain('M3');
    expect(errorOf({ supplierCounty: 'CJ' }, 'stats')).toContain('M3');
  });

  it('buyerCounty names the missing buyer_county rollup and the alternative', () => {
    const message = errorOf({ buyerCounty: 'CJ' }, 'stats');
    expect(message).toContain('buyer_county');
    expect(message).toContain('buyerRegion');
  });

  it('entity × 8-digit cpvCode is named a bounded fact query, not served in wave 1', () => {
    const message = errorOf({ authorityCui: '4267117', cpvCode: '33600000' }, 'stats');
    expect(message).toContain('bounded fact query');
    expect(message).toContain('cpvDivision');
  });

  it('distinct measures without the edge rollup name key retention', () => {
    const message = errorOf({ cpvDivision: '33' }, 'series', undefined, 'distinctSuppliers');
    expect(message).toContain('key retention');
    expect(message).toContain('edge rollup');
  });

  it('concentration under a region scope names the missing supplier keys', () => {
    const message = errorOf({ buyerRegion: 'Nord-Est' }, 'concentration');
    expect(message).toContain('supplier keys');
  });

  it('an explicit DA grain with procedureType is rejected with the schema reason', () => {
    const message = errorOf(
      { authorityCui: 'x', procedureType: 'licitatie-deschisa', grain: 'direct_acquisition' },
      'stats'
    );
    expect(message).toContain('direct_acquisition grain has no procedure_type dimension');
  });

  it('an explicit procedure grain under a supplier scope is rejected, not silently dropped', () => {
    const message = errorOf({ supplierCui: '11805367', grain: 'procedure' }, 'stats');
    expect(message).toContain('procedure');
    expect(message).toContain('not built');
  });
});
