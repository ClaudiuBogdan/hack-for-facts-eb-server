/**
 * Procurement row→view-model mappers (no live DB). Pins the value-model
 * resolution mapping (valueState / valueAccepted / comparable), the currency
 * sanitizer, CPV-division derivation, status coercion, and deltaPct.
 */

import { describe, expect, it } from 'vitest';

import {
  mapContract,
  mapDirectAcquisition,
  mapModification,
  mapProcedure,
} from '@/modules/procurement/shell/repo/mappers.js';

const baseContract = {
  contract_id: '1',
  contract_key: 'k',
  source_system: 'seap_contracts',
  source_url: null,
  procedure_id: null,
  notice_no: null,
  contract_no: null,
  contract_date: '2024-05-01',
  title: 't',
  authority_cui: '4305857',
  authority_name: 'A',
  supplier_cui: '123',
  supplier_name: 'S',
  cpv_code: '45230000',
  value_ron: '1000.00',
  estimated_value_ron: null,
  currency: null,
  status: 'awarded',
  county_name: 'CJ',
  is_canonical: true,
  dup_group_id: null,
  value_state: 'official_exact',
  value_state_detail: { rule: 'own_value' },
  value_ron_comparable: '1000.00',
  value_comparable_basis: 'official',
  value_rules_version: 2,
  value_resolved_at: '2026-07-18T00:00:00+00:00',
  canonical_value_source: 'seap_own',
  value_disagreement: false,
};

describe('value-model resolution mapping', () => {
  it('maps an accepted row: state, rule, comparable, basis, accepted=true', () => {
    const c = mapContract(baseContract);
    expect(c.value.valueState).toBe('official_exact');
    expect(c.value.valueStateRule).toBe('own_value');
    expect(c.value.valueAccepted).toBe(true);
    expect(c.value.valueRonComparable).toBe('1000.00');
    expect(c.value.valueComparableBasis).toBe('official');
    expect(c.value.valueRulesVersion).toBe(2);
    expect(c.canonicalValueSource).toBe('seap_own');
    expect(c.valueDisagreement).toBe(false);
  });
  it('non-accepted states derive accepted=false', () => {
    for (const state of [
      'source_missing',
      'invalid_source_value',
      'foreign_currency_only',
      'ambiguous_grain',
      'conflicting_sources',
      'not_applicable',
    ]) {
      const c = mapContract({
        ...baseContract,
        value_state: state,
        value_ron_comparable: null,
        value_comparable_basis: null,
      });
      expect(c.value.valueState).toBe(state);
      expect(c.value.valueAccepted).toBe(false);
    }
  });
  it('a derived_bnr comparable maps with accepted=false (foreign row)', () => {
    const c = mapContract({
      ...baseContract,
      value_state: 'foreign_currency_only',
      value_ron_comparable: '994.00',
      value_comparable_basis: 'derived_bnr',
    });
    expect(c.value.valueAccepted).toBe(false);
    expect(c.value.valueRonComparable).toBe('994.00');
    expect(c.value.valueComparableBasis).toBe('derived_bnr');
  });
  it('an unresolved row (NULL state) reads as unresolved, not accepted', () => {
    const c = mapContract({
      ...baseContract,
      value_state: null,
      value_state_detail: null,
      value_ron_comparable: null,
      value_comparable_basis: null,
      value_rules_version: null,
      value_resolved_at: null,
    });
    expect(c.value.valueState).toBeNull();
    expect(c.value.valueStateRule).toBeNull();
    expect(c.value.valueAccepted).toBe(false);
  });
  it('an UNKNOWN future state token degrades to null state (fail-safe)', () => {
    const c = mapContract({ ...baseContract, value_state: 'future_state_v3' });
    expect(c.value.valueState).toBeNull();
    expect(c.value.valueAccepted).toBe(false);
  });
});

describe('currency sanitizer (clean enum post-Phase-F; residue degrades to null)', () => {
  it('null currency stays null (RON-implied)', () => {
    expect(mapContract({ ...baseContract, currency: null }).currency).toBeNull();
  });
  it('uppercases a clean token', () => {
    expect(mapContract({ ...baseContract, currency: 'ron' }).currency).toBe('RON');
    expect(mapContract({ ...baseContract, currency: 'EUR' }).currency).toBe('EUR');
  });
  it('degrades a pre-Phase-F residue token to null', () => {
    expect(mapContract({ ...baseContract, currency: '44113620-7' }).currency).toBeNull();
    expect(mapContract({ ...baseContract, currency: 'EURO' }).currency).toBeNull();
  });
});

describe('sourceSystem / sourceUrl passthrough', () => {
  it('carries the source columns onto the view model', () => {
    const c = mapContract({
      ...baseContract,
      source_system: 'elicitatie_ca_award',
      source_url: 'https://x/y',
    });
    expect(c.sourceSystem).toBe('elicitatie_ca_award');
    expect(c.sourceUrl).toBe('https://x/y');
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
      da_id: '1',
      da_key: 'k',
      source_system: 'elicitatie_da',
      source_url: null,
      unique_code: null,
      title: null,
      authority_cui: null,
      authority_name: null,
      supplier_cui: null,
      supplier_name: null,
      cpv_code: null,
      currency: null,
      value_ron: null,
      estimated_value_ron: null,
      status: 'finalized',
      county_name: null,
      publication_date: null,
      finalization_date: '2024-01-01',
      is_canonical: true,
      dup_group_id: null,
      value_state: 'source_missing',
      value_state_detail: { rule: 'no_value' },
      value_ron_comparable: null,
      value_comparable_basis: null,
      value_rules_version: 2,
      value_resolved_at: null,
    });
    expect(da.sourceSystem).toBe('elicitatie_da');
    expect(da.status).toBe('finalized');
  });
});

describe('modification deltaPct (PC-8)', () => {
  const base = {
    modification_id: '1',
    contract_id: '9',
    source_url: null,
    link_method: 'notice_no',
    link_confidence: 0.9,
    authority_cui: null,
    supplier_cui: null,
    contract_no: null,
    notice_no: null,
    modification_date: '2024-01-01',
    value_before_ron: '100.00',
    value_after_ron: '150.00',
    value_delta_ron: '50.00',
    modification_type: null,
    year: 2024,
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

describe('procedure value-model mapping', () => {
  const base = {
    procedure_id: '1',
    source_system: 'seap_notice',
    source_url: null,
    notice_no: null,
    notice_kind: null,
    procedure_type: null,
    contract_kind: null,
    title: null,
    authority_cui: null,
    authority_name: null,
    cpv_code: '30000000',
    estimated_value_ron: '500.00',
    awarded_value_ron: null,
    currency: null,
    status: 'awarded',
    county_name: null,
    publication_date: '2024-01-01',
    state_date: null,
    value_state: 'official_exact',
    value_state_detail: { rule: 'own_value' },
    value_ron_comparable: '500.00',
    value_comparable_basis: 'official',
    value_rules_version: 2,
    value_resolved_at: null,
  };
  it('maps the resolution block onto the procedure model', () => {
    const p = mapProcedure(base);
    expect(p.value.valueState).toBe('official_exact');
    expect(p.value.valueAccepted).toBe(true);
    expect(p.value.valueRonComparable).toBe('500.00');
  });
});
