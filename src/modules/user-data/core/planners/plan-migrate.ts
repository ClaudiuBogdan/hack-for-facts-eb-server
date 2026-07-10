import { err, ok, type Result } from 'neverthrow';

import {
  createActorNotAllowed,
  createRecordDeleted,
  createRevisionConflict,
  type UserDataError,
} from '../errors.js';
import { basePlan, toRecordView, validateDocument } from './shared.js';
import { type ResolvedCategory } from '../registry/types.js';
import {
  type CurrentRecord,
  type MigrateCommand,
  type PlanContext,
  type PlannedMutation,
} from '../types.js';

export const planMigrate = (
  entry: ResolvedCategory,
  current: CurrentRecord,
  cmd: MigrateCommand,
  ctx: PlanContext
): Result<PlannedMutation, UserDataError> => {
  if (ctx.actor.type !== 'system')
    return err(createActorNotAllowed('schema-migration', ctx.actor.type));
  if (current.status === 'deleted') return err(createRecordDeleted(toRecordView(current)));
  if (cmd.expectedRevision !== current.revision)
    return err(createRevisionConflict(toRecordView(current)));
  const payload = validateDocument(
    cmd.payload,
    entry.schemaVersion.schema,
    entry.definition.maxPayloadBytes
  );
  if (payload.isErr()) return err(payload.error);
  return ok(
    basePlan({
      operation: 'migrate',
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
