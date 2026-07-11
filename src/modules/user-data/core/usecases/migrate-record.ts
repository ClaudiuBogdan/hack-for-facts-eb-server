import { err, type Result } from 'neverthrow';

import { createActorNotAllowed, createNotFound, type UserDataError } from '../errors.js';
import {
  mapMutationOutcome,
  probeWithoutRateLimit,
  replayPlanningView,
  type MaintenanceMutationDeps,
  type MutationActorInput,
} from './shared.js';
import { planMigrate } from '../planners/plan-migrate.js';
import { type MigrateCommand, type MutationResponse } from '../types.js';

export interface MigrateRecordInput extends MutationActorInput {
  command: MigrateCommand;
}

export const migrateRecord = async (
  deps: MaintenanceMutationDeps,
  input: MigrateRecordInput
): Promise<Result<MutationResponse, UserDataError>> => {
  if (input.actor.type !== 'system')
    return err(createActorNotAllowed('schema-migration', input.actor.type));
  const entry = deps.registry.resolve(input.command.identity.category, input.command.schemaVersion);
  if (entry.isErr()) return err(entry.error);
  const admission = await probeWithoutRateLimit(deps.mutationPort, input.command.receipt);
  if (admission.isErr()) return err(admission.error);
  const loaded = await deps.mutationPort.getForMutation(input.command.identity);
  if (loaded.isErr()) return err(loaded.error);
  if (loaded.value === null)
    return err(createNotFound(input.command.identity.category, input.command.identity.logicalKey));
  const planningCurrent =
    admission.value === 'match'
      ? replayPlanningView(loaded.value, input.command.expectedRevision, 'active')
      : loaded.value;
  const planned = planMigrate(entry.value, planningCurrent, input.command, {
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
