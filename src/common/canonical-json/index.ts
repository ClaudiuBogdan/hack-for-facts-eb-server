import { createHash } from 'node:crypto';

import { err, fromThrowable, ok, type Result } from 'neverthrow';

export interface CanonicalJsonError {
  type: 'ValidationError';
  message: string;
  field?: string;
}

const createValidationError = (message: string, field?: string): CanonicalJsonError => ({
  type: 'ValidationError',
  message,
  ...(field === undefined ? {} : { field }),
});

const parseJson = fromThrowable(JSON.parse, () => createValidationError('Invalid JSON'));

/** Total, deterministic canonical JSON serialization. */
export const canonicalJsonStringify = (value: unknown): Result<string, CanonicalJsonError> =>
  serialize(value, 'value', new Set());

const serialize = (
  value: unknown,
  path: string,
  seen: ReadonlySet<object>
): Result<string, CanonicalJsonError> => {
  if (value === null) return ok('null');

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return ok(JSON.stringify(value));
    case 'number':
      return Number.isFinite(value)
        ? ok(JSON.stringify(value))
        : err(createValidationError(`Non-finite number at ${path}`, path));
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
      if (itemResult.isErr()) return itemResult;
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
    if (entryResult.isErr()) return entryResult;
    parts.push(`${JSON.stringify(key)}:${entryResult.value}`);
  }
  return ok(`{${parts.join(',')}}`);
};

export const hashCanonicalJson = (value: unknown): Result<string, CanonicalJsonError> =>
  canonicalJsonStringify(value).map((canonical) =>
    createHash('sha256').update(canonical).digest('hex')
  );

export const hashSchema = hashCanonicalJson;

export const canonicalJsonByteLength = (value: unknown): Result<number, CanonicalJsonError> =>
  canonicalJsonStringify(value).map((canonical) => Buffer.byteLength(canonical, 'utf8'));

export const encodeOpaqueJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

export const decodeOpaqueJson = (raw: string): Result<unknown, CanonicalJsonError> => {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return err(createValidationError('Invalid base64url'));
  return parseJson(Buffer.from(raw, 'base64url').toString('utf8'));
};
