/**
 * Procurement row→view-model mappers (no live DB). Pins the currency→{isRon,
 * valueSuspect} boundary (audit F1/F7), CPV-division derivation, status coercion,
 * and deltaPct. The currency invariant is verified live: `value_ron NOT NULL` ⟹
 * currency ∈ {null,'',RON}.
 */

import { describe, expect, it } from 'vitest';

import {
  mapContract,
  mapDirectAcquisition,
  mapModification,
  mapProcedure,
} from '@/modules/procurement/shell/repo/mappers.js';

const baseContract = {
  contract_id: '1', contract_key: 'k', procedure_id: null, notice_no: null, contract_no: null,
  contract_date: '2024-05-01', title: 't', authority_cui: '4305857', authority_name: 'A',
  supplier_cui: '123', supplier_name: 'S', cpv_code: '45230000', value_ron: '1000.00',
  estimated_value_ron: null, currency: null, status: 'awarded', county_name: 'CJ',
  is_canonical: true, dup_group_id: null,
};

describe('currency → {isRon, valueSuspect} boundary (F1/F7)', () => {
  it('null/empty currency with a value → RON, not suspect', () => {
    const c = mapContract({ ...baseContract, currency: null, value_ron: '1000.00' });
    expect(c.isRon).toBe(true);
    expect(c.valueSuspect).toBe(false);
  });
  it("explicit 'RON' → RON, not suspect", () => {
    const c = mapContract({ ...baseContract, currency: 'RON', value_ron: '1000.00' });
    expect(c.isRon).toBe(true);
    expect(c.valueSuspect).toBe(false);
  });
  it('non-RON currency + nulled value_ron → not RON, suspect', () => {
    const c = mapContract({ ...baseContract, currency: 'EUR', value_ron: null });
    expect(c.isRon).toBe(false);
    expect(c.valueSuspect).toBe(true);
    expect(c.valueRon).toBeNull();
  });
  it('a garbage currency token + nulled value_ron → suspect', () => {
    const c = mapContract({ ...baseContract, currency: '44113620-7', value_ron: null });
    expect(c.isRon).toBe(false);
    expect(c.valueSuspect).toBe(true);
  });
  it('RON-ish currency but missing value → RON, NOT suspect (just value-absent)', () => {
    const c = mapContract({ ...baseContract, currency: 'RON', value_ron: null });
    expect(c.isRon).toBe(true);
    expect(c.valueSuspect).toBe(false);
  });
  it('never exposes the raw currency token', () => {
    const c = mapContract({ ...baseContract, currency: 'EUR', value_ron: null }) as unknown as Record<string, unknown>;
    expect('currency' in c).toBe(false);
  });
});

describe('cpvDivisionCode derivation', () => {
  it('takes the first 2 digits of the 8-digit cpv_code', () => {
    expect(mapContract({ ...baseContract, cpv_code: '45230000' }).cpvDivisionCode).toBe('45');
  });
  it('null cpv_code → null division', () => {
    expect(mapContract({ ...baseContract, cpv_code: null }).cpvDivisionCode).toBeNull();
  });
});

describe('status coercion (unknown live token → closed-enum fallback)', () => {
  it('keeps a known status', () => {
    expect(mapContract({ ...baseContract, status: 'cancelled' }).status).toBe('cancelled');
  });
  it('coerces an unknown status to unknown', () => {
    expect(mapContract({ ...baseContract, status: 'something_new' }).status).toBe('unknown');
  });
  it('DA source_system coercion', () => {
    const da = mapDirectAcquisition({
      da_id: '1', da_key: 'k', source_system: 'elicitatie_da', unique_code: null, title: null,
      authority_cui: null, authority_name: null, supplier_cui: null, supplier_name: null,
      cpv_code: null, currency: null, value_ron: null, estimated_value_ron: null,
      status: 'finalized', county_name: null, publication_date: null, finalization_date: '2024-01-01',
      is_canonical: true, dup_group_id: null,
    });
    expect(da.sourceSystem).toBe('elicitatie_da');
    expect(da.status).toBe('finalized');
  });
});

describe('modification deltaPct (PC-8)', () => {
  const base = {
    modification_id: '1', contract_id: '9', link_method: 'notice_no', link_confidence: 0.9,
    authority_cui: null, supplier_cui: null, contract_no: null, notice_no: null,
    modification_date: '2024-01-01', value_before_ron: '100.00', value_after_ron: '150.00',
    value_delta_ron: '50.00', modification_type: null, year: 2024,
  };
  it('computes delta / before', () => {
    expect(mapModification(base).deltaPct).toBeCloseTo(0.5, 5);
  });
  it('null when before is 0 (no fabricated infinity)', () => {
    expect(mapModification({ ...base, value_before_ron: '0' }).deltaPct).toBeNull();
  });
  it('null when before or delta is null', () => {
    expect(mapModification({ ...base, value_before_ron: null }).deltaPct).toBeNull();
    expect(mapModification({ ...base, value_delta_ron: null }).deltaPct).toBeNull();
  });
  it('coerces an unknown link_method to null', () => {
    expect(mapModification({ ...base, link_method: 'mystery' }).linkMethod).toBeNull();
  });
});

describe('procedure currency flag uses awarded ?? estimated value', () => {
  const base = {
    procedure_id: '1', notice_no: null, notice_kind: null, procedure_type: null, contract_kind: null,
    title: null, authority_cui: null, authority_name: null, cpv_code: '30000000',
    estimated_value_ron: '500.00', awarded_value_ron: null, currency: null, status: 'awarded',
    county_name: null, publication_date: '2024-01-01', state_date: null,
  };
  it('estimated present, RON → not suspect', () => {
    const p = mapProcedure(base);
    expect(p.isRon).toBe(true);
    expect(p.valueSuspect).toBe(false);
  });
});
