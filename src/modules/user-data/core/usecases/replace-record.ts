import { err, type Result } from 'neverthrow';

import { type UserDataError } from '../errors.js';
import { planCreateOrReplace } from '../planners/plan-create-or-replace.js';
import { type MutationResponse, type ReplaceCommand } from '../types.js';
import {
  mapMutationOutcome,
  probeAndRateLimit,
  replayPlanningView,
  requireOwnerActor,
  type MutationActorInput,
  type MutationDeps,
} from './shared.js';

export interface ReplaceRecordInput extends MutationActorInput {
  command: ReplaceCommand;
}

export const replaceRecord = async (
  deps: MutationDeps,
  input: ReplaceRecordInput
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
  const replayCurrent =
    admission.value === 'match' && loaded.value !== null
      ? replayPlanningView(loaded.value, input.command.expectedRevision, 'active')
      : loaded.value;
  const planned = planCreateOrReplace(
    entry.value,
    admission.value === 'match' && input.command.expectedRevision === 0 ? null : replayCurrent,
    input.command,
    {
      ids: deps.ids,
      requesterId: input.requesterId,
      actor: input.actor,
    }
  );
  if (planned.isErr()) return err(planned.error);
  const committed = await deps.mutationPort.commit(planned.value);
  return committed.isErr()
    ? err(committed.error)
    : mapMutationOutcome(input.command.identity.category, committed.value);
};
