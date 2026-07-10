import { err, ok, type Result } from 'neverthrow';

import { createValidationError, type ValidationError } from './errors.js';

/**
 * Total, deterministic canonical JSON serialization used for idempotency
 * identities (event payload hashes, normalized subscription keys).
 *
 * Guarantees:
 * - Object keys are recursively sorted, so key order never changes the output.
 * - Distinct inputs never collapse: values JSON.stringify would silently drop
 *   or coerce (undefined, bigint, function, symbol, NaN/Infinity, non-plain
 *   objects such as Date or Map) are rejected with a ValidationError instead.
 * - Cyclic structures are rejected instead of throwing.
 */
export const canonicalJsonStringify = (value: unknown): Result<string, ValidationError> => {
  return serialize(value, 'value', new Set());
};

const serialize = (
  value: unknown,
  path: string,
  seen: ReadonlySet<object>
): Result<string, ValidationError> => {
  if (value === null) {
    return ok('null');
  }

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return ok(JSON.stringify(value));
    case 'number': {
      if (!Number.isFinite(value)) {
        return err(createValidationError(`Non-finite number at ${path}`, path));
      }
      return ok(JSON.stringify(value));
    }
    case 'object':
      break;
    default:
      return err(createValidationError(`Unsupported ${typeof value} value at ${path}`, path));
  }

  const objectValue = value;
  if (seen.has(objectValue)) {
    return err(createValidationError(`Cyclic structure at ${path}`, path));
  }
  const nextSeen = new Set(seen);
  nextSeen.add(objectValue);

  if (Array.isArray(objectValue)) {
    const parts: string[] = [];
    for (const [index, item] of objectValue.entries()) {
      const itemResult = serialize(item, `${path}[${String(index)}]`, nextSeen);
      if (itemResult.isErr()) {
        return itemResult;
      }
      parts.push(itemResult.value);
    }
    return ok(`[${parts.join(',')}]`);
  }

  const prototype: unknown = Object.getPrototypeOf(objectValue);
  if (prototype !== Object.prototype && prototype !== null) {
    return err(createValidationError(`Non-plain object at ${path}`, path));
  }

  const record = objectValue as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const entryResult = serialize(record[key], `${path}.${key}`, nextSeen);
    if (entryResult.isErr()) {
      return entryResult;
    }
    parts.push(`${JSON.stringify(key)}:${entryResult.value}`);
  }
  return ok(`{${parts.join(',')}}`);
};
