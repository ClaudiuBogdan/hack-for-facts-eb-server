/**
 * National budget — lane-local snapshot tokens and preconditions.
 *
 * Law and execution change independently, so each lane has its own token:
 * approved = digest of loaded `(edition, form, interpretation, line count)`;
 * execution = digest of the current `(period end, selection)` chain leaves. A
 * monthly bulletin load therefore never invalidates law cursors. Tokens are
 * current-state preconditions, not historical replay addresses.
 */

import { err, ok, type Result } from 'neverthrow';

import { hashCanonicalJson } from '@/common/canonical-json/index.js';
import { serviceUnavailable, type ApiError } from '@/modules/shared/index.js';

import { snapshotChanged } from './errors.js';

export type Lane = 'APPROVED' | 'EXECUTION';

export interface ApprovedInventoryKey {
  readonly editionId: string;
  readonly form: string;
  readonly interpretationId: string;
  readonly lineCount: number;
}

export interface ExecutionLeafKey {
  readonly periodEnd: string;
  readonly selectionId: string;
}

const TOKEN_HEX_LENGTH = 32;
const LANE_PREFIX: Readonly<Record<Lane, string>> = { APPROVED: 'a1', EXECUTION: 'e1' };

const digest = (
  lane: Lane,
  rows: readonly (readonly (string | number)[])[]
): Result<string, ApiError> => {
  const keyed = rows.map((row) => ({ key: JSON.stringify(row), row }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return hashCanonicalJson({ lane, v: 1, rows: keyed.map((entry) => entry.row) })
    .map((hex) => `${LANE_PREFIX[lane]}.${hex.slice(0, TOKEN_HEX_LENGTH)}`)
    .mapErr(() => serviceUnavailable(`cannot compute the ${lane.toLowerCase()} snapshot`));
};

export const approvedLaneToken = (
  rows: readonly ApprovedInventoryKey[]
): Result<string, ApiError> =>
  digest(
    'APPROVED',
    rows.map((row) => [row.editionId, row.form, row.interpretationId, row.lineCount])
  );

export const executionLaneToken = (rows: readonly ExecutionLeafKey[]): Result<string, ApiError> =>
  digest(
    'EXECUTION',
    rows.map((row) => [row.periodEnd, row.selectionId])
  );

/** Digest of immutable source IDs (pinned reads): order-insensitive, lane-scoped. */
export const pinToken = (lane: Lane, ids: readonly string[]): Result<string, ApiError> =>
  hashCanonicalJson({ lane, v: 1, pinned: [...ids].sort() })
    .map((hex) => `p1.${hex.slice(0, TOKEN_HEX_LENGTH)}`)
    .mapErr(() => serviceUnavailable('cannot compute the source pin'));

/** Apply an optional `expectedSnapshot` against the lane's current token. */
export const checkExpectedSnapshot = (
  expected: string | null,
  current: string
): Result<void, ApiError> =>
  expected === null || expected === current
    ? ok(undefined)
    : err(snapshotChanged('expectedSnapshot', current));
