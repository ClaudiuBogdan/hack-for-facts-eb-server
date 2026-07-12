/**
 * The semantic policy table (design §3–§4). The requirements matrix rows are
 * encoded as fixtures naming policy keys; CI asserts the key exists, the row's
 * shape is legal, and the milestone blocks are declared — plus the ABSENCE of
 * entries the data cannot support (procedure-grain distincts).
 */

import { describe, expect, it } from 'vitest';

import { ANALYSIS_GRAINS } from '@/modules/procurement/core/constants.js';
import { POLICY_TABLE, policyFor, type AnalysisShape } from '@/modules/procurement/core/policy.js';

interface MatrixRow {
  readonly policyKey: string;
  readonly shape: AnalysisShape;
  readonly expectBlocked?: { readonly reason: string; readonly milestone: string };
}

/** Design §4 rows → policy keys (supplier/authority/market perspectives). */
const MATRIX: readonly MatrixRow[] = [
  // Totals / counts / averages (stats blocks, per grain)
  { policyKey: 'direct_acquisition.valueAwardedSum', shape: 'stats' },
  { policyKey: 'contract.valueAwardedSum', shape: 'stats' },
  { policyKey: 'procedure.valueAwardedSum', shape: 'stats' },
  { policyKey: 'direct_acquisition.recordCount', shape: 'stats' },
  { policyKey: 'contract.recordCount', shape: 'stats' },
  { policyKey: 'procedure.recordCount', shape: 'stats' },
  { policyKey: 'direct_acquisition.withValueCount', shape: 'stats' },
  { policyKey: 'direct_acquisition.avgValueAwarded', shape: 'stats' },
  { policyKey: 'contract.avgValueAwarded', shape: 'stats' },
  // Rankings / distributions
  { policyKey: 'direct_acquisition.valueAwardedSum', shape: 'breakdown' },
  { policyKey: 'contract.valueAwardedSum', shape: 'breakdown' },
  { policyKey: 'procedure.recordCount', shape: 'breakdown' }, // status/procedureType distributions
  // Evolution
  { policyKey: 'direct_acquisition.valueAwardedSum', shape: 'series' },
  { policyKey: 'direct_acquisition.recordCount', shape: 'series' },
  { policyKey: 'direct_acquisition.valueEstimatedSum', shape: 'series' },
  {
    policyKey: 'procedure.recordCount',
    shape: 'series',
    expectBlocked: { reason: 'missing-date-basis', milestone: 'M1' },
  },
  {
    policyKey: 'procedure.valueAwardedSum',
    shape: 'series',
    expectBlocked: { reason: 'missing-date-basis', milestone: 'M1' },
  },
  // Distinct actors (key-retaining edge rollups)
  { policyKey: 'contract.distinctSuppliers', shape: 'series' },
  { policyKey: 'contract.distinctAuthorities', shape: 'series' },
  { policyKey: 'direct_acquisition.distinctSuppliers', shape: 'series' },
  { policyKey: 'direct_acquisition.distinctAuthorities', shape: 'series' },
  // Concentration (supplier-carrying grains only)
  { policyKey: 'direct_acquisition.valueAwardedSum', shape: 'concentration' },
  { policyKey: 'contract.valueAwardedSum', shape: 'concentration' },
];

describe('policy table covers the requirements matrix', () => {
  it.each(MATRIX)('$policyKey supports $shape', (row) => {
    const entry = POLICY_TABLE.find((e) => e.policyKey === row.policyKey);
    expect(entry).toBeDefined();
    expect(entry?.legalShapes).toContain(row.shape);
    if (row.expectBlocked !== undefined) {
      expect(entry?.blocked).toEqual(row.expectBlocked);
    }
  });
});

describe('structural declarations', () => {
  it('procedure grain declares NO distinct measures (procedures have no supplier)', () => {
    expect(policyFor('procedure', 'distinctSuppliers')).toBeUndefined();
    expect(policyFor('procedure', 'distinctAuthorities')).toBeUndefined();
  });

  it('estimated values never rank or concentrate — a separate labeled metric (D2)', () => {
    for (const grain of ANALYSIS_GRAINS) {
      const entry = policyFor(grain, 'valueEstimatedSum');
      expect(entry?.valueBasis).toBe('estimated');
      expect(entry?.legalShapes).not.toContain('breakdown');
      expect(entry?.legalShapes).not.toContain('concentration');
    }
  });

  it('averages are ratios of awarded sum over WITH-VALUE count, stats-only', () => {
    for (const grain of ANALYSIS_GRAINS) {
      const entry = policyFor(grain, 'avgValueAwarded');
      expect(entry?.law).toBe('ratio');
      expect(entry?.ratioOf).toEqual({
        numerator: 'valueAwardedSum',
        denominator: 'withValueCount',
      });
      expect(entry?.legalShapes).toEqual(['stats']);
    }
  });

  it('contract terminality is underivable; DA/procedure are derivable', () => {
    expect(policyFor('contract', 'valueAwardedSum')?.terminality).toBe('none');
    expect(policyFor('direct_acquisition', 'valueAwardedSum')?.terminality).toBe('derivable');
    expect(policyFor('procedure', 'valueAwardedSum')?.terminality).toBe('derivable');
  });

  it('every entry is canonical-only and keyed <grain>.<measure>', () => {
    for (const entry of POLICY_TABLE) {
      expect(entry.population).toBe('canonical-only');
      expect(entry.policyKey).toBe(`${entry.grain}.${entry.measure}`);
    }
  });

  it('non-procedure grains carry no time block', () => {
    for (const entry of POLICY_TABLE) {
      if (entry.grain !== 'procedure') expect(entry.blocked).toBeUndefined();
    }
  });

  it('distinct laws never appear on additive shapes like breakdown', () => {
    for (const entry of POLICY_TABLE) {
      if (entry.law === 'distinct') {
        expect(entry.legalShapes).toEqual(['series']);
        expect(entry.gateClass).toBe('count');
      }
    }
  });
});
