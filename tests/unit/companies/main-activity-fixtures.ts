/**
 * ANAF-assumed main activity fixtures (no I/O): the core shapes the
 * repository hands to the usecases, for the binding example cases of the
 * leading-zero decision (OMV-like 610 → ONRC rev2:0610, Lidl-like 4711 in
 * rev2 and rev3 → latest rev3, Marketing-like 4730 without an ONRC match),
 * all under the published scope's edition 7.
 */

import { createHash } from 'node:crypto';

import { ok } from 'neverthrow';
import { vi } from 'vitest';

import {
  MAIN_ACTIVITY_POLICY_V1,
  mainActivityCacheKey,
  mainActivityWitness,
  type CompanyMainActivity,
  type CompanyMainActivityEvidence,
  type CompanyMainClassFlag,
} from '@/modules/companies/core/main-activity.js';

import type { CompaniesRepository } from '@/modules/companies/core/ports.js';

type ActivityFields = Omit<CompanyMainActivity, 'cacheKey'>;

/** The fixture stand-in for the whole-row digest: any field change moves it. */
export const witnessOf = (fields: ActivityFields): string =>
  `a:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;

export const mainActivity = (over: Partial<ActivityFields> = {}): CompanyMainActivity => {
  const fields: ActivityFields = {
    policy: MAIN_ACTIVITY_POLICY_V1,
    basis: 'anaf_assumed_main',
    currentness: 'current',
    anafWithdrawn: false,
    integrityHeld: false,
    status: 'resolved',
    matchBasis: 'leading_zero_match',
    revisionBasis: 'unique_onrc_match',
    resolved: {
      revision: 'rev2',
      code: '0610',
      label: 'Extracția petrolului brut',
      labelSource: 'frozen_at_derivation',
    },
    candidates: [{ revision: 'rev2', code: '0610' }],
    correctionId: null,
    anaf: {
      originalToken: '610',
      jsonType: 'string',
      tokenForm: 'other_digit_form',
      canonicalDigits: '610',
      assumedCode: null,
      v3Form: 'three_digit',
      statusDate: '2026-06-15',
      retrievedAt: '2026-06-15T08:00:00.000000Z',
      sourceUrl: 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva',
      sourceSnapshotId: 'anaf:2026-06-15',
      sourceHash: 'b'.repeat(64),
      rawCaptureId: null,
      rawCustodyId: null,
      evidenceCustody: 'pointer_bound_at_derivation',
    },
    edition: { editionId: '7', sourcePublishedAt: '2026-07-08', caenCoverage: 'complete' },
    derivedAt: '2026-10-13T22:30:00.000000Z',
    evidenceAt: '2026-10-13T22:30:00.000000Z',
    refreshedAt: '2026-10-13T22:30:00.000000Z',
    resolutionId: '11',
    supportId: '21',
    refreshId: '3',
    contentEpoch: '2',
    ...over,
  };
  return { ...fields, cacheKey: mainActivityCacheKey(witnessOf(fields)) };
};

/** OMV-like: ANAF "610" → ONRC rev2:0610 by leading zeros. */
export const OMV_ACTIVITY = mainActivity();

/** Lidl-like: 4711 in rev2 and rev3 → the latest known revision, rev3. */
export const LIDL_ACTIVITY = mainActivity({
  status: 'resolved_latest_revision',
  matchBasis: 'exact',
  revisionBasis: 'latest_matching_onrc_revision',
  resolved: {
    revision: 'rev3',
    code: '4711',
    label: 'Comerț cu amănuntul în magazine nespecializate',
    labelSource: 'frozen_at_derivation',
  },
  candidates: [
    { revision: 'rev3', code: '4711' },
    { revision: 'rev2', code: '4711' },
  ],
  anaf: {
    ...mainActivity().anaf!,
    originalToken: '4711',
    tokenForm: 'four_digit',
    canonicalDigits: '4711',
    assumedCode: '4711',
    v3Form: 'four_digit',
  },
});

/** Marketing-like: a four-digit ANAF code without an ONRC class key. */
export const NO_MATCH_ACTIVITY = mainActivity({
  status: 'no_onrc_match',
  matchBasis: null,
  revisionBasis: null,
  resolved: null,
  candidates: [],
  anaf: {
    ...mainActivity().anaf!,
    originalToken: '4730',
    tokenForm: 'four_digit',
    canonicalDigits: '4730',
    assumedCode: '4730',
    v3Form: 'four_digit',
  },
});

export const flag = (over: Partial<CompanyMainClassFlag> = {}): CompanyMainClassFlag => ({
  revision: 'rev2',
  code: '0610',
  isMainCaen: true,
  matchesAssumedMainCode: true,
  currentness: 'current',
  resolutionId: '11',
  editionId: '7',
  ...over,
});

export const OMV_FLAGS: readonly CompanyMainClassFlag[] = [
  flag(),
  flag({ code: '4711', isMainCaen: false, matchesAssumedMainCode: false }),
];

export const LIDL_FLAGS: readonly CompanyMainClassFlag[] = [
  flag({ revision: 'rev2', code: '4711', isMainCaen: false, matchesAssumedMainCode: true }),
  flag({ revision: 'rev3', code: '4711', isMainCaen: true, matchesAssumedMainCode: true }),
  flag({ revision: 'rev3', code: '6201', isMainCaen: false, matchesAssumedMainCode: false }),
];

/** The witness a fixture activity was built with (its cache key's base). */
export const witnessOfActivity = (activity: CompanyMainActivity): string =>
  activity.cacheKey.replace(/^main-v2:/u, '').replace(/:scope-.*$/u, '');

export const readOf = (
  activity: CompanyMainActivity | null,
  flags: readonly CompanyMainClassFlag[] | 'not_requested' | 'unavailable' | 'overflow' = []
): CompanyMainActivityEvidence => ({
  assignment:
    activity === null
      ? { state: 'none' }
      : { state: 'row', activity, witness: witnessOfActivity(activity) },
  flags: typeof flags === 'string' ? { state: flags } : { state: 'read', flags },
});

export const UNAVAILABLE_EVIDENCE: CompanyMainActivityEvidence = {
  assignment: { state: 'unavailable' },
  flags: { state: 'not_requested' },
};

/**
 * Repository overrides answering one main read; the witness follows the
 * latest `evidence()` unless `witnesses` scripts it (one value per call).
 */
export const mainRepoParts = (
  evidence: () => CompanyMainActivityEvidence,
  witnesses?: readonly string[]
): Pick<CompaniesRepository, 'getMainActivity' | 'readMainActivityWitness'> => {
  let call = 0;
  return {
    getMainActivity: vi.fn(async () => ok(evidence())),
    readMainActivityWitness: vi.fn(async () => {
      const scripted = witnesses?.[Math.min(call, witnesses.length - 1)];
      call += 1;
      return ok(scripted ?? mainActivityWitness(evidence()));
    }),
  };
};
