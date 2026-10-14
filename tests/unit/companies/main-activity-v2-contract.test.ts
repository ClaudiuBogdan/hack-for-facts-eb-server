/**
 * Main CAEN contract v2 (20261013T220030): the time and provenance of ANAF
 * evidence on the three public surfaces (current assignment, outcome
 * history, evidence history), read by the upgraded reader.
 *
 * - v1 rows keep their original meaning; a legacy value under v1 is refused.
 * - A legacy row (v2) states its millisecond projection coherently: the
 *   legacy custody tag, `legacy_ms_projection` and the six-digit raw time
 *   together; `retrievedAt` = the raw time's millisecond floor, unequal to it.
 *   Checked as text, never through a Date: `…642832Z` survives exactly.
 * - A withdrawn ANAF source keeps the outcome's role basis and carries none
 *   of the v2 provenance; a proper withdrawal is readable, never malformed.
 * - Unknown policy / basis / custody / time basis fail closed.
 */

import { describe, expect, it } from 'vitest';

import {
  isUtcMicrosText,
  visibleEvidenceTimeProblem,
  withdrawnEvidenceTimeProblem,
} from '@/modules/companies/core/main-activity.js';
import {
  mapAssignment,
  mapEvidenceEntry,
  mapOutcome,
} from '@/modules/companies/shell/repo/main-activity-sql.js';

const RAW = '2026-06-15T08:00:12.642832Z';
const SERVED_MS = '2026-06-15T08:00:12.642000Z';

type AssignmentRow = Parameters<typeof mapAssignment>[0];
type OutcomeRow = Parameters<typeof mapOutcome>[0];
type SupportRow = Parameters<typeof mapEvidenceEntry>[0];

const assignment = (over: Partial<AssignmentRow> = {}): AssignmentRow => ({
  resolution_id: '11',
  support_id: '21',
  status: 'resolved',
  main_role_basis: 'anaf_assumed_main',
  policy_version: 'anaf-assumed-main-caen-v2',
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
  fiscal_retrieved_at: '2026-06-15T08:00:12.642832Z',
  fiscal_source_url: 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva',
  fiscal_raw_capture_id: null,
  fiscal_raw_custody_id: null,
  evidence_custody: 'pointer_bound_at_derivation',
  fiscal_time_basis: 'native',
  fiscal_raw_retrieved_at: null,
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

/** The same company's row bound through the frozen legacy-time cohort. */
const LEGACY = {
  main_role_basis: 'anaf_assumed_main_legacy_time',
  evidence_custody: 'legacy_ms_pointer_bound',
  fiscal_time_basis: 'legacy_ms_projection',
  fiscal_retrieved_at: SERVED_MS,
  fiscal_raw_retrieved_at: RAW,
} as const;

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
  fiscal_time_basis: null,
  fiscal_raw_retrieved_at: null,
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

const HELD = {
  currentness: 'pending_refresh',
  integrity_held: true,
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
} as const;

const current = (over: Partial<AssignmentRow>) => mapAssignment(assignment(over), 'a:w');

describe('the coherence rule (pure, six-digit text)', () => {
  it('accepts only the exact canonical six-digit UTC text', () => {
    expect(isUtcMicrosText(RAW)).toBe(true);
    for (const text of [
      '2026-06-15T08:00:12.64283Z',
      '2026-06-15T08:00:12.6428320Z',
      '2026-06-15T08:00:12.642832+00:00',
      '2026-06-15 08:00:12.642832Z',
      '2026-06-15T08:00:12Z',
    ]) {
      expect(isUtcMicrosText(text)).toBe(false);
    }
  });

  it('legacy: the served time is the raw time’s millisecond floor and differs from it', () => {
    const legacy = {
      custody: 'legacy_ms_retained_custody',
      timeBasis: 'legacy_ms_projection',
      retrievedAt: SERVED_MS,
      rawRetrievedAt: RAW,
    } as const;
    expect(visibleEvidenceTimeProblem(legacy)).toBeNull();
    expect(
      visibleEvidenceTimeProblem({ ...legacy, retrievedAt: '2026-06-15T08:00:12.643000Z' })
    ).not.toBeNull();
    // A raw time already on the millisecond is not a projection of anything.
    expect(
      visibleEvidenceTimeProblem({ ...legacy, retrievedAt: SERVED_MS, rawRetrievedAt: SERVED_MS })
    ).not.toBeNull();
    // Validated before slicing: a non-canonical raw text never yields a floor.
    expect(
      visibleEvidenceTimeProblem({ ...legacy, rawRetrievedAt: '2026-06-15T08:00:12.642832+00' })
    ).not.toBeNull();
  });

  it('native: no raw time; a legacy tag needs the legacy basis and vice versa', () => {
    const native = {
      custody: 'archived_exchange',
      timeBasis: 'native',
      retrievedAt: RAW,
      rawRetrievedAt: null,
    } as const;
    expect(visibleEvidenceTimeProblem(native)).toBeNull();
    expect(visibleEvidenceTimeProblem({ ...native, rawRetrievedAt: RAW })).not.toBeNull();
    expect(
      visibleEvidenceTimeProblem({ ...native, custody: 'legacy_ms_pointer_bound' })
    ).not.toBeNull();
    expect(
      visibleEvidenceTimeProblem({
        ...native,
        timeBasis: 'legacy_ms_projection',
        retrievedAt: SERVED_MS,
        rawRetrievedAt: RAW,
      })
    ).not.toBeNull();
    expect(visibleEvidenceTimeProblem({ ...native, timeBasis: null })).not.toBeNull();
  });

  it('withdrawn: proper suppression passes; a leaked time basis, raw time or legacy tag does not', () => {
    const none = {
      custody: null,
      timeBasis: null,
      retrievedAt: null,
      rawRetrievedAt: null,
    } as const;
    expect(withdrawnEvidenceTimeProblem(none)).toBeNull();
    expect(withdrawnEvidenceTimeProblem({ ...none, timeBasis: 'native' })).not.toBeNull();
    expect(withdrawnEvidenceTimeProblem({ ...none, rawRetrievedAt: RAW })).not.toBeNull();
    expect(
      withdrawnEvidenceTimeProblem({ ...none, custody: 'legacy_ms_pointer_bound' })
    ).not.toBeNull();
  });
});

describe('current assignment (main_caen_current_assignments)', () => {
  it('v1 native keeps its original meaning', () => {
    const a = current({ policy_version: 'anaf-assumed-main-caen-v1' })._unsafeUnwrap();
    expect(a).toMatchObject({ policy: 'anaf-assumed-main-caen-v1', basis: 'anaf_assumed_main' });
    expect(a.anaf).toMatchObject({ timeBasis: 'native', rawRetrievedAt: null, retrievedAt: RAW });
  });

  it('v2 native', () => {
    const a = current({})._unsafeUnwrap();
    expect(a.policy).toBe('anaf-assumed-main-caen-v2');
    expect(a.anaf).toMatchObject({ timeBasis: 'native', rawRetrievedAt: null });
  });

  it.each(['legacy_ms_pointer_bound', 'legacy_ms_retained_custody'] as const)(
    'v2 legacy (%s): basis, tag and the exact six-digit raw time, never re-rendered',
    (tag) => {
      const a = current({ ...LEGACY, evidence_custody: tag })._unsafeUnwrap();
      expect(a.basis).toBe('anaf_assumed_main_legacy_time');
      expect(a.anaf).toMatchObject({
        evidenceCustody: tag,
        timeBasis: 'legacy_ms_projection',
        retrievedAt: SERVED_MS,
        rawRetrievedAt: '2026-06-15T08:00:12.642832Z',
      });
      expect(a.anaf?.rawRetrievedAt?.endsWith('642832Z')).toBe(true);
    }
  );

  it('a legacy row suppressed by its generation is readable as pending (the view decides; no flag downstream)', () => {
    const a = current({ ...LEGACY, currentness: 'pending_refresh' })._unsafeUnwrap();
    expect(a).toMatchObject({
      currentness: 'pending_refresh',
      basis: 'anaf_assumed_main_legacy_time',
    });
  });

  it('ANAF withdrawal of a legacy outcome: the role basis is kept, every ANAF field is null', () => {
    const a = current({ ...LEGACY, ...WITHDRAWN })._unsafeUnwrap();
    expect(a).toMatchObject({
      basis: 'anaf_assumed_main_legacy_time',
      currentness: 'source_withdrawn',
      anafWithdrawn: true,
      anaf: null,
    });
  });

  it('ANAF and ONRC withdrawal together: still readable, still suppressed', () => {
    const a = current({ ...LEGACY, ...WITHDRAWN, ...ONRC_UNAVAILABLE })._unsafeUnwrap();
    expect(a).toMatchObject({
      currentness: 'onrc_unavailable',
      anafWithdrawn: true,
      anaf: null,
      edition: null,
    });
  });

  it('ONRC withdrawal alone keeps the legacy evidence', () => {
    const a = current({ ...LEGACY, ...ONRC_UNAVAILABLE })._unsafeUnwrap();
    expect(a.anaf).toMatchObject({ timeBasis: 'legacy_ms_projection', rawRetrievedAt: RAW });
  });

  it('an integrity hold of a legacy source keeps its (coherent) provenance and no token', () => {
    const a = current({ ...LEGACY, ...HELD })._unsafeUnwrap();
    expect(a).toMatchObject({ integrityHeld: true, status: null });
    expect(a.anaf).toMatchObject({
      originalToken: null,
      timeBasis: 'legacy_ms_projection',
      rawRetrievedAt: RAW,
    });
  });

  it.each<[string, Partial<AssignmentRow>]>([
    ['an unknown policy', { policy_version: 'anaf-assumed-main-caen-v3' }],
    ['a legacy basis under v1', { ...LEGACY, policy_version: 'anaf-assumed-main-caen-v1' }],
    [
      'a legacy tag under v1',
      {
        evidence_custody: 'legacy_ms_pointer_bound',
        fiscal_time_basis: 'legacy_ms_projection',
        fiscal_retrieved_at: SERVED_MS,
        fiscal_raw_retrieved_at: RAW,
        policy_version: 'anaf-assumed-main-caen-v1',
      },
    ],
    [
      'a legacy time basis under v1 (native custody)',
      {
        policy_version: 'anaf-assumed-main-caen-v1',
        fiscal_time_basis: 'legacy_ms_projection',
        fiscal_retrieved_at: SERVED_MS,
        fiscal_raw_retrieved_at: RAW,
      },
    ],
    ['a legacy basis with native evidence', { main_role_basis: 'anaf_assumed_main_legacy_time' }],
    ['a native basis with legacy evidence', { ...LEGACY, main_role_basis: 'anaf_assumed_main' }],
    ['a legacy tag without its raw time', { ...LEGACY, fiscal_raw_retrieved_at: null }],
    ['a legacy tag with the native time basis', { ...LEGACY, fiscal_time_basis: 'native' }],
    ['a raw time on native evidence', { fiscal_raw_retrieved_at: RAW }],
    [
      'a served time that is not the floor',
      { ...LEGACY, fiscal_retrieved_at: '2026-06-15T08:00:12.641000Z' },
    ],
    ['a served time equal to the raw time', { ...LEGACY, fiscal_retrieved_at: RAW }],
    [
      'a non-canonical raw time',
      { ...LEGACY, fiscal_raw_retrieved_at: '2026-06-15T08:00:12.64283Z' },
    ],
    ['an unknown time basis', { fiscal_time_basis: 'legacy' }],
    ['an unknown custody', { evidence_custody: 'legacy_ms' }],
    ['no time basis on visible evidence', { fiscal_time_basis: null }],
    [
      'a withdrawal that leaks the time basis',
      { ...LEGACY, ...WITHDRAWN, fiscal_time_basis: 'legacy_ms_projection' },
    ],
    [
      'a withdrawal that leaks the raw time',
      { ...LEGACY, ...WITHDRAWN, fiscal_raw_retrieved_at: RAW },
    ],
    [
      'a withdrawal that leaks a legacy tag',
      { ...LEGACY, ...WITHDRAWN, evidence_custody: 'legacy_ms_retained_custody' },
    ],
  ])('refuses %s', (_name, over) => {
    expect(current(over).isErr()).toBe(true);
  });
});

const outcome = (over: Partial<OutcomeRow> = {}): OutcomeRow => ({
  resolution_id: '11',
  previous_resolution_id: null,
  refresh_id: '3',
  reasons: ['first_assignment'],
  policy_version: 'anaf-assumed-main-caen-v2',
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
  it('v1 history stays readable with its original meaning', () => {
    expect(
      mapOutcome(outcome({ policy_version: 'anaf-assumed-main-caen-v1' }))._unsafeUnwrap()
    ).toMatchObject({
      policy: 'anaf-assumed-main-caen-v1',
      basis: 'anaf_assumed_main',
    });
  });

  it('a v2 legacy outcome', () => {
    expect(
      mapOutcome(outcome({ main_role_basis: 'anaf_assumed_main_legacy_time' }))._unsafeUnwrap()
        .basis
    ).toBe('anaf_assumed_main_legacy_time');
  });

  it('a withdrawn legacy outcome keeps its basis, nothing of ANAF', () => {
    expect(
      mapOutcome(
        outcome({ main_role_basis: 'anaf_assumed_main_legacy_time', ...OUTCOME_ANAF_WITHDRAWN })
      )._unsafeUnwrap()
    ).toMatchObject({
      basis: 'anaf_assumed_main_legacy_time',
      anaf: null,
      status: null,
      anafWithdrawn: true,
    });
  });

  it('ANAF and ONRC withdrawn together stays readable', () => {
    expect(
      mapOutcome(
        outcome({
          main_role_basis: 'anaf_assumed_main_legacy_time',
          ...OUTCOME_ANAF_WITHDRAWN,
          onrc_withdrawn: true,
          edition_id: null,
        })
      ).isOk()
    ).toBe(true);
  });

  it.each<[string, Partial<OutcomeRow>]>([
    ['an unknown policy', { policy_version: 'anaf-assumed-main-caen-v3' }],
    [
      'a legacy basis under v1',
      {
        policy_version: 'anaf-assumed-main-caen-v1',
        main_role_basis: 'anaf_assumed_main_legacy_time',
      },
    ],
    ['an unknown basis', { main_role_basis: 'anaf_assumed_main_legacy' }],
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
  fiscal_retrieved_at: RAW,
  fiscal_source_url: null,
  fiscal_raw_capture_id: '901',
  fiscal_raw_custody_id: null,
  evidence_custody: 'archived_exchange',
  fiscal_time_basis: 'native',
  fiscal_raw_retrieved_at: null,
  anaf_original_token: '610',
  anaf_json_type: 'string',
  onrc_caen_coverage: 'complete',
  evidence_at: '2026-10-14T18:00:00.000000Z',
  anaf_withdrawn: false,
  onrc_withdrawn: false,
  ...over,
});

const SUPPORT_LEGACY = {
  fiscal_raw_capture_id: null,
  evidence_custody: 'legacy_ms_retained_custody',
  fiscal_raw_custody_id: '77',
  fiscal_time_basis: 'legacy_ms_projection',
  fiscal_retrieved_at: SERVED_MS,
  fiscal_raw_retrieved_at: RAW,
} as const;

const SUPPORT_ANAF_WITHDRAWN = {
  anaf_withdrawn: true,
  fiscal_source_snapshot_id: null,
  fiscal_source_hash: null,
  fiscal_status_date: null,
  fiscal_retrieved_at: null,
  fiscal_source_url: null,
  fiscal_raw_capture_id: null,
  fiscal_raw_custody_id: null,
  evidence_custody: null,
  fiscal_time_basis: null,
  fiscal_raw_retrieved_at: null,
  anaf_original_token: null,
  anaf_json_type: null,
} as const;

describe('evidence history (main_caen_public_supports)', () => {
  it('native evidence', () => {
    expect(mapEvidenceEntry(support())._unsafeUnwrap().anaf).toMatchObject({
      timeBasis: 'native',
      rawRetrievedAt: null,
      retrievedAt: RAW,
    });
  });

  it('legacy evidence keeps the exact six-digit raw time', () => {
    expect(mapEvidenceEntry(support(SUPPORT_LEGACY))._unsafeUnwrap().anaf).toMatchObject({
      evidenceCustody: 'legacy_ms_retained_custody',
      timeBasis: 'legacy_ms_projection',
      retrievedAt: SERVED_MS,
      rawRetrievedAt: '2026-06-15T08:00:12.642832Z',
    });
  });

  it('a withdrawn legacy support is readable and suppressed', () => {
    expect(
      mapEvidenceEntry(support({ ...SUPPORT_LEGACY, ...SUPPORT_ANAF_WITHDRAWN }))._unsafeUnwrap()
    ).toMatchObject({
      anaf: null,
      anafWithdrawn: true,
    });
  });

  it('an ONRC-withdrawn legacy support keeps its ANAF evidence', () => {
    const e = mapEvidenceEntry(
      support({ ...SUPPORT_LEGACY, onrc_withdrawn: true, edition_id: null })
    )._unsafeUnwrap();
    expect(e).toMatchObject({ onrcWithdrawn: true, anaf: { rawRetrievedAt: RAW } });
  });

  it.each<[string, Partial<SupportRow>]>([
    ['an unknown custody tag', { evidence_custody: 'legacy_ms_unknown' }],
    ['a legacy tag without its basis', { ...SUPPORT_LEGACY, fiscal_time_basis: 'native' }],
    [
      'a legacy basis on native custody',
      {
        fiscal_time_basis: 'legacy_ms_projection',
        fiscal_retrieved_at: SERVED_MS,
        fiscal_raw_retrieved_at: RAW,
      },
    ],
    [
      'a projection that is not the floor',
      { ...SUPPORT_LEGACY, fiscal_retrieved_at: '2026-06-15T08:00:12.000000Z' },
    ],
    [
      'a withdrawal leaking the raw time',
      { ...SUPPORT_LEGACY, ...SUPPORT_ANAF_WITHDRAWN, fiscal_raw_retrieved_at: RAW },
    ],
    [
      'a withdrawal leaking a legacy tag',
      { ...SUPPORT_LEGACY, ...SUPPORT_ANAF_WITHDRAWN, evidence_custody: 'legacy_ms_pointer_bound' },
    ],
  ])('refuses %s', (_name, over) => {
    expect(mapEvidenceEntry(support(over)).isErr()).toBe(true);
  });
});

// ── turn 11: the exact no-source shape (null time basis), never judged from the status ──

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
  fiscal_time_basis: null,
  fiscal_raw_retrieved_at: null,
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

describe('current read: the exact no-source shape', () => {
  it('SOURCE_MISSING without a fiscal source: an all-null ANAF object (distinct from withdrawal), null time basis', () => {
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
      timeBasis: null,
      rawRetrievedAt: null,
      sourceUrl: null,
      sourceSnapshotId: null,
      sourceHash: null,
      rawCaptureId: null,
      rawCustodyId: null,
      evidenceCustody: null,
    });
  });

  it('v1 no-source rows read the same way', () => {
    expect(
      current({ ...NO_SOURCE_CURRENT, policy_version: 'anaf-assumed-main-caen-v1' }).isOk()
    ).toBe(true);
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
    expect(a).toMatchObject({
      status: 'corrected',
      anaf: { timeBasis: null, sourceSnapshotId: null },
    });
    const withheld = current({
      ...NO_SOURCE_CURRENT,
      status: 'correction_withheld',
      correction_id: '6',
    });
    expect(withheld.isOk()).toBe(true);
  });

  it('an ONRC mask over a no-source assignment (status suppressed) stays readable', () => {
    expect(current({ ...NO_SOURCE_CURRENT, ...ONRC_UNAVAILABLE }).isOk()).toBe(true);
  });

  it('a REAL fiscal row whose token is absent is also SOURCE_MISSING, and keeps its stated time basis', () => {
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
      timeBasis: 'native',
    });
    // A source without a stated time basis is not the no-source shape.
    expect(current({ ...present, fiscal_time_basis: null }).isErr()).toBe(true);
  });

  it.each<[string, Partial<AssignmentRow>]>([
    [
      'the native category where there is no source (the current view must emit null)',
      { fiscal_time_basis: 'native' },
    ],
    ['a source hash without a snapshot', { fiscal_source_hash: 'b'.repeat(64) }],
    ['a status date without a snapshot', { fiscal_status_date: '2026-06-15' }],
    ['a retrieval time without a snapshot', { fiscal_retrieved_at: '2026-06-15T08:00:12.642832Z' }],
    ['a raw capture id without a snapshot', { fiscal_raw_capture_id: '901' }],
    ['a custody without a snapshot', { evidence_custody: 'unbound_at_derivation' }],
    [
      'a legacy tag without a snapshot',
      {
        evidence_custody: 'legacy_ms_pointer_bound',
        main_role_basis: 'anaf_assumed_main_legacy_time',
      },
    ],
    ['a raw time without a snapshot', { fiscal_raw_retrieved_at: '2026-06-15T08:00:12.642832Z' }],
    ['a token without a snapshot', { anaf_original_token: '0610', anaf_json_type: 'string' }],
    ['a token form without a snapshot', { anaf_token_form: 'absent' }],
    ['a v3 form without a snapshot', { anaf_v3_form: 'missing' }],
    [
      'a legacy role basis on absent evidence',
      { main_role_basis: 'anaf_assumed_main_legacy_time' },
    ],
  ])('refuses a partial no-source shape: %s', (_name, over) => {
    expect(current({ ...NO_SOURCE_CURRENT, ...over }).isErr()).toBe(true);
  });

  it('ANAF withdrawal stays its own state: the whole object null, never the no-source object', () => {
    const a = current({
      ...NO_SOURCE_CURRENT,
      ...WITHDRAWN,
      fiscal_source_snapshot_id: null,
    })._unsafeUnwrap();
    expect(a).toMatchObject({ anafWithdrawn: true, anaf: null });
  });
});

describe('evidence history: the exact no-source shape', () => {
  const absent = { ...NO_SOURCE, fiscal_raw_capture_id: null };

  it('a no-source support reads with an all-null ANAF object and a null time basis (not withdrawn)', () => {
    const e = mapEvidenceEntry(support(absent))._unsafeUnwrap();
    expect(e.anafWithdrawn).toBe(false);
    expect(e.anaf).toMatchObject({
      sourceSnapshotId: null,
      timeBasis: null,
      rawRetrievedAt: null,
      evidenceCustody: null,
    });
  });

  it('a no-source support under an ONRC withdrawal stays readable', () => {
    expect(
      mapEvidenceEntry(support({ ...absent, onrc_withdrawn: true, edition_id: null })).isOk()
    ).toBe(true);
  });

  it('a support with a source must state its time basis', () => {
    expect(mapEvidenceEntry(support({ fiscal_time_basis: null })).isErr()).toBe(true);
  });

  it.each<[string, Partial<SupportRow>]>([
    ['the native category without a source', { fiscal_time_basis: 'native' }],
    ['a hash without a snapshot', { fiscal_source_hash: 'b'.repeat(64) }],
    ['a retrieval time without a snapshot', { fiscal_retrieved_at: RAW }],
    ['a custody without a snapshot', { evidence_custody: 'unbound_at_derivation' }],
    ['a legacy tag without a snapshot', { evidence_custody: 'legacy_ms_retained_custody' }],
    ['a raw time without a snapshot', { fiscal_raw_retrieved_at: RAW }],
    ['a token without a snapshot', { anaf_original_token: '0610', anaf_json_type: 'string' }],
  ])('refuses a partial no-source support: %s', (_name, over) => {
    expect(mapEvidenceEntry(support({ ...absent, ...over })).isErr()).toBe(true);
  });
});
