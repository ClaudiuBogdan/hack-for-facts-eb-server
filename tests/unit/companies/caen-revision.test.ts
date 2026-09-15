import { describe, expect, it } from 'vitest';

import { mapCaen, mapFiscal } from '@/modules/companies/shell/repo/mappers.js';
import { REFERENCE_CLASSIFICATION_SYSTEMS } from '@/modules/reference/core/types.js';

describe('CAEN source revisions', () => {
  it('exposes unknown fiscal revision without inventing revision 2', () => {
    expect(
      mapFiscal({
        is_vat_payer: null,
        is_inactive: false,
        main_caen_code: '6210',
        main_caen_rev: null,
        registered_name: null,
        snapshot_at: null,
      })?.mainCaenRev
    ).toBeNull();
    expect(
      mapCaen({ caen_code: '6210', caen_rev: '', source: 'anaf', label: null }).rev
    ).toBeNull();
  });
  it('keeps historical revision zero a distinct reference system', () => {
    expect(REFERENCE_CLASSIFICATION_SYSTEMS).toContain('caen_rev0');
    expect(
      mapCaen({ caen_code: '6210', caen_rev: 'rev0', source: 'onrc', label: 'Air transport' }).rev
    ).toBe('rev0');
  });
});
