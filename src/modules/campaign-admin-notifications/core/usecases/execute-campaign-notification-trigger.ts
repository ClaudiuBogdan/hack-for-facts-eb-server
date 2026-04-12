import { Value } from '@sinclair/typebox/value';
import { err } from 'neverthrow';

import { createNotFoundError, createValidationError } from '../errors.js';
import {
  type CampaignNotificationTriggerRegistry,
  type CampaignNotificationTriggerExecutionInput,
} from '../ports.js';

export const executeCampaignNotificationTrigger = async (
  deps: {
    triggerRegistry: CampaignNotificationTriggerRegistry;
  },
  input: CampaignNotificationTriggerExecutionInput
) => {
  const definition = deps.triggerRegistry.get(input.campaignKey, input.triggerId);
  if (definition === null) {
    return err(
      createNotFoundError(`Campaign notification trigger "${input.triggerId}" was not found.`)
    );
  }

  if (!Value.Check(definition.inputSchema, input.payload)) {
    const message = [...Value.Errors(definition.inputSchema, input.payload)]
      .map((error) => `${error.path}: ${error.message}`)
      .join(', ');
    return err(createValidationError(message === '' ? 'Invalid trigger payload.' : message));
  }

  return definition.execute(input);
};
