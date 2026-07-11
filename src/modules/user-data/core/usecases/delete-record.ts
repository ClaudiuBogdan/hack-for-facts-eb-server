import { err, type Result } from 'neverthrow';

import { createNotFound, type UserDataError } from '../errors.js';
import {
  mapMutationOutcome,
  probeAndRateLimit,
  replayPlanningView,
  requireOwnerActor,
  type MutationActorInput,
  type MutationDeps,
} from './shared.js';
import { planDelete } from '../planners/plan-delete.js';
import { type DeleteCommand, type MutationResponse } from '../types.js';

export interface DeleteRecordInput extends MutationActorInput {
  command: DeleteCommand;
}

export const deleteRecord = async (
  deps: MutationDeps,
  input: DeleteRecordInput
): Promise<Result<MutationResponse, UserDataError>> => {
  const actor = requireOwnerActor(input);
  if (actor.isErr()) return err(actor.error);
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
  const planned = planDelete(entry.value, planningCurrent, input.command, {
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
