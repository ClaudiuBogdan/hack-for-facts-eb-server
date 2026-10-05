/**
 * National budget — snapshot-bound cursor wrapper around the kernel cursor.
 *
 * Outer envelope `{ v, lane, mode, bind, kernel }`: `bind` is the live lane
 * snapshot or the pin of immutable source IDs; `kernel` is the untouched
 * kernel cursor string (`sort`, `dir`, `keys`, `fhash`). The binding is checked
 * first, so a changed live lane is SNAPSHOT_CHANGED (restart the read) rather
 * than a generic mismatch; only then is the kernel cursor decoded against the
 * canonical filter hash and sort. Nothing is hidden in `keys`/`fhash`, and the
 * kernel cursor contract is not modified.
 */

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import {
  canonicalJsonStringify,
  decodeOpaqueJson,
  encodeOpaqueJson,
} from '@/common/canonical-json/index.js';
import {
  buildNextCursor,
  decodeCursor,
  filterHash,
  invalidInput,
  serviceUnavailable,
  type ApiError,
} from '@/modules/shared/index.js';

import { CURSOR_MISMATCH, MALFORMED_CURSOR, snapshotChanged } from './errors.js';

import type { Lane } from './snapshot.js';

export const NATIONAL_CURSOR_VERSION = 1;

export type CursorBinding =
  | { readonly mode: 'LIVE'; readonly lane: Lane; readonly snapshot: string }
  | { readonly mode: 'PINNED'; readonly lane: Lane; readonly pin: string };

export interface CursorSpec {
  readonly sort: string;
  readonly dir: 'asc' | 'desc';
  readonly keyCount: number;
}

const OuterCursorSchema = Type.Object(
  {
    v: Type.Literal(NATIONAL_CURSOR_VERSION),
    lane: Type.Union([Type.Literal('APPROVED'), Type.Literal('EXECUTION')]),
    mode: Type.Union([Type.Literal('LIVE'), Type.Literal('PINNED')]),
    bind: Type.String({ minLength: 1, maxLength: 128 }),
    kernel: Type.String({ minLength: 1, maxLength: 1536 }),
  },
  { additionalProperties: false }
);

const bindValue = (binding: CursorBinding): string =>
  binding.mode === 'LIVE' ? binding.snapshot : binding.pin;

/** Kernel `fhash` of a root's canonical validated input (page size excluded). */
export const nationalFilterHash = (root: string, query: unknown): Result<string, ApiError> =>
  canonicalJsonStringify({ root, v: NATIONAL_CURSOR_VERSION, query })
    .map(filterHash)
    .mapErr(() => serviceUnavailable(`cannot canonicalise the ${root} filters`));

export const encodeNationalCursor = (
  binding: CursorBinding,
  spec: CursorSpec,
  fhash: string,
  lastKeys: readonly (string | number)[]
): string =>
  encodeOpaqueJson({
    v: NATIONAL_CURSOR_VERSION,
    lane: binding.lane,
    mode: binding.mode,
    bind: bindValue(binding),
    kernel: buildNextCursor({ sort: spec.sort, dir: spec.dir, fhash, lastKeys }),
  });

/**
 * Decode `after` for the current binding, spec and filter hash; returns the
 * last row's sort keys (strings, as the kernel stores them).
 */
export const decodeNationalCursor = (
  raw: string,
  binding: CursorBinding,
  spec: CursorSpec,
  fhash: string
): Result<readonly string[], ApiError> => {
  const decoded = decodeOpaqueJson(raw);
  if (decoded.isErr() || !Value.Check(OuterCursorSchema, decoded.value)) {
    return err(invalidInput(MALFORMED_CURSOR, 'after'));
  }
  const outer = decoded.value;
  if (outer.lane !== binding.lane || outer.mode !== binding.mode) {
    return err(invalidInput(CURSOR_MISMATCH, 'after'));
  }
  if (outer.bind !== bindValue(binding)) {
    return binding.mode === 'LIVE'
      ? err(snapshotChanged('after', binding.snapshot))
      : err(invalidInput(CURSOR_MISMATCH, 'after'));
  }
  const kernel = decodeCursor(outer.kernel, { sort: spec.sort, dir: spec.dir, fhash });
  if (kernel.isErr()) return err(invalidInput(kernel.error.message, 'after'));
  if (kernel.value.keys.length !== spec.keyCount) {
    return err(invalidInput(MALFORMED_CURSOR, 'after'));
  }
  return ok(kernel.value.keys);
};
