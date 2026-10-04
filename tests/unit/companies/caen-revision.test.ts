import { describe, expect, it } from 'vitest';

import { caenActivitiesOf, mapFiscal } from '@/modules/companies/shell/repo/mappers.js';
import { REFERENCE_CLASSIFICATION_SYSTEMS } from '@/modules/reference/core/types.js';

import type { CompanyRegistryCaenObservation } from '@/modules/companies/core/registry.js';

const observation = (
  over: Partial<CompanyRegistryCaenObservation>
): CompanyRegistryCaenObservation => ({
  id: '7:OD_CAEN_AUTORIZAT:1',
  identifierKey: 'J40/1/2000',
  parseState: 'code',
  code: '6210',
  revisionState: 'known',
  revision: 'rev0',
  catalogLabel: null,
  provenance: {
    resourceKey: 'OD_CAEN_AUTORIZAT',
    sourceRowNumber: 1,
    sourceRowSha256: 'a'.repeat(64),
    sourceUrl: null,
    sourceFileSha256: null,
    sourcePublishedAt: '2026-07-08',
  },
  ...over,
});

describe('CAEN source revisions', () => {
  it('exposes unknown fiscal revision without inventing revision 2, and borrows no label', () => {
    expect(
      mapFiscal({
        is_vat_payer: null,
        is_inactive: false,
        main_caen_code: '6210',
        main_caen_rev: null,
        registered_name: null,
        status_date: null,
      })?.mainCaenRev
    ).toBeNull();
    const [anaf] = caenActivitiesOf([], {
      main_caen_code: '6210',
      main_caen_rev: '',
      // A label read for another revision must never attach to an unknown one.
      main_caen_label: 'Air transport',
    });
    expect(anaf).toEqual({
      code: '6210',
      rev: null,
      source: 'anaf',
      label: null,
      labelSource: null,
    });
  });

  it('keeps historical revision zero a distinct reference system and activity', () => {
    expect(REFERENCE_CLASSIFICATION_SYSTEMS).toContain('caen_rev0');
    const activities = caenActivitiesOf(
      [
        observation({
          catalogLabel: {
            label: 'Air transport',
            system: 'caen_rev0',
            source: 'current_db_catalog',
          },
        }),
        observation({ id: '7:OD_CAEN_AUTORIZAT:2', revision: 'rev2', catalogLabel: null }),
      ],
      undefined
    );
    expect(activities.map((a) => [a.rev, a.code, a.label, a.labelSource])).toEqual([
      ['rev0', '6210', 'Air transport', 'current_db_catalog'],
      ['rev2', '6210', null, null],
    ]);
  });

  it('lists one activity per (revision, code); unknown revisions and unparsed codes stay explicit', () => {
    const activities = caenActivitiesOf(
      [
        observation({}),
        observation({ id: '7:OD_CAEN_AUTORIZAT:2' }), // same (rev0, 6210): one activity
        observation({ id: '7:OD_CAEN_AUTORIZAT:3', revision: null, revisionState: 'missing' }),
        observation({ id: '7:OD_CAEN_AUTORIZAT:4', parseState: 'invalid', code: null }),
      ],
      undefined
    );
    expect(activities.map((a) => [a.rev, a.code])).toEqual([
      [null, '6210'],
      ['rev0', '6210'],
    ]);
  });
});
