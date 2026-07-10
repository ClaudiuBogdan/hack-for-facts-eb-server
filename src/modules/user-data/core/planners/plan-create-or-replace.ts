import { err, ok, type Result } from 'neverthrow';

import {
  createInvalidTarget,
  createNotFound,
  createRecordDeleted,
  createRevisionConflict,
  createSchemaVersionWriteDisabled,
  type UserDataError,
} from '../errors.js';
import {
  basePlan,
  targetsEqual,
  toRecordView,
  validateDocument,
  validateLogicalKey,
  validateTarget,
} from './shared.js';
import { type ResolvedCategory } from '../registry/types.js';
import {
  type CurrentRecord,
  type PlanContext,
  type PlannedMutation,
  type ReplaceCommand,
} from '../types.js';

export const planCreateOrReplace = (
  entry: ResolvedCategory,
  current: CurrentRecord | null,
  cmd: ReplaceCommand,
  ctx: PlanContext
): Result<PlannedMutation, UserDataError> => {
  const key = validateLogicalKey(entry.definition, cmd.identity.logicalKey);
  if (key.isErr()) return err(key.error);
  if (!entry.schemaVersion.writeEnabled)
    return err(
      createSchemaVersionWriteDisabled(entry.definition.category, entry.schemaVersion.version)
    );
  const payload = validateDocument(
    cmd.payload,
    entry.schemaVersion.schema,
    entry.definition.maxPayloadBytes
  );
  if (payload.isErr()) return err(payload.error);
  const target = validateTarget(entry.definition, cmd.target);
  if (target.isErr()) return err(target.error);
  if (current === null) {
    if (cmd.expectedRevision !== 0)
      return err(createNotFound(cmd.identity.category, cmd.identity.logicalKey));
    return ok(
      basePlan({
        operation: 'create',
        scope: 'payload',
        annotationNamespace: null,
        identity: cmd.identity,
        recordId: ctx.ids.newId(),
        eventId: ctx.ids.newId(),
        target: cmd.target,
        expectedRevision: 0,
        afterImage: {
          status: 'active',
          payload: cmd.payload,
          annotations: null,
          schemaVersion: entry.schemaVersion.version,
          schemaHash: entry.schemaVersion.schemaHash,
        },
        actor: ctx.actor,
        clientOccurredAt: cmd.clientOccurredAt,
        receipt: cmd.receipt,
        quota: { maxRecordsInCategory: entry.definition.maxRecordsPerOwner },
      })
    );
  }
  if (current.status === 'deleted') return err(createRecordDeleted(toRecordView(current)));
  if (cmd.expectedRevision !== current.revision)
    return err(createRevisionConflict(toRecordView(current)));
  if (!targetsEqual(current.target, cmd.target)) return err(createInvalidTarget('immutable'));
  return ok(
    basePlan({
      operation: 'replace',
      scope: 'payload',
      annotationNamespace: null,
      identity: cmd.identity,
      recordId: current.recordId,
      eventId: ctx.ids.newId(),
      target: current.target,
      expectedRevision: cmd.expectedRevision,
      afterImage: {
        status: 'active',
        payload: cmd.payload,
        annotations: current.annotations,
        schemaVersion: entry.schemaVersion.version,
        schemaHash: entry.schemaVersion.schemaHash,
      },
      actor: ctx.actor,
      clientOccurredAt: cmd.clientOccurredAt,
      receipt: cmd.receipt,
      quota: null,
    })
  );
};
