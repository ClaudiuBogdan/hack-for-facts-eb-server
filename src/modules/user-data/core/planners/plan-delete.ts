import { err, ok, type Result } from 'neverthrow';

import { createRecordDeleted, createRevisionConflict, type UserDataError } from '../errors.js';
import { basePlan, toRecordView } from './shared.js';
import { type ResolvedCategory } from '../registry/types.js';
import {
  type CurrentRecord,
  type DeleteCommand,
  type PlanContext,
  type PlannedMutation,
} from '../types.js';

export const planDelete = (
  _entry: ResolvedCategory,
  current: CurrentRecord,
  cmd: DeleteCommand,
  ctx: PlanContext
): Result<PlannedMutation, UserDataError> => {
  if (current.status === 'deleted') return err(createRecordDeleted(toRecordView(current)));
  if (cmd.expectedRevision !== current.revision)
    return err(createRevisionConflict(toRecordView(current)));
  return ok(
    basePlan({
      operation: 'delete',
      scope: 'payload',
      annotationNamespace: null,
      identity: cmd.identity,
      recordId: current.recordId,
      eventId: ctx.ids.newId(),
      target: current.target,
      expectedRevision: cmd.expectedRevision,
      afterImage: {
        status: 'deleted',
        payload: null,
        annotations: null,
        schemaVersion: current.schemaVersion,
        schemaHash: current.schemaHash,
      },
      actor: ctx.actor,
      clientOccurredAt: cmd.clientOccurredAt,
      receipt: cmd.receipt,
      quota: null,
    })
  );
};
