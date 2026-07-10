import { type Result } from 'neverthrow';

import { canonicalJsonStringify } from '../shared/canonical-json.js';

import type { ValidationError } from '../shared/errors.js';

/**
 * Deterministic subscription identity key (architecture §12). Total:
 * non-JSON-representable config values return a ValidationError instead
 * of silently collapsing or throwing.
 */
export const buildNormalizedSubscriptionKey = (
  kindId: string,
  subjectType: string,
  subjectId: string,
  config: Record<string, unknown>
): Result<string, ValidationError> => {
  return canonicalJsonStringify(config).map(
    (canonicalConfig) => `${JSON.stringify([kindId, subjectType, subjectId])}:${canonicalConfig}`
  );
};
