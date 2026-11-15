/**
 * PNRR module — scoped MIPE release recognition (PNRR-V4Y1, DDL 20261114T180000/180100).
 *
 * A scoped release is recognized by its ledger lanes alone: any of
 * `mipe_projects`, `mipe_indicators`, `ords_payments_capture`. It is served
 * only with exactly those three, both MIPE lanes servable at one source date,
 * the ORDS lane an abstained zero-row receipt (`ords-payment-snapshot:<id>`)
 * with its own capture time, the serving views present and its project
 * generation written. Otherwise it is withheld, never legacy. Pure: no I/O.
 */

import type { PnrrRelease } from '../../core/types.js';

export const MIPE_PROJECTS_LANE = 'mipe_projects';
export const MIPE_INDICATORS_LANE = 'mipe_indicators';
const ORDS_PAYMENTS_LANE = 'ords_payments_capture';
const SCOPED_LANES: readonly string[] = [
  MIPE_PROJECTS_LANE,
  MIPE_INDICATORS_LANE,
  ORDS_PAYMENTS_LANE,
];
const ORDS_RECEIPT_EPOCH = /^ords-payment-snapshot:[1-9][0-9]*$/u;

export interface ActiveReleaseRow {
  readonly release_id: string;
  readonly source_run_id: string;
  readonly release_kind: 'operational_snapshot' | 'backfill' | 'corrective';
  readonly source_snapshot_at: string | null;
  readonly activated_at: string | null;
  readonly warnings: unknown;
}

export interface LedgerLaneRow {
  readonly lane: string;
  readonly capability_state: 'served' | 'degraded' | 'abstained';
  readonly as_of: string | null;
  readonly suspended: boolean;
  readonly warnings: unknown;
  readonly lane_epoch: string | null;
  /** `row_count::text`. */
  readonly row_count: string | null;
}

export interface ScopedServingFacts {
  readonly servingViewsPresent: boolean;
  readonly projectGenerationPresent: boolean;
}

export type ScopedReleaseBinding =
  | { readonly kind: 'mipe'; readonly releaseId: string; readonly release: PnrrRelease }
  | { readonly kind: 'withheld'; readonly releaseId: string; readonly release: PnrrRelease };

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export const hasScopedLane = (lanes: readonly LedgerLaneRow[]): boolean =>
  lanes.some((lane) => SCOPED_LANES.includes(lane.lane));

const mipeServable = (lane: LedgerLaneRow | undefined): lane is LedgerLaneRow =>
  lane !== undefined &&
  lane.capability_state !== 'abstained' &&
  !lane.suspended &&
  (lane.lane_epoch ?? '').trim() !== '' &&
  lane.as_of !== null;

/** Receipt metadata only: abstained, no rows, an accepted capture epoch and its own time. */
const ordsReceipt = (lane: LedgerLaneRow | undefined): boolean =>
  lane?.capability_state === 'abstained' &&
  lane.row_count === '0' &&
  ORDS_RECEIPT_EPOCH.test(lane.lane_epoch ?? '') &&
  lane.as_of !== null;

/** Why a scoped release cannot be served, in a stable order; empty when servable. */
export const scopedReleaseRefusals = (
  lanes: readonly LedgerLaneRow[],
  facts: ScopedServingFacts
): readonly string[] => {
  const names = lanes.map((lane) => lane.lane);
  const byLane = new Map(lanes.map((lane) => [lane.lane, lane]));
  const projects = byLane.get(MIPE_PROJECTS_LANE);
  const indicators = byLane.get(MIPE_INDICATORS_LANE);
  const reasons: string[] = [];
  if (names.length !== SCOPED_LANES.length || !SCOPED_LANES.every((lane) => byLane.has(lane))) {
    reasons.push('scoped_release_manifest_incomplete');
  }
  if (!mipeServable(projects) || !mipeServable(indicators)) {
    reasons.push('scoped_mipe_lane_not_servable');
  } else if (projects.as_of !== indicators.as_of) {
    reasons.push('scoped_mipe_source_dates_differ');
  }
  if (!ordsReceipt(byLane.get(ORDS_PAYMENTS_LANE))) reasons.push('scoped_ords_receipt_invalid');
  if (!facts.servingViewsPresent) reasons.push('scoped_release_views_missing');
  if (!facts.projectGenerationPresent) reasons.push('scoped_project_generation_missing');
  return reasons;
};

export const bindScopedMipeRelease = (
  active: ActiveReleaseRow,
  lanes: readonly LedgerLaneRow[],
  facts: ScopedServingFacts
): ScopedReleaseBinding => {
  const refusals = scopedReleaseRefusals(lanes, facts);
  const laneFreshness = lanes.map((lane) => {
    const withheld = lane.lane === ORDS_PAYMENTS_LANE;
    const reasonCodes = [
      ...stringArray(lane.warnings),
      ...(lane.suspended ? ['refresh_suspended'] : []),
      ...(withheld ? ['ords_payment_amounts_withheld'] : []),
    ];
    return {
      lane: lane.lane,
      state: withheld
        ? ('abstained' as const)
        : lane.suspended && lane.capability_state === 'served'
          ? ('degraded' as const)
          : lane.capability_state,
      asOf: lane.as_of,
      suspended: lane.suspended,
      reasonCodes: [...new Set(reasonCodes)],
    };
  });
  const release = {
    releaseId: active.release_id,
    releaseKind: active.release_kind,
    sourceSnapshotAt: active.source_snapshot_at,
    completedAt: active.activated_at,
  };
  if (refusals.length > 0) {
    return {
      kind: 'withheld',
      releaseId: active.release_id,
      release: {
        ...release,
        state: 'abstained',
        lanes: [
          {
            lane: 'release-manifest',
            state: 'abstained',
            asOf: active.source_snapshot_at,
            suspended: true,
            reasonCodes: refusals,
          },
          ...laneFreshness,
        ],
        limitation:
          'The active scoped MIPE release is incomplete or not servable; PNRR facts are withheld.',
      },
    };
  }
  return {
    kind: 'mipe',
    releaseId: active.release_id,
    release: {
      ...release,
      // The ORDS lane is a receipt with withheld amounts: never fully served.
      state: 'degraded',
      lanes: laneFreshness,
      limitation:
        'Scoped MIPE release: publisher-reported MIPE projects and national indicators at the MIPE source date. The ORDS capture date is shown separately; ORDS payment amounts, payment counts and commitments are withheld.',
    },
  };
};
