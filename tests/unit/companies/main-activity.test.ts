/**
 * The ANAF-assumed main activity, pure core: the scope gate (ONRC fields
 * only under a published scope, `current` only in the pinned edition), the
 * class-flag attachment (ONRC CLASS rows of the pinned edition only, while
 * current; SHORT_TOKEN and the ANAF row never; the view and the selected key
 * must agree), the witness and the cache key (content epoch alone is not
 * enough), and the history cursor and gate.
 */

import { describe, expect, it } from 'vitest';

import {
  MAIN_ACTIVITY_NO_ASSIGNMENT_REASON,
  MAIN_ACTIVITY_UNAVAILABLE_REASON,
  attachMainFlags,
  decodeHistoryCursor,
  encodeHistoryCursor,
  gateEvidenceEntry,
  gateMainActivity,
  gateOutcome,
  mainActivityCacheKey,
  mainActivityWitness,
  parseCandidateKeys,
  publicMainToken,
  type CompanyMainActivityEvidenceEntry,
  type CompanyMainActivityOutcome,
} from '@/modules/companies/core/main-activity.js';

import {
  LIDL_ACTIVITY,
  LIDL_FLAGS,
  NO_MATCH_ACTIVITY,
  OMV_ACTIVITY,
  OMV_FLAGS,
  flag,
  UNAVAILABLE_EVIDENCE,
  mainActivity,
  readOf,
} from './main-activity-fixtures.js';
import {
  NEXT_EDITION_SCOPE,
  PUBLISHED_SCOPE,
  UNAVAILABLE_SCOPE,
  UNPUBLISHED_SCOPE,
  WITHDRAWN_SCOPE,
} from './registry-fixtures.js';

import type { CompanyCaenActivity } from '@/modules/companies/core/types.js';

const onrc = (rev: string | null, code: string, classState = 'class'): CompanyCaenActivity => ({
  code,
  rev,
  source: 'onrc',
  classState: classState as CompanyCaenActivity['classState'],
  label: classState === 'class' ? `label ${code}` : null,
  labelSource: classState === 'class' ? 'current_db_catalog' : null,
});
const anafRow = (code: string): CompanyCaenActivity => ({
  code,
  rev: null,
  source: 'anaf',
  classState: null,
  label: null,
  labelSource: null,
});

const flagsOf = (
  rows: readonly { isMainCaen: boolean | null; matchesAssumedMainCode: boolean | null }[]
) => rows.map((r) => [r.isMainCaen, r.matchesAssumedMainCode]);

describe('gateMainActivity', () => {
  it('serves the view state as is under the published scope of the same edition', () => {
    const read = gateMainActivity(readOf(OMV_ACTIVITY), PUBLISHED_SCOPE);
    expect(read).toEqual({ availability: 'assigned', reason: null, activity: OMV_ACTIVITY });
  });

  it('states no assignment and unavailable as states, never as "no main activity"', () => {
    expect(gateMainActivity(readOf(null), PUBLISHED_SCOPE)).toEqual({
      availability: 'no_assignment',
      reason: MAIN_ACTIVITY_NO_ASSIGNMENT_REASON,
      activity: null,
    });
    expect(gateMainActivity(UNAVAILABLE_EVIDENCE, PUBLISHED_SCOPE)).toEqual({
      availability: 'unavailable',
      reason: MAIN_ACTIVITY_UNAVAILABLE_REASON,
      activity: null,
    });
  });

  it.each([
    ['unpublished', UNPUBLISHED_SCOPE],
    ['withdrawn', WITHDRAWN_SCOPE],
    ['unavailable', UNAVAILABLE_SCOPE],
  ])(
    'a %s registry scope suppresses every ONRC-derived field and keeps the ANAF evidence',
    (_state, scope) => {
      const activity = gateMainActivity(readOf(OMV_ACTIVITY), scope).activity;
      expect(activity).toMatchObject({
        currentness: 'onrc_unavailable',
        status: null,
        matchBasis: null,
        revisionBasis: null,
        resolved: null,
        candidates: null,
        correctionId: null,
        edition: null,
        anaf: OMV_ACTIVITY.anaf,
      });
      // The cache identity moves with the gated state.
      expect(activity?.cacheKey).not.toBe(OMV_ACTIVITY.cacheKey);
    }
  );

  it('keeps source_withdrawn under a non-published scope (both parts suppressed)', () => {
    const withdrawn = mainActivity({
      currentness: 'source_withdrawn',
      status: null,
      matchBasis: null,
      revisionBasis: null,
      resolved: null,
      candidates: null,
      anaf: null,
    });
    const activity = gateMainActivity(readOf(withdrawn), UNPUBLISHED_SCOPE).activity;
    expect(activity).toMatchObject({ currentness: 'source_withdrawn', anaf: null, edition: null });
  });

  it('accepts a withheld interpretation under PENDING_REFRESH as a non-current assignment without a key', () => {
    const withheld = mainActivity({
      currentness: 'pending_refresh',
      status: null,
      matchBasis: null,
      revisionBasis: null,
      resolved: null,
      candidates: null,
    });
    const read = gateMainActivity(readOf(withheld, OMV_FLAGS), PUBLISHED_SCOPE);
    expect(read.activity).toMatchObject({
      currentness: 'pending_refresh',
      status: null,
      resolved: null,
    });
    expect(
      attachMainFlags([onrc('rev2', '0610')], read, OMV_FLAGS, PUBLISHED_SCOPE).map(
        (r) => r.isMainCaen
      )
    ).toEqual([null]);
  });

  it('never calls an assignment of another edition current in this pinned edition', () => {
    const activity = gateMainActivity(readOf(OMV_ACTIVITY), NEXT_EDITION_SCOPE).activity;
    expect(activity?.currentness).toBe('pending_refresh');
    expect(activity?.resolved).toEqual(OMV_ACTIVITY.resolved);
    expect(activity?.cacheKey).toMatch(/:scope-pending_refresh$/u);
  });
});

describe('attachMainFlags', () => {
  it('OMV-like: ANAF 610 badges ONRC rev2:0610 only; the short token and the ANAF row never', () => {
    const rows = [
      onrc('rev2', '0610'),
      onrc('rev2', '0610', 'short_token'),
      onrc('rev2', '4711'),
      anafRow('610'),
    ];
    const read = gateMainActivity(readOf(OMV_ACTIVITY, OMV_FLAGS), PUBLISHED_SCOPE);
    expect(flagsOf(attachMainFlags(rows, read, OMV_FLAGS, PUBLISHED_SCOPE))).toEqual([
      [true, true],
      [null, null],
      [false, false],
      [null, null],
    ]);
  });

  it('Lidl-like: the latest known revision is main; the older revision matches the code only', () => {
    const rows = [onrc('rev2', '4711'), onrc('rev3', '4711'), onrc('rev3', '6201')];
    const read = gateMainActivity(readOf(LIDL_ACTIVITY, LIDL_FLAGS), PUBLISHED_SCOPE);
    expect(flagsOf(attachMainFlags(rows, read, LIDL_FLAGS, PUBLISHED_SCOPE))).toEqual([
      [false, true],
      [true, true],
      [false, false],
    ]);
  });

  it('a no-match code badges nothing as main', () => {
    const flags = [flag({ code: '4711', isMainCaen: false, matchesAssumedMainCode: false })];
    const read = gateMainActivity(readOf(NO_MATCH_ACTIVITY, flags), PUBLISHED_SCOPE);
    expect(flagsOf(attachMainFlags([onrc('rev2', '4711')], read, flags, PUBLISHED_SCOPE))).toEqual([
      [false, false],
    ]);
  });

  it.each([
    ['pending_refresh', mainActivity({ currentness: 'pending_refresh' })],
    [
      'source_withdrawn',
      mainActivity({
        currentness: 'source_withdrawn',
        status: null,
        resolved: null,
        candidates: null,
        matchBasis: null,
        revisionBasis: null,
        anaf: null,
      }),
    ],
  ])('no flag while the assignment is %s', (_state, activity) => {
    const read = gateMainActivity(readOf(activity, OMV_FLAGS), PUBLISHED_SCOPE);
    expect(
      flagsOf(attachMainFlags([onrc('rev2', '0610')], read, OMV_FLAGS, PUBLISHED_SCOPE))
    ).toEqual([[null, null]]);
  });

  it('no flag under another edition, a non-published scope, no assignment or unavailable', () => {
    const rows = [onrc('rev2', '0610')];
    for (const [read, scope] of [
      [gateMainActivity(readOf(OMV_ACTIVITY), NEXT_EDITION_SCOPE), NEXT_EDITION_SCOPE],
      [gateMainActivity(readOf(OMV_ACTIVITY), UNPUBLISHED_SCOPE), UNPUBLISHED_SCOPE],
      [gateMainActivity(readOf(null), PUBLISHED_SCOPE), PUBLISHED_SCOPE],
      [gateMainActivity(UNAVAILABLE_EVIDENCE, PUBLISHED_SCOPE), PUBLISHED_SCOPE],
    ] as const) {
      expect(flagsOf(attachMainFlags(rows, read, OMV_FLAGS, scope))).toEqual([[null, null]]);
    }
  });

  it('ignores flag rows of another resolution or edition, and unlisted class rows stay unknown', () => {
    const read = gateMainActivity(readOf(OMV_ACTIVITY), PUBLISHED_SCOPE);
    const stale = [flag({ resolutionId: '10' }), flag({ code: '4711', editionId: '6' })];
    expect(
      flagsOf(
        attachMainFlags([onrc('rev2', '0610'), onrc('rev2', '4711')], read, stale, PUBLISHED_SCOPE)
      )
    ).toEqual([
      [null, null],
      [null, null],
    ]);
  });

  it('a view flag that disagrees with the selected key is unknown, never true', () => {
    const read = gateMainActivity(readOf(OMV_ACTIVITY), PUBLISHED_SCOPE);
    const wrong = [flag({ code: '4711', isMainCaen: true }), flag({ isMainCaen: false })];
    expect(
      flagsOf(
        attachMainFlags([onrc('rev2', '4711'), onrc('rev2', '0610')], read, wrong, PUBLISHED_SCOPE)
      ).map(([main]) => main)
    ).toEqual([null, null]);
  });
});

describe('witness and cache key', () => {
  it('the witness tracks outcome, evidence, currentness, epoch, refresh and edition', () => {
    const base = mainActivityWitness(readOf(OMV_ACTIVITY));
    for (const over of [
      { resolutionId: '12' },
      { supportId: '22' },
      { currentness: 'pending_refresh' as const },
      { contentEpoch: '3' },
      { refreshId: '4' },
      { edition: { editionId: '8', sourcePublishedAt: null, caenCoverage: null } },
    ]) {
      expect(mainActivityWitness(readOf(mainActivity(over)))).not.toBe(base);
    }
    expect(mainActivityWitness(readOf(null))).toBe('none');
    expect(mainActivityWitness(UNAVAILABLE_EVIDENCE)).toBe('unavailable');
  });

  it('a fiscal withdrawal masked by ONRC_UNAVAILABLE moves the witness and the cache key (ids, epoch and currentness unchanged)', () => {
    const before = mainActivity({
      currentness: 'onrc_unavailable',
      status: null,
      matchBasis: null,
      revisionBasis: null,
      resolved: null,
      candidates: null,
      edition: null,
    });
    const after = mainActivity({
      currentness: 'onrc_unavailable',
      status: null,
      matchBasis: null,
      revisionBasis: null,
      resolved: null,
      candidates: null,
      edition: null,
      anafWithdrawn: true,
      anaf: null,
    });
    expect(after.resolutionId).toBe(before.resolutionId);
    expect(after.currentness).toBe(before.currentness);
    expect(mainActivityWitness(readOf(after))).not.toBe(mainActivityWitness(readOf(before)));
    expect(after.cacheKey).not.toBe(before.cacheKey);
  });

  it('flag availability never moves the witness (partial capability is not a movement)', () => {
    for (const flags of ['unavailable', 'overflow', 'not_requested'] as const) {
      expect(mainActivityWitness(readOf(OMV_ACTIVITY, flags))).toBe(
        mainActivityWitness(readOf(OMV_ACTIVITY, OMV_FLAGS))
      );
    }
  });

  it('an evidence-only change keeps the content epoch but moves the cache key', () => {
    const evidenceOnly = mainActivity({ supportId: '22' });
    expect(evidenceOnly.contentEpoch).toBe(OMV_ACTIVITY.contentEpoch);
    expect(evidenceOnly.cacheKey).not.toBe(OMV_ACTIVITY.cacheKey);
    expect(mainActivityCacheKey('a:x', 'scope-pending_refresh')).not.toBe(
      mainActivityCacheKey('a:x')
    );
  });
});

describe('publicMainToken (API defense mirroring main_caen_public_token)', () => {
  it.each([
    ['string', '610'],
    ['string', '0610'],
    ['string', '000610'],
    ['string', '9999'],
    ['string', '0000'],
    ['string', ' 4711 '],
    ['number', '610'],
    ['string', '00000000000000000000000000004711'],
  ])('serves the economic digit form %s %j as published', (jsonType, token) => {
    expect(publicMainToken(jsonType, token)).toBe(token);
  });

  it.each([
    ['string', 'private@example.com'],
    ['string', '+40 721 234 567'],
    ['string', '0721234567'],
    ['number', '40721234567'],
    ['object', '{"email":"private@example.com"}'],
    ['array', '["0610"]'],
    ['string', '٠٦١٠'],
    ['string', '-610'],
    ['string', '61.0'],
    ['string', '6e2'],
    ['boolean', 'true'],
    ['string', '000000000000000000000000000000004711'],
    ['string', ''],
    [null, '610'],
  ])('never serves %s %j', (jsonType, token) => {
    expect(publicMainToken(jsonType, token)).toBeNull();
  });
});

describe('candidate keys', () => {
  it('parses the view form latest first and refuses any malformed key', () => {
    expect(parseCandidateKeys(['rev3:4711', 'rev2:4711'])).toEqual([
      { revision: 'rev3', code: '4711' },
      { revision: 'rev2', code: '4711' },
    ]);
    for (const bad of [
      'rev4:4711',
      'rev3:471',
      'rev3:４７１１',
      '4711',
      'rev3:4711:x',
      ' rev3:4711',
    ]) {
      expect(parseCandidateKeys([bad])).toBeNull();
    }
  });
});

describe('history cursor and gate', () => {
  it('round-trips and is bound to the CUI and the kind', () => {
    const cursor = encodeHistoryCursor('2816464', 'outcomes', '41');
    expect(decodeHistoryCursor(cursor, '2816464', 'outcomes')).toBe('41');
    expect(decodeHistoryCursor(cursor, '2816465', 'outcomes')).toBeNull();
    expect(decodeHistoryCursor(cursor, '2816464', 'evidence')).toBeNull();
    for (const bad of ['', 'not base64!', encodeHistoryCursor('2816464', 'outcomes', '0')]) {
      expect(decodeHistoryCursor(bad, '2816464', 'outcomes')).toBeNull();
    }
    const tooBig = Buffer.from('mh1:outcomes:2816464:99999999999999999999', 'utf8').toString(
      'base64url'
    );
    expect(decodeHistoryCursor(tooBig, '2816464', 'outcomes')).toBeNull();
  });

  const outcome: CompanyMainActivityOutcome = {
    resolutionId: '11',
    previousResolutionId: null,
    refreshId: '3',
    reasons: ['first_assignment'],
    policy: 'anaf-assumed-main-caen-v1',
    basis: 'anaf_assumed_main',
    status: 'resolved',
    revisionBasis: 'unique_onrc_match',
    matchBasis: 'leading_zero_match',
    anaf: {
      originalToken: '610',
      jsonType: 'string',
      tokenForm: 'other_digit_form',
      canonicalDigits: '610',
      assumedCode: null,
    },
    editionId: '7',
    candidates: [{ revision: 'rev2', code: '0610' }],
    resolved: OMV_ACTIVITY.resolved,
    correctionId: null,
    derivedAt: '2026-10-13T22:30:00.000000Z',
    anafWithdrawn: false,
    onrcWithdrawn: false,
  };
  const entry: CompanyMainActivityEvidenceEntry = {
    supportId: '21',
    previousSupportId: null,
    resolutionId: '11',
    refreshId: '3',
    editionId: '7',
    anaf: null,
    caenCoverage: 'complete',
    evidenceAt: '2026-10-13T22:30:00.000000Z',
    anafWithdrawn: true,
    onrcWithdrawn: false,
  };

  it('suppresses ONRC-derived history fields without a published scope', () => {
    expect(gateOutcome(outcome, PUBLISHED_SCOPE)).toBe(outcome);
    expect(gateOutcome(outcome, WITHDRAWN_SCOPE)).toMatchObject({
      status: null,
      resolved: null,
      candidates: null,
      editionId: null,
      onrcWithdrawn: true,
      anaf: outcome.anaf,
    });
    expect(gateEvidenceEntry(entry, UNPUBLISHED_SCOPE)).toMatchObject({
      editionId: null,
      caenCoverage: null,
      onrcWithdrawn: true,
    });
  });
});
