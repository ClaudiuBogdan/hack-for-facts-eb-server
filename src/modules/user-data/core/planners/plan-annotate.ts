import { err, ok, type Result } from 'neverthrow';

import {
  createActorNotAllowed,
  createInvalidPayload,
  createRecordDeleted,
  createRevisionConflict,
  createUnknownAnnotationNamespace,
  type UserDataError,
} from '../errors.js';
import { actorIsComplete, basePlan, toRecordView, validateDocument } from './shared.js';
import { type ResolvedCategory } from '../registry/types.js';
import {
  type AnnotateCommand,
  type CurrentRecord,
  type PlanContext,
  type PlannedMutation,
} from '../types.js';

export const planAnnotate = (
  entry: ResolvedCategory,
  current: CurrentRecord,
  cmd: AnnotateCommand,
  ctx: PlanContext
): Result<PlannedMutation, UserDataError> => {
  if (current.status === 'deleted') return err(createRecordDeleted(toRecordView(current)));
  if (cmd.expectedRevision !== current.revision)
    return err(createRevisionConflict(toRecordView(current)));
  const namespace = entry.definition.annotationNamespaces.find(
    (candidate) => candidate.namespace === cmd.namespace
  );
  if (namespace === undefined)
    return err(createUnknownAnnotationNamespace(entry.definition.category, cmd.namespace));
  if (ctx.actor.type === 'owner' || !namespace.allowedActorTypes.includes(ctx.actor.type))
    return err(createActorNotAllowed(cmd.namespace, ctx.actor.type));
  if (!actorIsComplete(ctx.actor)) return err(createInvalidPayload(['/actor:required']));
  const annotation = validateDocument(cmd.annotation, namespace.schema, namespace.maxBytes);
  if (annotation.isErr()) return err(annotation.error);
  const annotations = { ...(current.annotations ?? {}), [cmd.namespace]: cmd.annotation };
  return ok(
    basePlan({
      operation: 'annotate',
      scope: 'annotation',
      annotationNamespace: cmd.namespace,
      identity: cmd.identity,
      recordId: current.recordId,
      eventId: ctx.ids.newId(),
      target: current.target,
      expectedRevision: cmd.expectedRevision,
      afterImage: {
        status: 'active',
        payload: current.payload,
        annotations,
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
