import { Value } from '@sinclair/typebox/value';
import { err } from 'neverthrow';

import { createNotFoundError, createValidationError } from '../errors.js';

import type {
  CampaignNotificationTriggerBulkExecutionInput,
  CampaignNotificationTriggerRegistry,
} from '../ports.js';

export const executeCampaignNotificationTriggerBulk = async (
  deps: {
    triggerRegistry: CampaignNotificationTriggerRegistry;
  },
  input: CampaignNotificationTriggerBulkExecutionInput
) => {
  const definition = deps.triggerRegistry.get(input.campaignKey, input.triggerId);
  if (definition === null) {
    return err(
      createNotFoundError(`Campaign notification trigger "${input.triggerId}" was not found.`)
    );
  }

  if (definition.executeBulk === undefined || definition.bulkInputSchema === undefined) {
    return err(
      createValidationError(
        `Campaign notification trigger "${input.triggerId}" does not support bulk execution.`
      )
    );
  }

  if (!Value.Check(definition.bulkInputSchema, input.payload)) {
    const message = [...Value.Errors(definition.bulkInputSchema, input.payload)]
      .map((error) => `${error.path}: ${error.message}`)
      .join(', ');
    return err(createValidationError(message === '' ? 'Invalid trigger payload.' : message));
  }

  return definition.executeBulk(input);
};
