import { err, type Result } from 'neverthrow';

import { createNotFound, type UserDataError } from '../errors.js';
import { planRestore } from '../planners/plan-restore.js';
import { type MutationResponse, type RestoreCommand } from '../types.js';
import {
  mapMutationOutcome,
  probeAndRateLimit,
  replayPlanningView,
  requireOwnerActor,
  type MutationActorInput,
  type MutationDeps,
} from './shared.js';

export interface RestoreRecordInput extends MutationActorInput {
  command: RestoreCommand;
}

export const restoreRecord = async (
  deps: MutationDeps,
  input: RestoreRecordInput
): Promise<Result<MutationResponse, UserDataError>> => {
  const actor = requireOwnerActor(input);
  if (actor.isErr()) return err(actor.error);
  const entry = deps.registry.resolve(input.command.identity.category, input.command.schemaVersion);
  if (entry.isErr()) return err(entry.error);
  const admission = await probeAndRateLimit(deps, {
    ownerId: input.ownerId,
    category: input.command.identity.category,
    receipt: input.command.receipt,
    limit: entry.value.definition.writeRateLimitPerMinute,
  });
  if (admission.isErr()) return err(admission.error);
  const loaded = await deps.mutationPort.getForMutation(input.command.identity);
  if (loaded.isErr()) return err(loaded.error);
  if (loaded.value === null)
    return err(createNotFound(input.command.identity.category, input.command.identity.logicalKey));
  const planningCurrent =
    admission.value === 'match'
      ? replayPlanningView(loaded.value, input.command.expectedRevision, 'deleted')
      : loaded.value;
  const planned = planRestore(entry.value, planningCurrent, input.command, {
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
