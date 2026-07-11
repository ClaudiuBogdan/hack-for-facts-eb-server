import { err, type Result } from 'neverthrow';

import { createActorNotAllowed, createNotFound, type UserDataError } from '../errors.js';
import {
  mapMutationOutcome,
  probeAndRateLimit,
  replayPlanningView,
  type MutationActorInput,
  type MutationDeps,
} from './shared.js';
import { planAnnotate } from '../planners/plan-annotate.js';
import { type AnnotateCommand, type MutationResponse } from '../types.js';

export interface AnnotateRecordInput extends MutationActorInput {
  command: AnnotateCommand;
}

export const annotateRecord = async (
  deps: MutationDeps,
  input: AnnotateRecordInput
): Promise<Result<MutationResponse, UserDataError>> => {
  if (input.actor.type === 'owner')
    return err(createActorNotAllowed(input.command.namespace, input.actor.type));
  const loaded = await deps.mutationPort.getForMutation(input.command.identity);
  if (loaded.isErr()) return err(loaded.error);
  if (loaded.value === null)
    return err(createNotFound(input.command.identity.category, input.command.identity.logicalKey));
  const entry = deps.registry.resolve(input.command.identity.category, loaded.value.schemaVersion);
  if (entry.isErr()) return err(entry.error);
  const admission = await probeAndRateLimit(deps, {
    ownerId: input.ownerId,
    category: input.command.identity.category,
    receipt: input.command.receipt,
    limit: entry.value.definition.writeRateLimitPerMinute,
  });
  if (admission.isErr()) return err(admission.error);
  const planningCurrent =
    admission.value === 'match'
      ? replayPlanningView(loaded.value, input.command.expectedRevision, 'active')
      : loaded.value;
  const planned = planAnnotate(entry.value, planningCurrent, input.command, {
    ids: deps.ids,
    requesterId: input.requesterId,
    actor: input.actor,
  });
  if (planned.isErr()) return err(planned.error);
  const committed = await deps.mutationPort.commit(planned.value);
  return committed.isErr()
    ? err(committed.error)
    : mapMutationOutcome(input.command.identity.category, committed.value);
};
