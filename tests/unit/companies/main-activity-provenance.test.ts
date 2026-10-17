/**
 * Main CAEN provenance of ANAF evidence on the three public surfaces (current
 * assignment, outcome history, evidence history), policy
 * `anaf-assumed-main-caen-v1` only.
 *
 * - The retired v2 vocabulary (policy, legacy-time role basis, legacy custody
 *   tags) is no value of this reader: it fails closed, never read as v1.
 * - A withdrawn ANAF source keeps the outcome's role basis; the whole ANAF
 *   object is null and a proper withdrawal is readable, never malformed.
 * - Visible evidence without a source snapshot is exactly the no-source
 *   shape (every exposed ANAF field null), never judged from the status.
 */

import { describe, expect, it } from 'vitest';

import {
  mapAssignment,
  mapEvidenceEntry,
  mapOutcome,
} from '@/modules/companies/shell/repo/main-activity-sql.js';

const RETRIEVED = '2026-06-15T08:00:12.642832Z';

type AssignmentRow = Parameters<typeof mapAssignment>[0];
type OutcomeRow = Parameters<typeof mapOutcome>[0];
type SupportRow = Parameters<typeof mapEvidenceEntry>[0];

const assignment = (over: Partial<AssignmentRow> = {}): AssignmentRow => ({
  resolution_id: '11',
  support_id: '21',
  status: 'resolved',
  main_role_basis: 'anaf_assumed_main',
  policy_version: 'anaf-assumed-main-caen-v1',
  anaf_original_token: '610',
  anaf_json_type: 'string',
  anaf_token_form: 'other_digit_form',
  anaf_canonical_digits: '610',
  anaf_assumed_code: null,
  anaf_v3_form: 'three_digit',
  revision_basis: 'unique_onrc_match',
  match_basis: 'leading_zero_match',
  candidate_keys: ['rev2:0610'],
  resolved_revision: 'rev2',
  resolved_code: '0610',
  resolved_label: 'Extracția petrolului brut',
  correction_id: null,
  edition_id: '7',
  edition_source_published_at: '2026-07-08',
  onrc_caen_coverage: 'complete',
  fiscal_source_snapshot_id: 'anaf:2026-06-15',
  fiscal_source_hash: 'b'.repeat(64),
  fiscal_status_date: '2026-06-15',
  fiscal_retrieved_at: RETRIEVED,
  fiscal_source_url: 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva',
  fiscal_raw_capture_id: null,
  fiscal_raw_custody_id: null,
  evidence_custody: 'pointer_bound_at_derivation',
  derived_at: '2026-10-14T18:00:00.000000Z',
  evidence_at: '2026-10-14T18:00:00.000000Z',
  refreshed_at: '2026-10-14T18:00:00.000000Z',
  refresh_id: '3',
  content_epoch: '2',
  currentness: 'current',
  anaf_withdrawn: false,
  integrity_held: false,
  ...over,
});

/** What the view serves once the fiscal row is withdrawn (ANAF + interpretation suppressed). */
const WITHDRAWN = {
  currentness: 'source_withdrawn',
  anaf_withdrawn: true,
  status: null,
  revision_basis: null,
  match_basis: null,
  candidate_keys: null,
  resolved_revision: null,
  resolved_code: null,
  resolved_label: null,
  anaf_original_token: null,
  anaf_json_type: null,
  anaf_token_form: null,
  anaf_canonical_digits: null,
  anaf_v3_form: null,
  fiscal_source_snapshot_id: null,
  fiscal_source_hash: null,
  fiscal_status_date: null,
  fiscal_retrieved_at: null,
  fiscal_source_url: null,
  evidence_custody: null,
} as const;

const ONRC_UNAVAILABLE = {
  currentness: 'onrc_unavailable',
  status: null,
  revision_basis: null,
  match_basis: null,
  candidate_keys: null,
  resolved_revision: null,
  resolved_code: null,
  resolved_label: null,
  edition_id: null,
  edition_source_published_at: null,
  onrc_caen_coverage: null,
} as const;

/** What the views serve when the company has no fiscal source at all (not withdrawn). */
const NO_SOURCE = {
  fiscal_source_snapshot_id: null,
  fiscal_source_hash: null,
  fiscal_status_date: null,
  fiscal_retrieved_at: null,
  fiscal_source_url: null,
  fiscal_raw_capture_id: null,
  fiscal_raw_custody_id: null,
  evidence_custody: null,
  anaf_original_token: null,
  anaf_json_type: null,
} as const;
const NO_SOURCE_CURRENT: Partial<AssignmentRow> = {
  ...NO_SOURCE,
  anaf_token_form: null,
  anaf_canonical_digits: null,
  anaf_assumed_code: null,
  anaf_v3_form: null,
  status: 'source_missing',
  revision_basis: null,
  match_basis: null,
  candidate_keys: [],
  resolved_revision: null,
  resolved_code: null,
  resolved_label: null,
};

const current = (over: Partial<AssignmentRow>) => mapAssignment(assignment(over), 'a:w');

describe('current assignment (main_caen_current_assignments)', () => {
  it('reads v1 with its evidence as served', () => {
    const a = current({})._unsafeUnwrap();
    expect(a).toMatchObject({ policy: 'anaf-assumed-main-caen-v1', basis: 'anaf_assumed_main' });
    expect(a.anaf).toMatchObject({
      retrievedAt: RETRIEVED,
      sourceSnapshotId: 'anaf:2026-06-15',
      evidenceCustody: 'pointer_bound_at_derivation',
    });
  });

  it('ANAF withdrawal: the role basis is kept, the whole ANAF object is null', () => {
    expect(current(WITHDRAWN)._unsafeUnwrap()).toMatchObject({
      basis: 'anaf_assumed_main',
      currentness: 'source_withdrawn',
      anafWithdrawn: true,
      anaf: null,
    });
  });

  it('ANAF and ONRC withdrawal together: still readable, still suppressed', () => {
    expect(current({ ...WITHDRAWN, ...ONRC_UNAVAILABLE })._unsafeUnwrap()).toMatchObject({
      currentness: 'onrc_unavailable',
      anafWithdrawn: true,
      anaf: null,
      edition: null,
    });
  });

  it.each<[string, Partial<AssignmentRow>]>([
    ['the retired v2 policy', { policy_version: 'anaf-assumed-main-caen-v2' }],
    ['an unknown policy', { policy_version: 'anaf-assumed-main-caen-v3' }],
    ['the retired legacy-time role basis', { main_role_basis: 'anaf_assumed_main_legacy_time' }],
    ['a retired legacy custody tag', { evidence_custody: 'legacy_ms_pointer_bound' }],
    [
      'a withdrawal carrying a retired legacy custody tag',
      { ...WITHDRAWN, evidence_custody: 'legacy_ms_retained_custody' },
    ],
    ['an unknown custody', { evidence_custody: 'legacy_ms' }],
  ])('refuses %s', (_name, over) => {
    expect(current(over).isErr()).toBe(true);
  });
});

const outcome = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  resolution_id: '11',
  previous_resolution_id: null,
  refresh_id: '3',
  reasons: ['first_assignment'],
  policy_version: 'anaf-assumed-main-caen-v1',
  main_role_basis: 'anaf_assumed_main',
  status: 'resolved',
  revision_basis: 'unique_onrc_match',
  match_basis: 'leading_zero_match',
  anaf_original_token: '610',
  anaf_json_type: 'string',
  anaf_token_form: 'other_digit_form',
  anaf_canonical_digits: '610',
  anaf_assumed_code: null,
  edition_id: '7',
  candidate_keys: ['rev2:0610'],
  resolved_revision: 'rev2',
  resolved_code: '0610',
  resolved_label: 'Extracția petrolului brut',
  correction_id: null,
  derived_at: '2026-10-14T18:00:00.000000Z',
  anaf_withdrawn: false,
  onrc_withdrawn: false,
  ...over,
});

const OUTCOME_ANAF_WITHDRAWN = {
  anaf_withdrawn: true,
  status: null,
  revision_basis: null,
  match_basis: null,
  candidate_keys: null,
  resolved_revision: null,
  resolved_code: null,
  resolved_label: null,
  anaf_original_token: null,
  anaf_json_type: null,
  anaf_token_form: null,
  anaf_canonical_digits: null,
} as const;

describe('outcome history (main_caen_public_resolutions)', () => {
  it('reads v1', () => {
    expect(mapOutcome(outcome())._unsafeUnwrap()).toMatchObject({
      policy: 'anaf-assumed-main-caen-v1',
      basis: 'anaf_assumed_main',
    });
  });

  it('a withdrawn outcome keeps its basis, nothing of ANAF', () => {
    expect(mapOutcome(outcome(OUTCOME_ANAF_WITHDRAWN))._unsafeUnwrap()).toMatchObject({
      basis: 'anaf_assumed_main',
      anaf: null,
      status: null,
      anafWithdrawn: true,
    });
  });

  it('ANAF and ONRC withdrawn together stays readable', () => {
    expect(
      mapOutcome(
        outcome({ ...OUTCOME_ANAF_WITHDRAWN, onrc_withdrawn: true, edition_id: null })
      ).isOk()
    ).toBe(true);
  });

  it.each<[string, Partial<OutcomeRow>]>([
    ['the retired v2 policy', { policy_version: 'anaf-assumed-main-caen-v2' }],
    ['the retired legacy-time role basis', { main_role_basis: 'anaf_assumed_main_legacy_time' }],
  ])('refuses %s', (_name, over) => {
    expect(mapOutcome(outcome(over)).isErr()).toBe(true);
  });
});

const support = (over: Partial<SupportRow> = {}): SupportRow => ({
  support_id: '21',
  previous_support_id: null,
  resolution_id: '11',
  refresh_id: '3',
  edition_id: '7',
  fiscal_source_snapshot_id: 'anaf:2026-06-15',
  fiscal_source_hash: 'b'.repeat(64),
  fiscal_status_date: '2026-06-15',
  fiscal_retrieved_at: RETRIEVED,
  fiscal_source_url: null,
  fiscal_raw_capture_id: '901',
  fiscal_raw_custody_id: null,
  evidence_custody: 'archived_exchange',
  anaf_original_token: '610',
  anaf_json_type: 'string',
  onrc_caen_coverage: 'complete',
  evidence_at: '2026-10-14T18:00:00.000000Z',
  anaf_withdrawn: false,
  onrc_withdrawn: false,
  ...over,
});

describe('evidence history (main_caen_public_supports)', () => {
  it('reads evidence with its exact six-digit retrieval time', () => {
    expect(mapEvidenceEntry(support())._unsafeUnwrap().anaf).toMatchObject({
      retrievedAt: RETRIEVED,
      evidenceCustody: 'archived_exchange',
    });
  });

  it('a withdrawn support is readable and suppressed', () => {
    expect(
      mapEvidenceEntry(support({ ...NO_SOURCE, anaf_withdrawn: true }))._unsafeUnwrap()
    ).toMatchObject({ anaf: null, anafWithdrawn: true });
  });

  it('refuses a retired legacy custody tag', () => {
    expect(
      mapEvidenceEntry(support({ evidence_custody: 'legacy_ms_retained_custody' })).isErr()
    ).toBe(true);
  });
});

describe('current read: the exact no-source shape', () => {
  it('SOURCE_MISSING without a fiscal source: an all-null ANAF object, distinct from withdrawal', () => {
    const a = current(NO_SOURCE_CURRENT)._unsafeUnwrap();
    expect(a.anafWithdrawn).toBe(false);
    expect(a.anaf).toEqual({
      originalToken: null,
      jsonType: null,
      tokenForm: null,
      canonicalDigits: null,
      assumedCode: null,
      v3Form: null,
      statusDate: null,
      retrievedAt: null,
      sourceUrl: null,
      sourceSnapshotId: null,
      sourceHash: null,
      rawCaptureId: null,
      rawCustodyId: null,
      evidenceCustody: null,
    });
  });

  it('a reviewed correction without fiscal evidence stands (the status is never the absence test)', () => {
    const a = current({
      ...NO_SOURCE_CURRENT,
      status: 'corrected',
      revision_basis: 'reviewed_correction',
      candidate_keys: ['rev2:0610'],
      resolved_revision: 'rev2',
      resolved_code: '0610',
      resolved_label: 'Extracția petrolului brut',
      correction_id: '5',
    })._unsafeUnwrap();
    expect(a).toMatchObject({ status: 'corrected', anaf: { sourceSnapshotId: null } });
    expect(
      current({ ...NO_SOURCE_CURRENT, status: 'correction_withheld', correction_id: '6' }).isOk()
    ).toBe(true);
  });

  it('an ONRC mask over a no-source assignment (status suppressed) stays readable', () => {
    expect(current({ ...NO_SOURCE_CURRENT, ...ONRC_UNAVAILABLE }).isOk()).toBe(true);
  });

  it('a REAL fiscal row whose token is absent is also SOURCE_MISSING, with its source', () => {
    const present = {
      status: 'source_missing',
      revision_basis: null,
      match_basis: null,
      candidate_keys: [],
      resolved_revision: null,
      resolved_code: null,
      resolved_label: null,
      anaf_original_token: null,
      anaf_json_type: 'absent',
      anaf_token_form: 'absent',
      anaf_canonical_digits: null,
      anaf_v3_form: 'missing',
    };
    expect(current(present)._unsafeUnwrap().anaf).toMatchObject({
      sourceSnapshotId: 'anaf:2026-06-15',
    });
  });

  it.each<[string, Partial<AssignmentRow>]>([
    ['a source hash without a snapshot', { fiscal_source_hash: 'b'.repeat(64) }],
    ['a status date without a snapshot', { fiscal_status_date: '2026-06-15' }],
    ['a retrieval time without a snapshot', { fiscal_retrieved_at: RETRIEVED }],
    ['a raw capture id without a snapshot', { fiscal_raw_capture_id: '901' }],
    ['a custody without a snapshot', { evidence_custody: 'unbound_at_derivation' }],
    ['a token without a snapshot', { anaf_original_token: '0610', anaf_json_type: 'string' }],
    ['a token form without a snapshot', { anaf_token_form: 'absent' }],
    ['a v3 form without a snapshot', { anaf_v3_form: 'missing' }],
  ])('refuses a partial no-source shape: %s', (_name, over) => {
    expect(current({ ...NO_SOURCE_CURRENT, ...over }).isErr()).toBe(true);
  });

  it('ANAF withdrawal stays its own state: the whole object null, never the no-source object', () => {
    expect(current({ ...NO_SOURCE_CURRENT, ...WITHDRAWN })._unsafeUnwrap()).toMatchObject({
      anafWithdrawn: true,
      anaf: null,
    });
  });
});

describe('evidence history: the exact no-source shape', () => {
  it('a no-source support reads with an all-null ANAF object (not withdrawn)', () => {
    const e = mapEvidenceEntry(support(NO_SOURCE))._unsafeUnwrap();
    expect(e.anafWithdrawn).toBe(false);
    expect(e.anaf).toMatchObject({ sourceSnapshotId: null, evidenceCustody: null });
  });

  it('a no-source support under an ONRC withdrawal stays readable', () => {
    expect(
      mapEvidenceEntry(support({ ...NO_SOURCE, onrc_withdrawn: true, edition_id: null })).isOk()
    ).toBe(true);
  });

  it.each<[string, Partial<SupportRow>]>([
    ['a hash without a snapshot', { fiscal_source_hash: 'b'.repeat(64) }],
    ['a retrieval time without a snapshot', { fiscal_retrieved_at: RETRIEVED }],
    ['a custody without a snapshot', { evidence_custody: 'unbound_at_derivation' }],
    ['a token without a snapshot', { anaf_original_token: '0610', anaf_json_type: 'string' }],
  ])('refuses a partial no-source support: %s', (_name, over) => {
    expect(mapEvidenceEntry(support({ ...NO_SOURCE, ...over })).isErr()).toBe(true);
  });
});
