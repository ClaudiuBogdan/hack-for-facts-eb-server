// node:crypto is a deliberate, documented exception to the core import
// allow-list: createHash is pure, deterministic computation with no I/O.
// See docs/NOTIFICATION-PLATFORM-MODULE-DESIGN.md §10.
import { createHash } from 'node:crypto';

import { type Result } from 'neverthrow';

import { canonicalJsonStringify } from '../shared/canonical-json.js';

import type { ValidationError } from '../shared/errors.js';

/**
 * Deterministic hash of event facts used for occurrence-key conflict
 * detection (architecture §12). Total: non-JSON-representable facts
 * (undefined, bigint, non-finite numbers, non-plain objects, cycles)
 * return a ValidationError instead of silently collapsing or throwing.
 */
export const hashEventPayload = (
  facts: Record<string, unknown>
): Result<string, ValidationError> => {
  return canonicalJsonStringify(facts).map((canonicalJson) =>
    createHash('sha256').update(canonicalJson).digest('hex')
  );
};
