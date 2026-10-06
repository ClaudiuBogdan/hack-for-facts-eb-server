import { describe, expect, it } from 'vitest';

import {
  mapEdge,
  mapIndicator,
  mapMembership,
  sourcesInFamilyOrder,
} from '@/modules/public-enterprises/shell/repo/public-enterprise-repo.js';

import type {
  PublicAmepipIndicatorRow,
  PublicSourceSnapshotRow,
} from '@/modules/public-enterprises/shell/db/schema.js';

const cell = (overrides: Partial<PublicAmepipIndicatorRow>): PublicAmepipIndicatorRow => ({
  snapshot_id: 'amepip-1',
  enterprise_cui: '10020943',
  year: 2019,
  source_sheet: 'Indicatori calculati',
  version: '',
  indicator_key: 'MS',
  kpi_code: 'MS',
  indicator_name: 'Marja neta',
  measure_unit: '%',
  value_kind: 'number',
  raw_value: '0.0425',
  numeric_value: '0.0425',
  boolean_value: null,
  text_value: null,
  source_row_number: 8,
  source_evidence_key: 'ev:a1:v:ms2019',
  source_url: 'https://data.gov.ro/amepip-1.xlsx#MS2019',
  ...overrides,
});

const snapshotRow = (overrides: Partial<PublicSourceSnapshotRow>): PublicSourceSnapshotRow => ({
  snapshot_id: 'amepip-1',
  source_family: 'amepip',
  source_scope: '',
  source_url: 'https://data.gov.ro/amepip-1.xlsx',
  content_sha256: 'a'.repeat(64),
  observed_at: '2026-09-01T00:00:00.000000Z',
  source_last_modified_at: '2026-08-31T00:00:00.000000Z',
  accepted_at: '2026-09-02T00:00:00.000000Z',
  loaded_at: '2026-09-02T00:00:00.000000Z',
  raw_status: null,
  ...overrides,
});

describe('public-enterprise row mapping', () => {
  it('keeps exact decimal text, the original cell and the NULL text_value', () => {
    expect(mapIndicator(cell({}))).toMatchObject({
      id: 'amepip-1|10020943|2019|Indicatori calculati||MS',
      numericValue: '0.0425',
      rawValue: '0.0425',
      measureUnit: '%',
      valueKind: 'number',
      textValue: null,
    });
    expect(mapIndicator(cell({ raw_value: '12.50', numeric_value: '12.50' })).numericValue).toBe(
      '12.50'
    );
    const empty = mapIndicator(cell({ value_kind: 'empty', raw_value: '', numeric_value: null }));
    const missing = mapIndicator(
      cell({ value_kind: 'empty', raw_value: null, numeric_value: null })
    );
    expect(empty.rawValue).toBe('');
    expect(missing.rawValue).toBeNull();
    expect(empty.numericValue).toBeNull();
    const text = mapIndicator(
      cell({
        indicator_key: 'NOTE',
        kpi_code: null,
        measure_unit: null,
        value_kind: 'text',
        raw_value: 'in curs de numire',
        numeric_value: null,
      })
    );
    expect(text).toMatchObject({ rawValue: 'in curs de numire', textValue: null, kpiCode: null });
  });

  it('refuses an unknown value kind or family instead of passing it through', () => {
    expect(() => mapIndicator(cell({ value_kind: 'percent' }))).toThrow(/value kind/u);
    expect(() =>
      mapMembership({
        cui: '1',
        organization_cui: '1',
        current_families: ['bvb'],
        is_current_member: false,
      })
    ).toThrow(/family/u);
    expect(() =>
      mapEdge({
        control_edge_key: 'k',
        snapshot_id: 'bvb-1',
        source_family: 'bvb_owner_crosscheck',
        source_record_key: 'ATB',
        enterprise_cui: '1973096',
        authority_cui: null,
        authority_name: null,
        raw_subordination: null,
        authority_level: 'unknown',
        authority_level_method: 'bvb',
        apt_type_id: null,
        enterprise_status_raw: null,
        effective_from: null,
        effective_to: null,
        source_evidence_key: 'ev',
        source_url: null,
      })
    ).toThrow(/edge family/u);
  });

  it('keeps a historical anchor with no current family', () => {
    expect(
      mapMembership({
        cui: '44444440',
        organization_cui: '44444440',
        current_families: [],
        is_current_member: false,
      })
    ).toEqual({ cui: '44444440', currentFamilies: [], isCurrentMember: false });
  });

  it('lists every source lane in fixed order and tells an unloaded lane from a partial one', () => {
    const sources = sourcesInFamilyOrder([
      snapshotRow({ snapshot_id: 's1001-2', source_family: 's1001', raw_status: 'partial' }),
      snapshotRow({}),
    ]);
    expect(sources.map((s) => [s.family, s.laneStatus, s.snapshotId])).toEqual([
      ['amepip', 'available', 'amepip-1'],
      ['s1001', 'partial', 's1001-2'],
      ['json_apt', 'unavailable', null],
    ]);
    expect(sources[2]).toEqual({
      family: 'json_apt',
      scope: null,
      laneStatus: 'unavailable',
      snapshotId: null,
      rawStatus: null,
      sourceUrl: null,
      contentSha256: null,
      observedAt: null,
      sourceLastModifiedAt: null,
      acceptedAt: null,
      loadedAt: null,
    });
    // Dates are passed through exactly; observedAt is the capture time, not a publication date.
    expect(sources[0]).toMatchObject({
      observedAt: '2026-09-01T00:00:00.000000Z',
      sourceLastModifiedAt: '2026-08-31T00:00:00.000000Z',
      rawStatus: null,
    });
    expect(sourcesInFamilyOrder([]).map((s) => s.laneStatus)).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
  });
});
