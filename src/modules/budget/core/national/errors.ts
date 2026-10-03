/**
 * National budget — error refinements over the kernel `ApiError` union.
 *
 * A changed live lane is still `InvalidInput` (the contract's error code), with
 * a machine-readable `reason` and the lane's current snapshot so the client can
 * restart. It is a structural subtype, so the kernel union is unchanged; the
 * GraphQL/MCP adapters surface `reason`/`currentSnapshot` as extensions.
 */

import { invalidInput, type ApiError, type InvalidInputError } from '@/modules/shared/index.js';

export const SNAPSHOT_CHANGED = 'SNAPSHOT_CHANGED';

export interface SnapshotChangedError extends InvalidInputError {
  readonly reason: typeof SNAPSHOT_CHANGED;
  readonly currentSnapshot: string;
}

export const snapshotChanged = (field: string, currentSnapshot: string): SnapshotChangedError => ({
  ...invalidInput('snapshot changed; restart the read', field),
  reason: SNAPSHOT_CHANGED,
  currentSnapshot,
});

export const isSnapshotChanged = (error: ApiError): error is SnapshotChangedError =>
  error.type === 'InvalidInput' &&
  'reason' in error &&
  error.reason === SNAPSHOT_CHANGED &&
  'currentSnapshot' in error &&
  typeof error.currentSnapshot === 'string';

export const MALFORMED_CURSOR = 'malformed cursor; restart pagination';
export const CURSOR_MISMATCH = 'cursor/filter mismatch; restart pagination';
