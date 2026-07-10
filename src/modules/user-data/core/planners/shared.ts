import { Value } from '@sinclair/typebox/value';
import { err, ok, type Result } from 'neverthrow';

import { canonicalJsonByteLength } from '@/common/canonical-json/index.js';

import {
  createInvalidLogicalKey,
  createInvalidPayload,
  createInvalidTarget,
  createPayloadTooLarge,
  type UserDataError,
} from '../errors.js';
import { type CategoryDefinition, type CategorySchemaVersion } from '../registry/types.js';
import {
  type ActorContext,
  type CurrentRecord,
  type PlannedMutation,
  type RecordTarget,
} from '../types.js';

const MAX_DEPTH = 16;
const MAX_STRING_LENGTH = 16_384;
const MAX_COLLECTION_SIZE = 256;

export const toRecordView = (current: CurrentRecord) => ({
  recordId: current.recordId,
  category: current.identity.category,
  logicalKey: current.identity.logicalKey,
  target: current.target,
  schemaVersion: current.schemaVersion,
  revision: current.revision,
  status: current.status,
  payload: current.payload,
  annotations: current.annotations,
  createdAt: current.createdAt.toISOString(),
  updatedAt: current.updatedAt.toISOString(),
  deletedAt: current.deletedAt?.toISOString() ?? null,
});

const escapedPath = (path: string, key: string): string =>
  `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;

const collectLimitViolations = (
  value: unknown,
  path: string,
  depth: number,
  output: string[]
): void => {
  if (depth > MAX_DEPTH) {
    output.push(`${path}:maxDepth`);
    return;
  }
  if (typeof value === 'string' && value.length > MAX_STRING_LENGTH)
    output.push(`${path}:maxLength`);
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION_SIZE) output.push(`${path}:maxItems`);
    for (const [index, item] of value.entries())
      collectLimitViolations(item, `${path}/${String(index)}`, depth + 1, output);
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_COLLECTION_SIZE) output.push(`${path}:maxProperties`);
    for (const [key, item] of entries)
      collectLimitViolations(item, escapedPath(path, key), depth + 1, output);
  }
};

export const validateDocument = (
  value: Record<string, unknown>,
  schema: CategorySchemaVersion['schema'],
  maxBytes: number
): Result<void, UserDataError> => {
  const byteLength = canonicalJsonByteLength(value);
  if (byteLength.isErr()) return err(createInvalidPayload(['/:canonicalJson']));
  if (byteLength.value > maxBytes) return err(createPayloadTooLarge(maxBytes));
  const violations: string[] = [];
  collectLimitViolations(value, '', 0, violations);
  if (!Value.Check(schema, value)) {
    for (const failure of Value.Errors(schema, value))
      violations.push(`${failure.path === '' ? '/' : failure.path}:schema`);
  }
  return violations.length === 0
    ? ok(undefined)
    : err(createInvalidPayload([...new Set(violations)]));
};

export const validateLogicalKey = (
  definition: CategoryDefinition,
  logicalKey: string
): Result<void, UserDataError> => {
  if (logicalKey.length > definition.logicalKey.maxLength)
    return err(createInvalidLogicalKey('maxLength'));
  definition.logicalKey.pattern.lastIndex = 0;
  return definition.logicalKey.pattern.test(logicalKey)
    ? ok(undefined)
    : err(createInvalidLogicalKey('pattern'));
};

export const validateTarget = (
  definition: CategoryDefinition,
  target: RecordTarget | null
): Result<void, UserDataError> => {
  if (definition.target === null)
    return target === null ? ok(undefined) : err(createInvalidTarget('forbidden'));
  if (definition.target.required && target === null) return err(createInvalidTarget('required'));
  if (target === null) return ok(undefined);
  if (
    typeof target.targetType !== 'string' ||
    typeof target.targetId !== 'string' ||
    target.targetType.length === 0 ||
    target.targetId.length === 0
  )
    return err(createInvalidTarget('bothOrNeither'));
  return definition.target.allowedTypes.includes(target.targetType)
    ? ok(undefined)
    : err(createInvalidTarget('type'));
};

export const targetsEqual = (left: RecordTarget | null, right: RecordTarget | null): boolean =>
  left === null
    ? right === null
    : right !== null && left.targetType === right.targetType && left.targetId === right.targetId;

export const actorIsComplete = (actor: ActorContext): boolean =>
  actor.type !== 'admin' ||
  (typeof actor.actorId === 'string' &&
    actor.actorId.length > 0 &&
    typeof actor.reason === 'string' &&
    actor.reason.length > 0);

export const basePlan = (input: Omit<PlannedMutation, 'nextRevision'>): PlannedMutation => ({
  ...input,
  nextRevision: input.expectedRevision + 1,
});
