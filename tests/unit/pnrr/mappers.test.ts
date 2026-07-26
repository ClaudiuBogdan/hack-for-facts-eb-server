import { describe, expect, it } from 'vitest';

import {
  mapAcquisition,
  mapContractor,
  publicOrganizationIdentity,
} from '@/modules/pnrr/shell/repo/mappers.js';

describe('PNRR procurement value safety', () => {
  const acquisition = {
    acquisition_key: 'a-1',
    announcement_key: null,
    beneficiary_cui: '123',
    beneficiary_name: 'Beneficiary',
    procedure_type: null,
    signed_at: null,
    full_contract_value: '100.00',
    currency: 'RON',
    award_criterion: null,
    framework_agreement: null,
    has_association_leader: null,
    has_third_party_support: null,
    has_subcontractor: null,
    retrieved_at: null,
    contractor_count: '1',
  };

  const contractor = {
    contractor_key: 'ct-1',
    acquisition_key: 'a-1',
    role: 'new_source_role',
    contractor_cui: '456',
    contractor_name: 'Contractor',
    contractor_country: 'RO',
    contract_value: '100.00',
    currency: 'RON',
    confidence: null,
    validation_status: null,
  };

  it('abstains from values in collection mappings', () => {
    expect(mapAcquisition(acquisition)).toMatchObject({
      fullContractValue: null,
      valueAggregationState: 'unavailable',
    });
    expect(mapContractor(contractor)).toMatchObject({
      role: 'unknown',
      sourceRole: 'new_source_role',
      contractValue: null,
      valueAggregationState: 'unavailable',
    });
  });

  it('retains source-reported unresolved values only when explicitly requested', () => {
    expect(mapAcquisition(acquisition, true)).toMatchObject({
      fullContractValue: '100.00',
      valueAggregationState: 'reported_unresolved',
    });
    expect(mapContractor(contractor)).toMatchObject({
      contractValue: null,
      valueAggregationState: 'unavailable',
    });
  });

  it.each(['12345678901', '123456789012', '1234567890123'])(
    'suppresses a CNP-shaped %s identifier and its associated name',
    (identifier) => {
      expect(publicOrganizationIdentity(identifier, 'Personal name')).toEqual({
        cui: null,
        name: null,
      });
      expect(
        mapAcquisition({
          ...acquisition,
          beneficiary_cui: identifier,
          beneficiary_name: 'Personal name',
        })
      ).toMatchObject({ beneficiaryCui: null, beneficiaryName: null });
      expect(
        mapContractor({
          ...contractor,
          contractor_cui: identifier,
          contractor_name: 'Personal name',
        })
      ).toMatchObject({ contractorCui: null, contractorName: null });
    }
  );
});
